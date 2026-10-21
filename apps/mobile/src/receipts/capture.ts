/**
 * From a camera photo to a queue item: resize and compress to a JPEG of at most 1.5 MB, save it under the
 * receipts directory with a client-minted uuid, hash the bytes (SHA-256, native), and hand the record to the
 * offline queue. The hash is what stops the same photo being uploaded twice (the queue refuses it first, the
 * API answers 200 "already held" if it ever gets through).
 */
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { receiptFile, receiptsDirectory, RECEIPTS_DIR } from "./fileStore";

export const MAX_RECEIPT_BYTES = 1_500_000;
/** Longest side after the first resize; receipts read fine at this size and it keeps most photos under 1 MB. */
const FIRST_LONGEST_SIDE = 1800;

export interface PreparedCapture {
  clientId: string;
  relativePath: string;
  fileUri: string;
  sha256: string;
  bytes: number;
  capturedAt: string;
  width: number;
  height: number;
}

export interface CaptureSource {
  uri: string;
  width?: number;
  height?: number;
}

/** Mint the queue id once; it is the `offlineId` the API echoes and the `sourceRef` on the transaction. */
export function mintClientId(): string {
  return `man:${Crypto.randomUUID()}`;
}

/**
 * Compress until the JPEG is at most `maxBytes`. Each pass halves the quality floor and then the size; a
 * receipt photo almost always fits on the first pass.
 */
export async function compressToLimit(src: CaptureSource, maxBytes = MAX_RECEIPT_BYTES): Promise<{ uri: string; width: number; height: number; bytes: number }> {
  const longest = Math.max(src.width ?? 0, src.height ?? 0);
  let side = longest > FIRST_LONGEST_SIDE || longest === 0 ? FIRST_LONGEST_SIDE : longest;
  let quality = 0.82;
  let last: { uri: string; width: number; height: number; bytes: number } | undefined;
  for (let pass = 0; pass < 6; pass += 1) {
    const actions = side > 0 ? [sizeAction(src, side)] : [];
    const out = await manipulateAsync(src.uri, actions, { compress: quality, format: SaveFormat.JPEG });
    const bytes = new File(out.uri).size;
    if (last && last.uri !== out.uri) safeDelete(last.uri);
    last = { uri: out.uri, width: out.width, height: out.height, bytes };
    if (bytes <= maxBytes) return last;
    if (quality > 0.5) quality = Math.max(0.5, quality - 0.16);
    else side = Math.round(side * 0.75);
  }
  if (!last) throw new Error("compress failed");
  return last;
}

function sizeAction(src: CaptureSource, side: number): { resize: { width?: number; height?: number } } {
  const w = src.width ?? 0;
  const h = src.height ?? 0;
  if (w && h) return w >= h ? { resize: { width: Math.min(side, w) } } : { resize: { height: Math.min(side, h) } };
  return { resize: { width: side } };
}

/** Save the compressed photo under the receipts directory and hash it. */
export async function prepareCapture(src: CaptureSource, capturedAt: Date = new Date()): Promise<PreparedCapture> {
  const clientId = mintClientId();
  const compressed = await compressToLimit(src);
  const relativePath = `${RECEIPTS_DIR}/${clientId.replace(/[^a-z0-9-]/gi, "")}.jpg`;
  const target = receiptFile(relativePath);
  receiptsDirectory();
  if (target.exists) target.delete();
  new File(compressed.uri).moveSync(target);
  const sha256 = (await target.digest("SHA-256")).toLowerCase();
  return { clientId, relativePath, fileUri: target.uri, sha256, bytes: target.size, capturedAt: capturedAt.toISOString(), width: compressed.width, height: compressed.height };
}

export function deleteReceiptFile(relativePath: string): void {
  safeDelete(receiptFile(relativePath).uri);
}

function safeDelete(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Best effort: a stray temp file in the cache directory is harmless.
  }
}
