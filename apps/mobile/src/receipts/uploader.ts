/**
 * Drains the offline queue: one upload at a time, retry with backoff, pause while offline, resume when the
 * network comes back or the app returns to the foreground. The API's answers are mapped onto the queue's
 * outcomes: 201 stored or 200 already held -> ok (the server dedupes by hash too), 400/413/422 -> reject
 * (the photo itself is the problem; the person is told), anything else -> retry.
 *
 * Pure over an injected network source so it is unit-testable; the provider wires expo-network and AppState.
 */
import { ApiError, type HomesteadApi } from "../api/types";
import { receiptFileUri } from "./fileStore";
import type { QueueItem, ReceiptQueue, Uploader, UploadOutcome } from "./queue";

export interface NetworkSource {
  isOnline(): Promise<boolean>;
  /** Subscribe to connectivity changes; returns an unsubscribe. */
  onChange(listener: (online: boolean) => void): () => void;
}

export function makeUploader(api: HomesteadApi, fileUri: (relativePath: string) => string = receiptFileUri): Uploader {
  return async (item: QueueItem): Promise<UploadOutcome> => {
    try {
      const r = await api.uploadReceipt({ fileUri: fileUri(item.relativePath), sha256: item.sha256, capturedAt: item.capturedAt, offlineId: item.clientId, bytes: item.bytes });
      if (r.alreadyHeld) return { kind: "duplicate", receiptId: r.receipt.id };
      return { kind: "ok", receiptId: r.receipt.id, uploadedAt: r.receipt.uploadedAt ?? new Date().toISOString() };
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) return { kind: "duplicate" };
        if (err.status === 400 || err.status === 413 || err.status === 422) return { kind: "reject", error: err.message };
        if (err.status === 401 || err.status === 403) return { kind: "retry", error: "sign-in needed" };
        return { kind: "retry", error: err.message };
      }
      return { kind: "retry", error: err instanceof Error ? err.message : "upload failed" };
    }
  };
}

export interface SyncEvent {
  type: "state" | "synced" | "duplicate" | "error";
  item?: QueueItem;
}

export class ReceiptSync {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private online = true;
  private stopped = false;
  private unsubscribe: (() => void) | undefined;
  private readonly listeners = new Set<(e: SyncEvent) => void>();

  constructor(
    private readonly queue: ReceiptQueue,
    private readonly upload: Uploader,
    private readonly network: NetworkSource,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.online = await this.network.isOnline();
    this.unsubscribe = this.network.onChange((online) => {
      const cameBack = online && !this.online;
      this.online = online;
      this.emit({ type: "state" });
      if (cameBack) void this.resume();
    });
    await this.queue.retryNow();
    await this.kick();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  isOnline(): boolean {
    return this.online;
  }

  subscribe(listener: (e: SyncEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The network came back or the app is in the foreground again: forget the backoff and try now. */
  async resume(): Promise<void> {
    await this.queue.retryNow();
    await this.kick();
  }

  /** Try everything that is due; schedule the next attempt for whatever is still waiting. */
  async kick(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.online) {
      this.emit({ type: "state" });
      return;
    }
    const before = new Map((await this.queue.items()).map((i) => [i.clientId, i.status]));
    await this.queue.flush(this.upload);
    for (const item of await this.queue.items()) {
      const was = before.get(item.clientId);
      if (was === undefined || was === item.status) continue;
      if (item.status === "synced") this.emit({ type: "synced", item });
      else if (item.status === "duplicate") this.emit({ type: "duplicate", item });
      else if (item.status === "error") this.emit({ type: "error", item });
    }
    this.emit({ type: "state" });
    const pending = await this.queue.pending();
    if (pending.length === 0) return;
    const nextAt = Math.min(...pending.map((p) => p.nextAttemptAt));
    const wait = Math.max(250, nextAt - this.now());
    this.timer = setTimeout(() => void this.kick(), wait);
  }

  private emit(e: SyncEvent): void {
    for (const l of this.listeners) l(e);
  }
}
