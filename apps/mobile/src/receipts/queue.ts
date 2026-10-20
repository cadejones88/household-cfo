/**
 * The offline receipt queue. A captured receipt is written to the app's document directory and recorded here
 * with a client-minted uuid and the SHA-256 of its bytes; the uploader drains the queue with backoff when the
 * network allows. The same hash is never uploaded twice (the API refuses duplicates with 409; the queue
 * refuses them first). Pure logic over a small store interface so it can be unit-tested without a device.
 */
import { z } from "zod";

export const QueueItemSchema = z.object({
  /** `man:<uuid>`-style client id minted once on the phone and kept until the server acknowledges it. */
  clientId: z.string().min(8),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  capturedAt: z.string().min(10),
  /** Path of the JPEG inside the app's document directory (relative, so a reinstall path change is harmless). */
  relativePath: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  status: z.enum(["queued", "uploading", "synced", "duplicate", "error"]),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  /** Server-side receipt id once uploaded (or the existing one on a duplicate). */
  receiptId: z.string().optional(),
  uploadedAt: z.string().optional(),
});

export type QueueItem = z.infer<typeof QueueItemSchema>;

export const QueueIndexSchema = z.object({
  version: z.literal(1),
  items: z.array(QueueItemSchema),
});

export type QueueIndex = z.infer<typeof QueueIndexSchema>;

export interface QueueStore {
  load(): Promise<QueueIndex>;
  save(index: QueueIndex): Promise<void>;
}

export const EMPTY_INDEX: QueueIndex = { version: 1, items: [] };

