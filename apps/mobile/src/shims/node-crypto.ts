/**
 * A tiny `node:crypto` stand-in for React Native. `@homestead/shared` calls `createHash("sha256")` in its
 * idempotency helpers; Metro maps `node:crypto` here (see metro.config.js) so the package loads on a phone.
 * Only SHA-256 with hex/base64 output is implemented, in plain TypeScript. Receipt hashing in the app uses
 * expo-crypto's native digest instead (src/receipts/capture.ts); this shim exists so the import resolves.
 */
import { sha256Bytes } from "../lib/sha256";

type Encoding = "hex" | "base64";

class Hash {
  private readonly chunks: Uint8Array[] = [];

  constructor(private readonly algorithm: string) {
    if (algorithm.toLowerCase() !== "sha256" && algorithm.toLowerCase() !== "sha-256") {
      throw new Error(`node:crypto shim: only sha256 is implemented, not ${algorithm}`);
    }
  }

  update(data: string | Uint8Array): this {
    this.chunks.push(typeof data === "string" ? utf8(data) : data);
    return this;
  }

  digest(encoding?: Encoding): string | Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    const out = sha256Bytes(all);
    if (encoding === "hex") return toHex(out);
    if (encoding === "base64") return toBase64(out);
    return out;
  }
}

export function createHash(algorithm: string): Hash {
  return new Hash(algorithm);
}

export function randomUUID(): string {
  // RFC 4122 v4 from the platform's getRandomValues (expo-crypto installs it globally).
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = toHex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += b === undefined ? "=" : B64[(n >> 6) & 63];
    out += c === undefined ? "=" : B64[n & 63];
  }
  return out;
}

export default { createHash, randomUUID };
