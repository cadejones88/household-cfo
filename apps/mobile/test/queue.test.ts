import { describe, expect, it } from "vitest";
import { backoffMs, MemoryQueueStore, ReceiptQueue, type QueueItem, type UploadOutcome } from "@/receipts/queue";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
/** Client ids as the phone mints them (`man:<uuid>`); the index schema refuses anything shorter on reload. */
const ID1 = "man:0b8f3c2e-1d4a-4c55-9e1f-5a6b7c8d9e01";
const ID2 = "man:0b8f3c2e-1d4a-4c55-9e1f-5a6b7c8d9e02";
const ID3 = "man:0b8f3c2e-1d4a-4c55-9e1f-5a6b7c8d9e03";

function capture(clientId: string, sha256: string) {
  return { clientId, sha256, capturedAt: "2026-10-20T15:00:00.000Z", relativePath: `receipts/${clientId.slice(4)}.jpg`, bytes: 12345 };
}

describe("ReceiptQueue", () => {
  it("enqueues a capture and refuses the same hash a second time", async () => {
    const q = new ReceiptQueue(new MemoryQueueStore());
    const first = await q.enqueue(capture(ID1, SHA_A));
    expect(first.added).toBe(true);
    expect(first.item.status).toBe("queued");
    const again = await q.enqueue(capture(ID2, SHA_A));
    expect(again.added).toBe(false);
    expect(again.item.clientId).toBe(ID1);
    expect((await q.items()).length).toBe(1);
  });

  it("flushes due items oldest first, records the receipt id, and never uploads a synced hash again", async () => {
    let now = 1_000;
    const q = new ReceiptQueue(new MemoryQueueStore(), () => now);
    await q.enqueue(capture(ID1, SHA_A));
    now += 10;
    await q.enqueue(capture(ID2, SHA_B));
    const uploaded: string[] = [];
    const uploader = async (item: QueueItem): Promise<UploadOutcome> => {
      uploaded.push(item.clientId);
      return { kind: "ok", receiptId: `r-${item.clientId}`, uploadedAt: "2026-10-20T15:01:00.000Z" };
    };
    const r = await q.flush(uploader);
    expect(r).toEqual({ attempted: 2, synced: 2, retried: 0 });
    expect(uploaded).toEqual([ID1, ID2]);
    const items = await q.items();
    expect(items.every((i) => i.status === "synced")).toBe(true);
    expect(items.find((i) => i.clientId === ID1)?.receiptId).toBe(`r-${ID1}`);
    // A second flush has nothing to do; a re-capture of the same photo is refused before any upload.
    expect(await q.flush(uploader)).toEqual({ attempted: 0, synced: 0, retried: 0 });
    expect((await q.enqueue(capture(ID3, SHA_A))).added).toBe(false);
    expect(uploaded.length).toBe(2);
  });

  it("retries with backoff and marks rejects as errors", async () => {
    let now = 1_000;
    const q = new ReceiptQueue(new MemoryQueueStore(), () => now);
    await q.enqueue(capture(ID1, SHA_A));
    await q.enqueue(capture(ID2, SHA_B));
    let calls = 0;
    const uploader = async (item: QueueItem): Promise<UploadOutcome> => {
      calls += 1;
      if (item.clientId === ID1) return { kind: "retry", error: "network" };
      return { kind: "reject", error: "not an image" };
    };
    const r = await q.flush(uploader);
    expect(r).toEqual({ attempted: 2, synced: 0, retried: 1 });
    const one = await q.find(ID1);
    expect(one?.status).toBe("queued");
    expect(one?.attempts).toBe(1);
    expect(one?.nextAttemptAt).toBeGreaterThan(now);
    expect((await q.find(ID2))?.status).toBe("error");
    // Not due yet: nothing is attempted.
    expect(await q.flush(uploader)).toEqual({ attempted: 0, synced: 0, retried: 0 });
    expect(calls).toBe(2);
    // Time passes: the retry fires again, and only for the retryable item.
    now += 10_000;
    const r2 = await q.flush(uploader);
    expect(r2.attempted).toBe(1);
    expect((await q.find(ID1))?.attempts).toBe(2);
    // retryNow brings a backed-off item forward.
    await q.retryNow();
    expect((await q.find(ID1))?.nextAttemptAt).toBeLessThanOrEqual(now);
  });

  it("treats a server duplicate as done, keeping the existing receipt id", async () => {
    const q = new ReceiptQueue(new MemoryQueueStore());
    await q.enqueue(capture(ID1, SHA_A));
    await q.flush(async () => ({ kind: "duplicate", receiptId: "r-existing" }));
    const item = await q.find(ID1);
    expect(item?.status).toBe("duplicate");
    expect(item?.receiptId).toBe("r-existing");
    expect((await q.pending()).length).toBe(0);
  });

  it("puts an item stuck in uploading (crash mid-upload) back in the queue", async () => {
    const store = new MemoryQueueStore({ version: 1, items: [{ ...capture(ID1, SHA_A), status: "uploading", attempts: 0, nextAttemptAt: 0 }] });
    const q = new ReceiptQueue(store, () => 5_000);
    await q.retryNow();
    const item = await q.find(ID1);
    expect(item?.status).toBe("queued");
    expect(item?.nextAttemptAt).toBe(5_000);
  });

  it("survives a corrupt index by starting empty", async () => {
    const store = { load: async () => ({ nonsense: true }) as never, save: async () => undefined };
    const q = new ReceiptQueue(store);
    expect(await q.items()).toEqual([]);
  });

  it("keeps a re-snap of a photo that failed to read (error items do not block a new capture)", async () => {
    const q = new ReceiptQueue(new MemoryQueueStore());
    await q.enqueue(capture(ID1, SHA_A));
    await q.flush(async () => ({ kind: "reject", error: "not an image" }));
    const again = await q.enqueue(capture(ID2, SHA_A));
    expect(again.added).toBe(true);
    expect((await q.pending()).map((i) => i.clientId)).toEqual([ID2]);
  });

  it("survives a restart: the index is re-read from the store and still refuses the synced hash", async () => {
    const store = new MemoryQueueStore();
    const first = new ReceiptQueue(store);
    await first.enqueue(capture(ID1, SHA_A));
    await first.flush(async () => ({ kind: "ok", receiptId: "r1", uploadedAt: "2026-10-20T15:01:00.000Z" }));
    const afterRestart = new ReceiptQueue(store);
    expect((await afterRestart.find(ID1))?.status).toBe("synced");
    expect((await afterRestart.enqueue(capture(ID2, SHA_A))).added).toBe(false);
  });

  it("prunes old synced receipts but never one still waiting to upload", async () => {
    const day = 86_400_000;
    const now = Date.parse("2026-10-20T15:00:00.000Z");
    const q = new ReceiptQueue(new MemoryQueueStore(), () => now);
    await q.enqueue({ ...capture(ID1, SHA_A), capturedAt: new Date(now - 40 * day).toISOString() });
    await q.enqueue({ ...capture(ID2, SHA_B), capturedAt: new Date(now - 40 * day).toISOString() });
    await q.enqueue({ ...capture(ID3, "c".repeat(64)), capturedAt: new Date(now - 2 * day).toISOString() });
    await q.flush(async (item) => (item.clientId === ID2 ? { kind: "retry", error: "offline" } : { kind: "ok", receiptId: `r-${item.clientId}`, uploadedAt: new Date(now).toISOString() }));
    const pruned = await q.pruneSynced(30 * day);
    expect(pruned.map((i) => i.clientId)).toEqual([ID1]);
    expect((await q.items()).map((i) => i.clientId).sort()).toEqual([ID2, ID3].sort());
  });

  it("backs off exponentially with a cap", () => {
    const noJitter = () => 0;
    expect(backoffMs(1, noJitter)).toBe(1000);
    expect(backoffMs(2, noJitter)).toBe(2000);
    expect(backoffMs(4, noJitter)).toBe(8000);
    expect(backoffMs(20, noJitter)).toBe(5 * 60_000);
    expect(backoffMs(3, () => 0.999)).toBeLessThan(4000 + 1000);
  });
});
