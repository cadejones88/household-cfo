/**
 * Home: the big safe-to-spend number (tap for the parts), the one-sentence forecast, Needs your answer
 * (at most three cards), the paycheck card, bills before payday, the goals peek, recent activity and the
 * Ask bar. Every number carries its data-through stamp.
 */
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/auth/AuthProvider";
import { useAlerts, useBills, useGoals, useMe, useQuestions, useSafeToSpend, useTransactions } from "@/api/hooks";
import { buildSafeToSpendVm } from "@/model/safeToSpendVm";
import { fmtDate, hourNow, money, money0, relDate, todayIso, dayOf, weekdayOf } from "@/model/format";
import { categoryName } from "@/model/categories";
import { useReceiptQueue } from "@/receipts/ReceiptQueueProvider";
import { useTheme } from "@/ui/ThemeProvider";
import { Screen, SectionHead } from "@/ui/Screen";
import { QuestionCard } from "@/ui/QuestionCard";
import { QueuedReceiptRow, TxRow } from "@/ui/TxRow";
import { SearchIcon } from "@/ui/Icons";
import { useAnswer } from "@/ui/useAnswer";
import { Bar, Big, CalRow, Card, Eyebrow, H2, List, Note, PayLine, Pill, Row, Stamp, Sub } from "@/ui/primitives";
import { RADIUS } from "@/ui/theme";

