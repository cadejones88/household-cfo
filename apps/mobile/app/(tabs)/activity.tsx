/**
 * Activity: search, the prototype's four filters (All / Needs answer / With receipt / Mine), the plain status
 * words, and receipts still on the phone at the top. Transfers, card payments and loan principal never read as
 * spending. "Mine" is the FAMILY_AREA dimension (CADE, VANESSA) matching the signed-in member's first name.
 */
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/auth/AuthProvider";
import { useAlerts, useTransactions } from "@/api/hooks";
import { todayIso } from "@/model/format";
import { familyAreaOf } from "@/model/people";
import { useReceiptQueue } from "@/receipts/ReceiptQueueProvider";
import { Screen } from "@/ui/Screen";
import { QueuedReceiptRow, TxRow } from "@/ui/TxRow";
import { Chip, Chips, Field, H1, List, Stamp, Sub } from "@/ui/primitives";
import { fmtStampDate } from "@/model/format";

type Filter = "all" | "q" | "rc" | "me";

export default function Activity(): React.JSX.Element {
  const router = useRouter();
  const auth = useAuth();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const query = useMemo(() => ({ ...(q.trim() ? { q: q.trim() } : {}), ...(filter === "q" ? { status: "needs_answer" as const } : {}), limit: 100 }), [q, filter]);
  const txs = useTransactions(query);
  const alerts = useAlerts();
  const queue = useReceiptQueue();
  const today = todayIso();
  const myArea = familyAreaOf(auth.member?.displayName);
  const list = (txs.data?.transactions ?? []).filter((t) => (filter !== "rc" || t.receiptStatus === "matched") && (filter !== "me" || t.dims.FAMILY_AREA === myArea));
  // Receipts on this phone are always this member's.
  const queued = filter === "q" ? [] : queue.items.filter((i) => i.status !== "synced" && i.status !== "duplicate");
  const unread = (alerts.data ?? []).filter((a) => !a.resolvedAt).length;
  const stamp = txs.data ? `Bank data through ${fmtStampDate(txs.data.dataThrough.at)}${txs.data.dataThrough.pendingCount ? ` · ${txs.data.dataThrough.pendingCount} items still being recorded` : ""}.` : "";

  return (
    <Screen initial={(auth.member?.displayName ?? "V").charAt(0)} badge={unread} refreshing={txs.isFetching} onRefresh={() => void txs.refetch()} testID="activity">
      <H1>Activity</H1>
      <Field placeholder="Search Walmart, gas, kids…" value={q} onChangeText={setQ} returnKeyType="search" clearButtonMode="while-editing" accessibilityLabel="Search activity" testID="activity-search" />
      <Chips>
        {(
          [
            ["all", "All"],
            ["q", "Needs answer"],
            ["rc", "With receipt"],
            ["me", "Mine"],
          ] as const
        ).map(([k, label]) => (
          <Chip key={k} label={label} on={filter === k} onPress={() => setFilter(k)} testID={`filter-${k}`} />
        ))}
      </Chips>
      <List>
        {queued.map((item, i) => (
          <QueuedReceiptRow key={item.clientId} item={item} first={i === 0} onPress={() => router.push({ pathname: "/receipt/[clientId]", params: { clientId: item.clientId } })} />
        ))}
        {list.map((t, i) => (
          <TxRow key={t.id} tx={t} today={today} first={i === 0 && queued.length === 0} onPress={() => router.push({ pathname: "/transaction/[id]", params: { id: t.id } })} />
        ))}
        {list.length === 0 && queued.length === 0 && (
          <View style={{ padding: 14, minHeight: 60, justifyContent: "center" }}>
            <Sub>{txs.isLoading ? "Loading…" : txs.isError ? "Can't reach the list right now." : "Nothing matches."}</Sub>
          </View>
        )}
      </List>
      <Stamp>{stamp} Transfers, card payments and loan principal never count as spending.</Stamp>
    </Screen>
  );
}