/** Exponential backoff with jitter: 1s, 2s, 4s … capped at 5 minutes. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(5 * 60_000, 1000 * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(random() * Math.min(1000, base * 0.25));
  return base + jitter;
}

export type UploadOutcome =
  | { kind: "ok"; receiptId: string; uploadedAt: string }
  | { kind: "duplicate"; receiptId?: string }
  | { kind: "retry"; error: string }
  | { kind: "reject"; error: string };

export interface Uploader {
  (item: QueueItem): Promise<UploadOutcome>;
}

export class ReceiptQueue {
  private index: QueueIndex | undefined;
  private flushing = false;

  constructor(private readonly store: QueueStore, private readonly now: () => number = () => Date.now()) {}

  async items(): Promise<readonly QueueItem[]> {
    return (await this.read()).items;
  }

  async find(clientId: string): Promise<QueueItem | undefined> {
    return (await this.read()).items.find((i) => i.clientId === clientId);
  }

  async findBySha(sha256: string): Promise<QueueItem | undefined> {
    return (await this.read()).items.find((i) => i.sha256 === sha256 && i.status !== "error");
  }

  /** Receipts saved on the phone that the server has not acknowledged. */
  async pending(): Promise<readonly QueueItem[]> {
    return (await this.read()).items.filter((i) => i.status === "queued" || i.status === "uploading");
  }

  /**
   * Add a capture. Returns `{ added: false, existing }` when the same photo (same hash) is already queued or
   * synced, so the caller can show "you already snapped this one" instead of uploading it again.
   */
  async enqueue(input: Pick<QueueItem, "clientId" | "sha256" | "capturedAt" | "relativePath" | "bytes">): Promise<{ added: boolean; item: QueueItem }> {
    const idx = await this.read();
    const existing = idx.items.find((i) => i.sha256 === input.sha256 && i.status !== "error");
    if (existing) return { added: false, item: existing };
    const item: QueueItem = { ...input, status: "queued", attempts: 0, nextAttemptAt: this.now() };
    idx.items.unshift(item);
    await this.write(idx);
    return { added: true, item };
  }

  /** The next item due for an upload attempt, oldest first. */
  async next(at: number = this.now()): Promise<QueueItem | undefined> {
    const idx = await this.read();
    return [...idx.items].reverse().find((i) => i.status === "queued" && i.nextAttemptAt <= at);
  }

  /**
   * Try every due item once. Each outcome is recorded; retryable failures get a later `nextAttemptAt`.
   * Returns what changed so the caller can refresh the screen. Re-entrant calls return at once.
   */
  async flush(upload: Uploader): Promise<{ attempted: number; synced: number; retried: number }> {
    if (this.flushing) return { attempted: 0, synced: 0, retried: 0 };
    this.flushing = true;
    const result = { attempted: 0, synced: 0, retried: 0 };
    try {
      const seen = new Set<string>();
      for (;;) {
        const item = await this.next();
        if (!item || seen.has(item.clientId)) break;
        seen.add(item.clientId);
        result.attempted += 1;
        await this.update(item.clientId, { status: "uploading" });
        let outcome: UploadOutcome;
        try {
          outcome = await upload(item);
        } catch (err) {
          outcome = { kind: "retry", error: err instanceof Error ? err.message : "upload failed" };
        }
        switch (outcome.kind) {
          case "ok":
            await this.update(item.clientId, { status: "synced", receiptId: outcome.receiptId, uploadedAt: outcome.uploadedAt, lastError: undefined });
            result.synced += 1;
            break;
          case "duplicate":
            await this.update(item.clientId, { status: "duplicate", receiptId: outcome.receiptId, lastError: undefined });
            break;
          case "reject":
            await this.update(item.clientId, { status: "error", lastError: outcome.error });
            break;
          case "retry": {
            const attempts = item.attempts + 1;
            await this.update(item.clientId, { status: "queued", attempts, nextAttemptAt: this.now() + backoffMs(attempts), lastError: outcome.error });
            result.retried += 1;
            break;
          }
        }
      }
    } finally {
      this.flushing = false;
    }
    return result;
  }

  /** Put every retrying item back on the front burner (network came back, app came to the foreground). */
  async retryNow(): Promise<void> {
    const idx = await this.read();
    let changed = false;
    for (const i of idx.items) {
      if (i.status === "queued" && i.nextAttemptAt > this.now()) {
        i.nextAttemptAt = this.now();
        changed = true;
      } else if (i.status === "uploading") {
        // A crash mid-upload: try again; the server dedupes by hash.
        i.status = "queued";
        i.nextAttemptAt = this.now();
        changed = true;
      }
    }
    if (changed) await this.write(idx);
  }

  async remove(clientId: string): Promise<void> {
    const idx = await this.read();
    idx.items = idx.items.filter((i) => i.clientId !== clientId);
    await this.write(idx);
  }

  async update(clientId: string, patch: Partial<QueueItem>): Promise<QueueItem | undefined> {
    const idx = await this.read();
    const item = idx.items.find((i) => i.clientId === clientId);
    if (!item) return undefined;
    for (const [k, v] of Object.entries(patch) as [keyof QueueItem, QueueItem[keyof QueueItem]][]) {
      if (v === undefined) delete item[k];
      else (item as Record<string, unknown>)[k] = v;
    }
    await this.write(idx);
    return item;
  }

  private async read(): Promise<QueueIndex> {
    if (!this.index) {
      const loaded = await this.store.load();
      const parsed = QueueIndexSchema.safeParse(loaded);
      this.index = parsed.success ? parsed.data : { version: 1, items: [] };
    }
    return this.index;
  }

  private async write(idx: QueueIndex): Promise<void> {
    this.index = idx;
    await this.store.save(idx);
  }
}

/** An in-memory store for tests and for the mock. */
export class MemoryQueueStore implements QueueStore {
  constructor(private index: QueueIndex = { version: 1, items: [] }) {}
  async load(): Promise<QueueIndex> {
    return JSON.parse(JSON.stringify(this.index)) as QueueIndex;
  }
  async save(index: QueueIndex): Promise<void> {
    this.index = JSON.parse(JSON.stringify(index)) as QueueIndex;
  }
  snapshot(): QueueIndex {
    return this.index;
  }
}
