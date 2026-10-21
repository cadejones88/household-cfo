/**
 * An activity row as the prototype draws it: glyph, merchant, "Category · Status", amount and a relative date.
 * Queue items that have not synced show as rows too ("Not synced yet"), so a snapped receipt appears at once.
 */
import type { Transaction } from "@homestead/shared";
import type { QueueItem } from "../receipts/queue";
import { categoryName } from "../model/categories";
import { money, relDate } from "../model/format";
import { rowIcon, statusLine } from "../model/status";
import { ListItem } from "./primitives";

export function TxRow({ tx, today, first, onPress }: { tx: Transaction; today: string; first?: boolean; onPress: () => void }): React.JSX.Element {
  const { glyph, tone } = rowIcon(tx);
  const cat = categoryName(tx.categoryId);
  const line = statusLine(tx, { fixPending: tx.exceptionReason === "fix_pending", categoryName: cat });
  const subtitle = tx.kind === "transfer" || tx.kind === "paycheck" || tx.kind === "loan_payment" || tx.kind === "bc_native" ? line : `${cat} · ${line}`;
  return (
    <ListItem
      first={first}
      glyph={glyph}
      tone={tone}
      title={tx.merchantNorm || tx.merchantRaw}
      subtitle={subtitle}
      amount={money(tx.amountCents, "always")}
      amountIn={tx.amountCents > 0}
      amountSub={relDate(tx.postedDate, today)}
      onPress={onPress}
      testID={`tx-${tx.id}`}
    />
  );
}

/** A receipt still on the phone (or just uploaded and being read). */
export function QueuedReceiptRow({ item, first, onPress }: { item: QueueItem; first?: boolean; onPress: () => void }): React.JSX.Element {
  const status = item.status === "synced" || item.status === "duplicate" ? "Reading your receipt…" : item.status === "error" ? "Couldn't be read — tap for details" : "Not synced yet";
  return <ListItem first={first} glyph="▣" tone="rc" title="Receipt you snapped" subtitle={status} amountSub="Today" onPress={onPress} testID={`queued-${item.clientId}`} />;
}
