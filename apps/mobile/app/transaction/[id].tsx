/**
 * Item detail (H6): amount and the plain status, the receipt photo or the split from it, the paycheck
 * breakdown, "This isn't spending" for transfers, and the two actions: This is wrong, Mark as business.
 * After a correction on a posted item: "Fix pending — Cade will fix it in the books."
 */
import { Image, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAccounts, usePaycheckForTransaction, useReceipt, useTransaction } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { categoryName } from "@/model/categories";
import { money, relDate, todayIso } from "@/model/format";
import { statusKeyOf, statusLine } from "@/model/status";
import { bookkeeperName, booksFixWords } from "@/model/people";
import { receiptFileUri } from "@/receipts/fileStore";
import { useReceiptQueue } from "@/receipts/ReceiptQueueProvider";
import { useTheme } from "@/ui/ThemeProvider";
import { SheetScreen } from "@/ui/Screen";
import { Banner, Big, Button, ButtonRow, Card, Eyebrow, H2, KV, Note, Pill, Sub } from "@/ui/primitives";

export default function TransactionDetail(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { p } = useTheme();
  const auth = useAuth();
  const tx = useTransaction(id);
  const queue = useReceiptQueue();
  const t = tx.data;
  const receipt = useReceipt(t?.receiptId);
  const paycheck = usePaycheckForTransaction(t?.kind === "paycheck" ? t.id : undefined);
  const accounts = useAccounts();
  const today = todayIso();
  const fixPending = t?.exceptionReason === "fix_pending";

  if (!t) {
    return (
      <SheetScreen title={tx.isLoading ? "Loading…" : "Not found"} eyebrow="Activity">
        <Sub>{tx.isLoading ? "One moment." : "That item isn't here any more."}</Sub>
      </SheetScreen>
    );
  }

  const inflow = t.amountCents > 0;
  const cat = categoryName(t.categoryId);
  const line = statusLine(t, { fixPending, categoryName: cat });
  const statusWord = line.split(" · ").pop() ?? "";
  const pillKey = fixPending ? "neutral" : t.status === "needs_answer" ? "watch" : t.kind === "transfer" || t.kind === "paycheck" || t.kind === "loan_payment" || t.kind === "bc_native" ? "good" : statusKeyOf(t.status);
  const localPhoto = queue.items.find((i) => i.receiptId && i.receiptId === t.receiptId);
  const photoUri = localPhoto ? receiptFileUri(localPhoto.relativePath) : undefined;
  const splits = t.splits.length > 1 ? t.splits : (receipt.data?.split?.lines.length ?? 0) > 1 ? (receipt.data?.split?.lines ?? []) : [];
  const account = accounts.data?.accounts.find((a) => a.id === t.accountId)?.displayName ?? "Account";

  return (
    <SheetScreen title={t.merchantNorm || t.merchantRaw} eyebrow={`${relDate(t.postedDate, today)} · ${account}`} testID="transaction-detail">
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Big style={{ fontSize: 34, color: inflow ? p.good : p.ink }}>{money(t.amountCents, "always")}</Big>
        <Pill status={pillKey} label={statusWord} />
      </View>
      <Sub>
        {cat}
        {t.businessFlag !== "none" ? ` · Business (${t.businessFlag === "ctj" ? "CTJ" : "Lash"})` : ""}
        {fixPending ? ` · Fix pending — ${booksFixWords(auth.member?.displayName)}` : ""}
      </Sub>

      {t.kind === "paycheck" && paycheck.data && (
        <>
          <Card style={{ gap: 0 }}>
            <Eyebrow style={{ paddingBottom: 6 }}>What's in this paycheck</Eyebrow>
            {paycheck.data.components.map((c, i) => (
              <KV key={`${c.kind}-${i}`} first={i === 0} label={c.label} value={money(c.kind === "regular" || c.kind === "bonus" || c.kind === "overtime" ? c.amountCents : -c.amountCents)} />
            ))}
            <KV label={<Text style={{ fontWeight: "600" }}>Take-home</Text>} value={money(paycheck.data.netCents)} bold />
          </Card>
          <Note>Each line is recorded in the books on its own, so the year ties to the W-2 and tithing can be figured either way.</Note>
          {paycheck.data.estimated && <Banner>Estimated from the usual paycheck until the pay stub is read.</Banner>}
        </>
      )}

      {t.kind === "transfer" && (
        <Card>
          <H2>This isn't spending</H2>
          <Sub>Money moved between our own accounts or paid onto a card. It never counts against a category.</Sub>
        </Card>
      )}

      {(t.kind === "loan_payment" || t.kind === "bc_native") && (
        <Card>
          <H2>{t.categoryId === "mortgage" ? "Mortgage payment" : "Loan payment"}</H2>
          <Sub>The interest part shows in the {cat} budget. The principal part isn't spending — it's debt going down.</Sub>
        </Card>
      )}

      {t.kind !== "paycheck" && t.kind !== "transfer" && t.kind !== "loan_payment" && t.kind !== "bc_native" && (
        <>
          {t.receiptStatus === "matched" && (photoUri ? <Image source={{ uri: photoUri }} accessibilityLabel="Your receipt photo" resizeMode="cover" style={{ width: "100%", aspectRatio: 3 / 4, maxHeight: 300, borderRadius: 12, backgroundColor: p.surface2 }} /> : <ReceiptArt merchant={t.merchantNorm} lines={receipt.data?.lines ?? []} totalCents={Math.abs(t.amountCents)} />)}
          {splits.length > 0 && (
            <Card style={{ gap: 0 }}>
              <Eyebrow style={{ paddingBottom: 6 }}>Split from the receipt</Eyebrow>
              {splits.map((s, i) => (
                <KV key={s.lineNo} first={i === 0} label={categoryName(s.categoryId)} value={money(Math.abs(s.amountCents))} />
              ))}
            </Card>
          )}
          {t.receiptStatus === "estimated" && <Banner>No receipt for this one, so it was split the usual way: 60% groceries, 25% household, 15% other. Snap the receipt next time and it splits itself.</Banner>}
          {t.receiptStatus === "needed" && (
            <Card>
              <H2>Snap the receipt</H2>
              <Sub>Walmart, club and Amazon trips of $25 or more split themselves from the receipt. Without one, the usual split applies after 10 days.</Sub>
              <Button title="Snap it now" kind="primary" small onPress={() => router.push("/snap")} />
            </Card>
          )}
          <ButtonRow>
            <Button title="This is wrong" style={{ flex: 1 }} onPress={() => router.push({ pathname: "/wrong/[id]", params: { id: t.id } })} testID="this-is-wrong" />
            {!inflow && <Button title={t.businessFlag !== "none" ? `Business: ${t.businessFlag === "ctj" ? "CTJ" : "Lash"}` : "Mark as business"} style={{ flex: 1 }} onPress={() => router.push({ pathname: "/business/[id]", params: { id: t.id } })} testID="mark-business" />}
          </ButtonRow>
        </>
      )}

      {t.bc?.difference && <Banner tone="neutral">The books show this differently: {t.bc.difference}. The books win; {bookkeeperName()} is looking at it.</Banner>}
    </SheetScreen>
  );
}

