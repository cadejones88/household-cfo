/**
 * The public receivers without a database: BC's handshake echo (GET and POST), 202 for notifications (never 4xx for
 * our own errors), Plaid's signature gate, and 401 for a signed-out member on every other route.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { buildFakeDeps } from "../src/deps.js";
import { FakeWebhookVerifier } from "../src/routes/webhooks.js";

describe("webhook receivers and sign-in gate", () => {
  let app: FastifyInstance;
  const verifier = new FakeWebhookVerifier();
  beforeAll(async () => {
    app = await buildApp({ logger: false, deps: buildFakeDeps({ plaidWebhookVerifier: verifier }) });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("echoes BC's validationToken as text/plain with 200 on GET and POST", async () => {
    for (const method of ["GET", "POST"] as const) {
      const r = await app.inject({ method, url: "/v1/webhooks/bc?validationToken=abc%20123" });
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toMatch(/text\/plain/);
      expect(r.body).toBe("abc 123");
    }
  });

  it("answers BC notifications with 202 at once, even when the body is not what it expects", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/webhooks/bc", payload: { value: [] } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ accepted: 0, rejected: 0 });
    const odd = await app.inject({ method: "POST", url: "/v1/webhooks/bc", payload: { something: "else" } });
    expect(odd.statusCode).toBe(202);
  });

  it("refuses a Plaid webhook without a verified signature, and acknowledges one with no item", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/webhooks/plaid", payload: { webhook_type: "TRANSACTIONS" } });
    expect(r.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/v1/webhooks/plaid", headers: { "plaid-verification": "jwt" }, payload: { webhook_type: "TRANSACTIONS" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ handled: "ignored" });
    verifier.accept = false;
    expect((await app.inject({ method: "POST", url: "/v1/webhooks/plaid", headers: { "plaid-verification": "jwt" }, payload: {} })).statusCode).toBe(401);
    verifier.accept = true;
  });

  it("answers 401 not_signed_in on member routes without a sign-in", async () => {
    for (const url of ["/v1/me", "/v1/transactions", "/v1/console/queues"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: "not_signed_in" });
    }
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});
