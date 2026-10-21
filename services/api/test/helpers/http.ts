/** app.inject helpers: dev sign-in headers (AUTH_MODE=dev), step-up, and a multipart body builder. */
import { randomUUID } from "node:crypto";

export function as(memberId: string, stepUp = false): Record<string, string> {
  return { "x-dev-member": memberId, ...(stepUp ? { "x-step-up": "true" } : {}) };
}

export function multipart(fields: Record<string, string>, file?: { name: string; contentType: string; bytes: Uint8Array }): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----homestead${randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
    parts.push(Buffer.from(file.bytes));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
