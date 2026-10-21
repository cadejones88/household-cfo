/** The queue ports: the in-memory queue and the Service Bus REST client (send, peek-lock, complete by lock URL). */
import { describe, expect, it } from "vitest";
import { InMemoryQueue, ServiceBusQueue } from "../src/services/ports.js";

describe("ServiceBusQueue", () => {
  it("sends with a bearer token, peek-locks from the subscription, and completes by the lock's Location", async () => {
    const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
    let served = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, headers: (init?.headers ?? {}) as Record<string, string>, ...(init?.body ? { body: String(init.body) } : {}) });
      if (url.endsWith("/homestead-outbox/messages")) return new Response(null, { status: 201 });
      if (url.includes("/messages/head")) {
        served += 1;
        if (served > 1) return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ outboxId: "o1", householdId: "h1", operation: "send_to_bc" }), { status: 201, headers: { BrokerProperties: JSON.stringify({ MessageId: "m1", LockToken: "l1", EnqueuedTimeUtc: "Tue, 20 Oct 2026 18:00:00 GMT" }), Location: "https://homestead-dev-sb.servicebus.windows.net/homestead-outbox/subscriptions/bc-worker/messages/m1/l1" } });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    const q = new ServiceBusQueue("homestead-dev-sb", "bc-worker", async () => "sb-token", fetchImpl);
    await q.publish("homestead-outbox", { outboxId: "o1", householdId: "h1", operation: "send_to_bc", target: "bc-worker" });
    // MessageId = the outbox row id (duplicate detection); `target` is the property the subscription filters read.
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://homestead-dev-sb.servicebus.windows.net/homestead-outbox/messages", headers: { authorization: "Bearer sb-token", BrokerProperties: JSON.stringify({ MessageId: "o1" }), target: "bc-worker" } });
    const got = await q.receive("homestead-outbox", 10);
    expect(got).toEqual([{ id: "m1", topic: "homestead-outbox", body: { outboxId: "o1", householdId: "h1", operation: "send_to_bc" }, enqueuedAt: "2026-10-20T18:00:00.000Z", lockLocation: "https://homestead-dev-sb.servicebus.windows.net/homestead-outbox/subscriptions/bc-worker/messages/m1/l1" }]);
    expect(calls[1]!.url).toBe("https://homestead-dev-sb.servicebus.windows.net/homestead-outbox/subscriptions/bc-worker/messages/head?timeout=1");
    await q.complete(got[0]!);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: got[0]!.lockLocation });
  });

  it("treats an expired lock on complete as done (the message comes back and finds its rows handled)", async () => {
    const fetchImpl = (async () => new Response(null, { status: 410 })) as unknown as typeof fetch;
    const q = new ServiceBusQueue("homestead-dev-sb", "ocr", async () => "sb-token", fetchImpl);
    await expect(q.complete({ id: "m", topic: "homestead-outbox", body: {}, enqueuedAt: "", lockLocation: "https://x.servicebus.windows.net/l" })).resolves.toBeUndefined();
  });
});

describe("InMemoryQueue", () => {
  it("keeps messages until completed and records dead letters", async () => {
    const q = new InMemoryQueue();
    await q.publish("t", { a: 1 });
    const [m] = await q.receive("t", 5);
    expect(q.depth("t")).toBe(1);
    await q.complete(m!);
    expect(q.depth("t")).toBe(0);
    await q.publish("t", { b: 2 });
    await q.deadLetter((await q.receive("t", 1))[0]!, "BadRequest");
    expect(q.deadLetters).toHaveLength(1);
    expect(q.depth("t")).toBe(0);
  });
});
