/**
 * Where receipts live on the phone: `<document directory>/receipts/<clientId>.jpg` plus `queue.json`, the offline
 * queue index. The document directory persists across app updates; paths in the index are relative so a container
 * path change (reinstall, restore) is harmless.
 *
 * "The device's encrypted store" (Phase 3 spec, Receipts step 1): on iPhone, iOS Data Protection encrypts these
 * files with a key tied to the passcode. app.json sets the default-data-protection entitlement to
 * NSFileProtectionCompleteUnlessOpen: a file that is not open cannot be read while the phone is locked (iOS's own
 * default would leave every file readable from the first unlock after a restart), yet a write that is under way
 * when the phone locks still finishes. The app reads receipts only in the foreground; an upload interrupted by
 * locking the phone simply retries. On Android, app-private storage is covered by
 * file-based encryption. Synced photos are pruned after 30 days (ReceiptQueueProvider); the server keeps the
 * encrypted original.
 */
import { Directory, File, Paths } from "expo-file-system";
import { QueueIndexSchema, type QueueIndex, type QueueStore } from "./queue";

export const RECEIPTS_DIR = "receipts";
const INDEX_FILE = "queue.json";

export function receiptsDirectory(): Directory {
  const dir = new Directory(Paths.document, RECEIPTS_DIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** The file:// URI for a queue item's relative path. */
export function receiptFileUri(relativePath: string): string {
  return new File(Paths.document, relativePath).uri;
}

export function receiptFile(relativePath: string): File {
  return new File(Paths.document, relativePath);
}

export class FileQueueStore implements QueueStore {
  private file(): File {
    return new File(receiptsDirectory(), INDEX_FILE);
  }

  async load(): Promise<QueueIndex> {
    const f = this.file();
    if (!f.exists) return { version: 1, items: [] };
    try {
      const parsed = QueueIndexSchema.safeParse(JSON.parse(await f.text()));
      return parsed.success ? parsed.data : { version: 1, items: [] };
    } catch {
      return { version: 1, items: [] };
    }
  }

  async save(index: QueueIndex): Promise<void> {
    const f = this.file();
    // Write beside, then move over: a crash mid-write never leaves a half index.
    const tmp = new File(receiptsDirectory(), `${INDEX_FILE}.tmp`);
    await tmp.write(JSON.stringify(index));
    if (f.exists) f.delete();
    tmp.moveSync(f);
  }
}