/** A drawn receipt when the photo isn't on this phone (it lives in encrypted storage on the server). */
function ReceiptArt({ merchant, lines, totalCents }: { merchant: string; lines: readonly { description: string; amountCents: number }[]; totalCents: number }): React.JSX.Element {
  const { p } = useTheme();
  const mono = { fontFamily: "Menlo", fontSize: 12, lineHeight: 18, color: p.paperInk } as const;
  return (
    <View accessible accessibilityLabel={`Receipt from ${merchant}, total ${money(totalCents)}`} style={{ width: "100%", borderRadius: 12, backgroundColor: p.paper, padding: 14, gap: 2 }}>
      <Text style={[mono, { textAlign: "center", fontWeight: "700" }]}>{merchant.toUpperCase()}</Text>
      <Text style={[mono, { textAlign: "center", marginBottom: 8 }]}>Rexburg, ID</Text>
      {lines.map((l, i) => (
        <View key={i} style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={mono}>{l.description}</Text>
          <Text style={mono}>{(Math.abs(l.amountCents) / 100).toFixed(2)}</Text>
        </View>
      ))}
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
        <Text style={[mono, { fontWeight: "700" }]}>TOTAL</Text>
        <Text style={[mono, { fontWeight: "700" }]}>{(totalCents / 100).toFixed(2)}</Text>
      </View>
    </View>
  );
}
