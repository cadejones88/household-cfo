// @vitest-environment node
/**
 * The browser shim for `node:crypto` must hash exactly like Node, because @homestead/shared derives idempotency
 * keys and External Document Nos. from SHA-256 and the Console shows them next to BC's.
 */
import { createHash as nodeCreateHash } from "crypto";
import { describe, expect, it } from "vitest";
import { createHash as shimCreateHash, sha256 } from "../src/shims/node-crypto";

const nodeHex = (s: string) => nodeCreateHash("sha256").update(s).digest("hex");

describe("node:crypto shim", () => {
  it("matches Node for the FIPS 180-4 vectors", () => {
    expect(shimCreateHash("sha256").update("").digest("hex")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(shimCreateHash("sha256").update("abc").digest("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("matches Node across block boundaries and multi-byte input", () => {
    const samples = ["a", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(65), "y".repeat(1000), "plaid:item_1:txn_9|2026-10-18|-4523|Broulim's ☕", "HHAPP-0f6b1d4a"];
    for (const s of samples) expect(shimCreateHash("sha256").update(s).digest("hex")).toBe(nodeHex(s));
  });

  it("supports chunked updates and raw bytes", () => {
    const chunked = shimCreateHash("sha256").update("hello ").update(new TextEncoder().encode("world")).digest("hex");
    expect(chunked).toBe(nodeHex("hello world"));
    expect(Array.from(sha256(new Uint8Array([0, 255, 1]))).length).toBe(32);
  });

  it("refuses what it does not implement, loudly", () => {
    expect(() => shimCreateHash("md5")).toThrow(/sha256 only/);
    expect(() => shimCreateHash("sha256").update("a").digest()).toThrow(/hex only/);
  });
});
