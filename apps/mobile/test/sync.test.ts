/**
 * The upload engine over the offline queue: the API's answers mapped to queue outcomes, nothing sent while
 * offline, everything sent (once) when the network comes back. expo-file-system is replaced with a stub: the
 * engine only needs a file URI for the multipart part.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = `file:///doc/${parts.slice(1).join("/")}`;
    }
  }
  return { File, Directory: class {}, Paths: { document: "doc" } };
});

import { ApiError, type HomesteadApi, type UploadReceiptInput, type UploadReceiptResult } from "@/api/types";
import { MemoryQueueStore, ReceiptQueue } from "@/receipts/queue";
import { makeUploader, ReceiptSync, type NetworkSource } from "@/receipts/uploader";

const SHA = (c: string) => c.repeat(64);
const id = (n: number) => `man:00000000-0000-4000-8000-00000000000${n}`;
const capture = (n: number, sha: string) => ({ clientId: id(n), sha256: sha, capturedAt: "2026-10-20T15:00:00.000Z", relativePath: `receipts/${n}.jpg`, bytes: 1000 });

class FakeNetwork implements NetworkSource {
  private listener: ((online: boolean) => void) | undefined;
  constructor(public online: boolean) {}
  async isOnline() {
    return this.online;
  }
  onChange(l: (online: boolean) => void) {
    this.listener = l;
    return () => (this.listener = undefined);
  }
  set(online: boolean) {
    this.online = online;
    this.listener?.(online);
  }
}

function fakeApi(impl: (input: UploadReceiptInput) => Promise<UploadReceiptResult>): HomesteadApi {
  return { uploadReceipt: impl } as unknown as HomesteadApi;
}

const stored = (input: UploadReceiptInput, alreadyHeld = false): UploadReceiptResult => ({
  receipt: { id: `r-${input.offlineId}`, capturedAt: input.capturedAt, uploadedAt: "2026-10-20T15:00:05.000Z", sha256: input.sha256, ocrStatus: "queued", syncState: "synced", offlineId: input.offlineId },
  alreadyHeld,
});

afterEach(() => vi.useRealTimers());

describe("makeUploader", () => {
  it("sends the hash, capture time, offline id and the file URI", async () => {
    const seen: UploadReceiptInput[] = [];
    const up = makeUploader(fakeApi(async (i) => (seen.push(i), stored(i))));
    const out = await up({ ...capture(1, SHA("a")), status: "queued", attempts: 0, nextAttemptAt: 0 });
    expect(out).toEqual({ kind: "ok", receiptId: `r-${id(1)}`, uploadedAt: "2026-10-20T15:00:05.000Z" });
    expect(seen[0]).toMatchObject({ sha256: SHA("a"), capturedAt: "2026-10-20T15:00:00.000Z", offlineId: id(1), fileUri: "file:///doc/receipts/1.jpg" });
  });

  it("maps 200 already-held and 409 to duplicate, a bad photo to reject, the rest to retry", async () => {
    const item = { ...capture(1, SHA("a")), status: "queued" as const, attempts: 0, nextAttemptAt: 0 };
    expect(await makeUploader(fakeApi(async (i) => stored(i, true)))(item)).toEqual({ kind: "duplicate", receiptId: `r-${id(1)}` });
    expect((await makeUploader(fakeApi(async () => Promise.reject(new ApiError(409, "duplicate"))))(item)).kind).toBe("duplicate");
    expect((await makeUploader(fakeApi(async () => Promise.reject(new ApiError(400, "sha_mismatch"))))(item)).kind).toBe("reject");
    expect((await makeUploader(fakeApi(async () => Promise.reject(new ApiError(413, "too_large"))))(item)).kind).toBe("reject");
    expect((await makeUploader(fakeApi(async () => Promise.reject(new ApiError(503, "unavailable"))))(item)).kind).toBe("retry");
    expect((await makeUploader(fakeApi(async () => Promise.reject(new ApiError(401, "unauthorized"))))(item)).kind).toBe("retry");
    expect((await makeUploader(fakeApi(async () => Promise.reject(new TypeError("Network request failed"))))(item)).kind).toBe("retry");
  });
});

describe("ReceiptSync", () => {
  it("holds everything while offline and sends each receipt exactly once when the network returns", async () => {
    const queue = new ReceiptQueue(new MemoryQueueStore());
    const net = new FakeNetwork(false);
    const sent: string[] = [];
    const sync = new ReceiptSync(queue, makeUploader(fakeApi(async (i) => (sent.push(i.sha256), stored(i)))), net);
    const events: string[] = [];
    sync.subscribe((e) => events.push(e.type));
    await sync.start();
    await queue.enqueue(capture(1, SHA("a")));
    await queue.enqueue(capture(2, SHA("b")));
    await sync.kick();
    expect(sent).toEqual([]);
    expect((await queue.pending()).length).toBe(2);
    expect(sync.isOnline()).toBe(false);

    net.set(true);
    await vi.waitFor(async () => expect((await queue.pending()).length).toBe(0));
    expect(sent.sort()).toEqual([SHA("a"), SHA("b")]);
    expect(events.filter((e) => e === "synced").length).toBe(2);

    // A third kick (the app came back to the foreground) sends nothing again.
    await sync.resume();
    expect(sent.length).toBe(2);
    sync.stop();
  });

  it("retries a failed upload on its own after the backoff", async () => {
    vi.useFakeTimers();
    const queue = new ReceiptQueue(new MemoryQueueStore());
    let calls = 0;
    const sync = new ReceiptSync(
      queue,
      makeUploader(
        fakeApi(async (i) => {
          calls += 1;
          if (calls === 1) throw new ApiError(503, "unavailable");
          return stored(i);
        }),
      ),
      new FakeNetwork(true),
    );
    await queue.enqueue(capture(1, SHA("a")));
    await sync.start();
    expect(calls).toBe(1);
    expect((await queue.find(id(1)))?.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(calls).toBe(2);
    expect((await queue.find(id(1)))?.status).toBe("synced");
    sync.stop();
  });
});
