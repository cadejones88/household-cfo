/**
 * The words on the sync bar above every screen while anything waits to sync (Phase 1 screen list).
 */
export function syncBarText(online: boolean, pendingCount: number): string | undefined {
  if (!online) {
    return pendingCount
      ? `You're offline. ${pendingCount} receipt${pendingCount > 1 ? "s" : ""} saved on your phone — not synced yet.`
      : "You're offline. Receipts you snap will be saved on your phone and sent when you're back online.";
  }
  if (pendingCount) return `Uploading ${pendingCount} receipt${pendingCount > 1 ? "s" : ""}…`;
  return undefined;
}

/** The status line for a receipt that is still on the phone or just uploaded. */
export function queuedReceiptWords(status: "queued" | "uploading" | "synced" | "duplicate" | "error"): string {
  if (status === "synced" || status === "duplicate") return "Reading your receipt…";
  if (status === "error") return "Couldn't be read — tap for details";
  return "Not synced yet";
}
