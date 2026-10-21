/**
 * The receipt queue for the screens: snap a photo (save + hash + enqueue + upload), see what is still on the
 * phone, know whether the phone is online, and find the server receipt id for a queue item once it synced.
 * The sync engine runs while the app is open; it resumes on foreground and when the network returns.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { AppState } from "react-native";
import * as Network from "expo-network";
import { useApi } from "../api/ApiProvider";
import { useInvalidateAfterReceipt } from "../api/hooks";
import { deleteReceiptFile, prepareCapture, type CaptureSource } from "./capture";
import { FileQueueStore } from "./fileStore";
import { ReceiptQueue, type QueueItem, type QueueStore } from "./queue";
import { makeUploader, ReceiptSync, type NetworkSource } from "./uploader";

export interface SnapResult {
  item: QueueItem;
  /** False when the same photo was already snapped: the existing item is returned. */
  added: boolean;
}

export interface ReceiptQueueApi {
  online: boolean;
  items: readonly QueueItem[];
  /** Saved on the phone, not yet acknowledged by the server. */
  pending: readonly QueueItem[];
  snap(src: CaptureSource): Promise<SnapResult>;
  item(clientId: string): QueueItem | undefined;
  retryNow(): Promise<void>;
  remove(clientId: string): Promise<void>;
}

const Ctx = createContext<ReceiptQueueApi | undefined>(undefined);

/** Synced receipt photos stay on the phone this long for the thumbnail, then only the server copy remains. */
const KEEP_SYNCED_MS = 30 * 24 * 60 * 60 * 1000;

const expoNetwork: NetworkSource = {
  async isOnline() {
    try {
      const s = await Network.getNetworkStateAsync();
      return s.isConnected !== false && s.isInternetReachable !== false;
    } catch {
      return true;
    }
  },
  onChange(listener) {
    const sub = Network.addNetworkStateListener((s) => listener(s.isConnected !== false && s.isInternetReachable !== false));
    return () => sub.remove();
  },
};

export function ReceiptQueueProvider({ children, store, network }: PropsWithChildren<{ store?: QueueStore; network?: NetworkSource }>): React.JSX.Element {
  const api = useApi();
  const invalidate = useInvalidateAfterReceipt();
  const queue = useMemo(() => new ReceiptQueue(store ?? new FileQueueStore()), [store]);
  const [items, setItems] = useState<readonly QueueItem[]>([]);
  const [online, setOnline] = useState(true);
  const sync = useRef<ReceiptSync | undefined>(undefined);

  const refresh = useCallback(async () => {
    setItems([...(await queue.items())]);
  }, [queue]);

  useEffect(() => {
    const engine = new ReceiptSync(queue, makeUploader(api), network ?? expoNetwork);
    sync.current = engine;
    const unsub = engine.subscribe((e) => {
      setOnline(engine.isOnline());
      void refresh();
      if (e.type === "synced" || e.type === "duplicate") void invalidate();
    });
    void queue
      .pruneSynced(KEEP_SYNCED_MS)
      .then((old) => old.forEach((i) => deleteReceiptFile(i.relativePath)))
      .catch(() => undefined)
      .then(() => engine.start())
      .then(() => {
        setOnline(engine.isOnline());
        void refresh();
      });
    const app = AppState.addEventListener("change", (s) => {
      if (s === "active") void engine.resume();
    });
    return () => {
      app.remove();
      unsub();
      engine.stop();
      sync.current = undefined;
    };
    // `invalidate` is a stable closure over the query client; `refresh` depends only on the queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, api, network]);

  const snap = useCallback(
    async (src: CaptureSource): Promise<SnapResult> => {
      const prepared = await prepareCapture(src);
      const r = await queue.enqueue({ clientId: prepared.clientId, sha256: prepared.sha256, capturedAt: prepared.capturedAt, relativePath: prepared.relativePath, bytes: prepared.bytes });
      // The same photo again: keep the first copy, drop the one just written, and never upload it twice.
      if (!r.added) deleteReceiptFile(prepared.relativePath);
      await refresh();
      if (r.added) void sync.current?.kick();
      return r;
    },
    [queue, refresh],
  );

  const value = useMemo<ReceiptQueueApi>(
    () => ({
      online,
      items,
      pending: items.filter((i) => i.status === "queued" || i.status === "uploading"),
      snap,
      item: (clientId) => items.find((i) => i.clientId === clientId),
      retryNow: async () => {
        await sync.current?.resume();
        await refresh();
      },
      remove: async (clientId) => {
        const gone = await queue.find(clientId);
        await queue.remove(clientId);
        if (gone) deleteReceiptFile(gone.relativePath);
        await refresh();
      },
    }),
    [online, items, snap, queue, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReceiptQueue(): ReceiptQueueApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useReceiptQueue must be used inside ReceiptQueueProvider");
  return v;
}
