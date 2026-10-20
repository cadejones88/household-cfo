import { describe, expect, it } from "vitest";
import { redactString, scrub } from "../src/lib/logScrub.js";

describe("log scrubbing", () => {
  it("drops amounts, masks, tokens and SAS signatures from strings", () => {
    expect(redactString("charge $1,234.56 on x6450 Bearer abc.def-ghi")).toBe("charge [amount] on [mask] Bearer [redacted]");
    expect(redactString("https://blob/receipts/a.jpg?sv=2024&sig=abc123&se=now")).toBe("https://blob/receipts/a.jpg&sv=[redacted]&sig=[redacted]&se=[redacted]");
  });
  it("redacts sensitive keys in objects and keeps the idempotency key", () => {
    const out = scrub({ idempotencyKey: "plaid:a:1", amountCents: 1250, merchant: "Maverik", nested: { access_token: "x", ok: "yes" } });
    expect(out).toEqual({ idempotencyKey: "plaid:a:1", amountCents: "[redacted]", merchant: "[redacted]", nested: { access_token: "[redacted]", ok: "yes" } });
  });
});
