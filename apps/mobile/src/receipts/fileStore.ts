/**
 * Where receipts live on the phone: `<document directory>/receipts/<clientId>.jpg` plus `queue.json`, the offline
 * queue index. The document directory is backed up and persists across app updates; paths in the index are
 * relative so a container path change (reinstall, new device) is harmless. iOS data protection encrypts the
 * directory at rest when the phone is locked (NSFileProtectionComplete is the Expo default for this directory).
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