export default function Home(): React.JSX.Element {
  const { p } = useTheme();
  const router = useRouter();
  const auth = useAuth();
  const me = useMe();
  const safe = useSafeToSpend();
  const questions = useQuestions();
  const bills = useBills();
  const goals = useGoals();
  const recent = useTransactions({ limit: 6 });
  const alerts = useAlerts();
  const queue = useReceiptQueue();
  const today = todayIso();
  const name = auth.member?.displayName ?? me.data?.member.displayName ?? "there";
  const other = me.data?.members.find((m) => m.id !== auth.member?.id)?.displayName ?? "the other spouse";
  const { answer, edit, busy } = useAnswer(other);

  const vm = useMemo(() => (safe.data ? buildSafeToSpendVm(safe.data, today) : undefined), [safe.data, today]);
  const qs = questions.data?.questions ?? [];
  const beforePayday = (bills.data?.bills ?? []).filter((b) => b.beforePayday && !b.paid && b.dueDate >= today);
  const payday = bills.data?.nextPayday;
  const paycheck = recent.data?.transactions.find((t) => t.kind === "paycheck");
  const emergency = goals.data?.goals.find((g) => g.fundGoal.startsWith("EMERG")) ?? goals.data?.goals[0];
  const unread = (alerts.data ?? []).filter((a) => !a.resolvedAt).length;
  const queued = queue.items.filter((i) => i.status !== "synced" && i.status !== "duplicate").slice(0, 2);
  const recentRows = (recent.data?.transactions ?? []).slice(0, 4);
  const refreshing = safe.isFetching || questions.isFetching;
  const refresh = () => {
    void safe.refetch();
    void questions.refetch();
    void bills.refetch();
    void recent.refetch();
  };

  return (
    <Screen initial={name.charAt(0)} badge={unread} refreshing={refreshing} onRefresh={refresh} testID="home">
      <Eyebrow>
        Good {hourNow() < 12 ? "morning" : hourNow() < 18 ? "afternoon" : "evening"}, {name}
      </Eyebrow>

      {vm ? (
        <Card hero onPress={() => router.push("/safe-to-spend")} accessibilityLabel={`${vm.headline}, ${vm.untilText}, ${vm.statusLabel}. Tap for the parts.`} testID="safe-card">
          <Row>
            <Eyebrow>{vm.untilText}</Eyebrow>
            <Pill status={vm.status} />
          </Row>
          <Big testID="safe-headline" style={vm.isShort ? { color: p.action } : undefined}>
            {vm.headline}
          </Big>
          <Sub>{vm.subline}</Sub>
          <Row>
            <Stamp style={{ flexShrink: 1 }}>{vm.asOf}</Stamp>
            <Stamp>Tap for the parts ›</Stamp>
          </Row>
        </Card>
      ) : (
        <Card hero>
          <Eyebrow>Until payday</Eyebrow>
          <Big style={{ color: p.faint }}>{safe.isError ? "Can't reach the numbers" : "…"}</Big>
          <Sub>{safe.isError ? "Check the connection and pull down to try again." : "Adding things up"}</Sub>
        </Card>
      )}

      {vm && (
        <Card style={{ gap: 6 }}>
          <Sub>{vm.forecast}</Sub>
        </Card>
      )}

      {qs.length > 0 ? (
        <>
          <SectionHead title="Needs your answer" count={qs.length} />
          {qs.slice(0, 3).map((q) => (
            <QuestionCard key={q.id} question={q} busy={busy} onAnswer={(opt, cat) => void answer(q, opt, cat)} onEdit={() => edit(q)} onSnap={() => router.push("/snap")} />
          ))}
          {qs.length > 3 && <Note>{qs.length - 3} more after these.</Note>}
        </>
      ) : (
        <Card>
          <H2>Nothing needs your answer</H2>
          <Sub>We'll ask only when a purchase could go two ways.</Sub>
        </Card>
      )}

      {paycheck && (
        <Card onPress={() => router.push({ pathname: "/transaction/[id]", params: { id: paycheck.id } })} accessibilityLabel={`Paycheck arrived ${relDate(paycheck.postedDate, today)}, ${money(paycheck.amountCents)}`}>
          <Row>
            <View style={{ flex: 1 }}>
              <H2>{paycheck.merchantNorm.split(" · ")[0]} arrived {relDate(paycheck.postedDate, today).toLowerCase()}</H2>
              <Sub>{paycheck.merchantNorm.split(" · ")[1] ?? "Paycheck"} · regular pay, bonus and taxes recorded</Sub>
            </View>
            <Text style={{ fontWeight: "600", color: p.good, fontVariant: ["tabular-nums"], fontSize: 16 }}>{money(paycheck.amountCents, "always")}</Text>
          </Row>
        </Card>
      )}

      <SectionHead title="Coming up before payday" action="All bills" onAction={() => router.push("/bills")} />
      <List>
        {beforePayday.length === 0 && (
          <View style={{ padding: 14 }}>
            <Sub>{bills.isLoading ? "Looking at the calendar…" : "Nothing due before payday."}</Sub>
          </View>
        )}
        {beforePayday.map((b, i) => (
          <CalRow key={b.id} first={i === 0} weekday={weekdayOf(b.dueDate)} day={dayOf(b.dueDate)} title={b.name} note={categoryName(b.categoryId)} amount={money(b.amountCents)} />
        ))}
        {payday && <PayLine>Payday {fmtDate(payday)}{paycheck ? ` · ${paycheck.merchantNorm.split(" · ")[0]} ${money(paycheck.amountCents)}` : ""}</PayLine>}
      </List>

      <SectionHead title="Goals" action="See all" onAction={() => router.push("/goals")} />
      {emergency ? (
        <Card onPress={() => router.push("/goals")} accessibilityLabel={`${emergency.name}: ${money0(emergency.currentCents)} of ${money0(emergency.targetCents)}`}>
          <Row>
            <Text style={{ fontWeight: "600", color: p.ink, flexShrink: 1 }}>{emergency.name}</Text>
            <Sub style={{ fontVariant: ["tabular-nums"] }}>
              {money0(emergency.currentCents)} of {money0(emergency.targetCents)}
            </Sub>
          </Row>
          <Bar fraction={emergency.targetCents > 0 ? emergency.currentCents / emergency.targetCents : 0} tone="wheat" />
          {emergency.nextMilestone !== undefined && <Note>Next milestone: {emergency.nextMilestone}</Note>}
        </Card>
      ) : (
        <Card>
          <Sub>{goals.isLoading ? "Loading goals…" : "Targets show here once they're approved."}</Sub>
        </Card>
      )}

      {(queued.length > 0 || recentRows.length > 0) && (
        <>
          <SectionHead title="Recent activity" action="See all" onAction={() => router.push("/activity")} />
          <List>
            {queued.map((q, i) => (
              <QueuedReceiptRow key={q.clientId} item={q} first={i === 0} onPress={() => router.push({ pathname: "/receipt/[clientId]", params: { clientId: q.clientId } })} />
            ))}
            {recentRows.map((t, i) => (
              <TxRow key={t.id} tx={t} today={today} first={i === 0 && queued.length === 0} onPress={() => router.push({ pathname: "/transaction/[id]", params: { id: t.id } })} />
            ))}
          </List>
        </>
      )}

      <Pressable
        onPress={() => router.push("/ask")}
        accessibilityRole="button"
        accessibilityLabel="Ask Homestead anything"
        testID="ask-bar"
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: p.surface, borderRadius: RADIUS, paddingVertical: 12, paddingHorizontal: 14, minHeight: 48, opacity: pressed ? 0.85 : 1 })}
      >
        <SearchIcon color={p.muted} />
        <Text style={{ color: p.muted, fontSize: 15, flex: 1 }} numberOfLines={1}>
          Ask Homestead anything… <Text style={{ color: p.ink }}>“How much have we spent eating out?”</Text>
        </Text>
      </Pressable>
    </Screen>
  );
}
