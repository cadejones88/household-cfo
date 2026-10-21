/**
 * Budget: category rows with dollars left and a calm pace chip, the sample banner until the real budget is
 * approved, the other spouse's "Move money" requests (approve with Face ID or Not now) and the ones we sent
 * (Waiting for …). Tap a category to move money into it.
 */
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { Approval, BudgetLine } from "@homestead/shared";
import { useAuth } from "@/auth/AuthProvider";
import { useAlerts, useApprovals, useBudget, useDecideApproval, useMe } from "@/api/hooks";
import { ApiError, StepUpRequiredError } from "@/api/types";
import { categoryName } from "@/model/categories";
import { fmtStampDate, money0, monthName, monthProgress, todayIso } from "@/model/format";
import { paceKey } from "@/model/status";
import { useTheme } from "@/ui/ThemeProvider";
import { useToast } from "@/ui/Toast";
import { Screen } from "@/ui/Screen";
import { Banner, Bar, Button, ButtonRow, Card, H1, H2, List, Note, Pill, QCard, Row, Stamp, Sub, Tag } from "@/ui/primitives";

export default function Budget(): React.JSX.Element {
  const { p } = useTheme();
  const router = useRouter();
  const auth = useAuth();
  const { show: toast } = useToast();
  const me = useMe();
  const budget = useBudget();
  const approvals = useApprovals("open");
  const alerts = useAlerts();
  const decide = useDecideApproval();
  const today = todayIso();
  const { fraction } = monthProgress(today);
  const myId = auth.member?.id;
  const other = me.data?.members.find((m) => m.id !== myId)?.displayName ?? "the other spouse";
  const lines = budget.data?.lines ?? [];
  const byId = new Map(lines.map((l) => [l.categoryId, l]));
  const inbox = (approvals.data ?? []).filter((a) => a.kind === "budget_move" && a.requestedBy !== myId);
  const waiting = (approvals.data ?? []).filter((a) => a.kind === "budget_move" && a.requestedBy === myId);
  const flexible = lines.filter((l) => !l.isCommitted);
  const flexTotal = flexible.reduce((a, l) => ({ b: a.b + l.budgetCents, s: a.s + l.spentCents }), { b: 0, s: 0 });
  const unread = (alerts.data ?? []).filter((a) => !a.resolvedAt).length;

  const decideWith = async (a: Approval, decision: "approved" | "declined") => {
    if (decision === "approved") {
      const ok = await auth.stepUp("Approve this budget change");
      if (!ok) {
        toast("Not approved — couldn't confirm it was you.");
        return;
      }
    }
    try {
      const r = await decide.mutateAsync({ id: a.id, decision });
      const rev = typeof r.payload["revisionNo"] === "number" ? (r.payload["revisionNo"] as number) : undefined;
      toast(decision === "approved" ? (rev ? `Approved · Budget revision ${rev} saved` : "Approved") : `${a.requestedByName ?? other} will see “Not now”`);
    } catch (err) {
      if (err instanceof StepUpRequiredError) toast("Confirm it's you with Face ID, then try again.");
      else if (err instanceof ApiError && err.code === "other_spouse_decides") toast("The other spouse decides this one.");
      else toast("That didn't go through. Try again.");
    }
  };

  const describe = (a: Approval) => {
    const from = categoryName(a.payload.fromCategoryId);
    const to = categoryName(a.payload.toCategoryId);
    const amt = a.payload.amountCents ?? 0;
    const toLine = byId.get(a.payload.toCategoryId ?? "");
    const effect = a.effect ?? (toLine ? `${to} would have ${money0(toLine.leftCents + amt)} left.` : "");
    return { from, to, amt, effect, note: typeof a.payload.note === "string" ? a.payload.note : undefined };
  };

  return (
    <Screen initial={(auth.member?.displayName ?? "V").charAt(0)} badge={unread} refreshing={budget.isFetching} onRefresh={() => void Promise.all([budget.refetch(), approvals.refetch()])} testID="budget">
      <H1>{monthName(today)} budget</H1>
      {budget.data?.isSample && <Banner>Sample budget until ours is approved. Numbers here are examples.</Banner>}

      {inbox.map((a) => {
        const d = describe(a);
        return (
          <QCard key={a.id} testID={`approval-${a.id}`}>
            <H2>
              {a.requestedByName ?? other} wants to move {money0(d.amt)} from {d.from} to {d.to}
            </H2>
            <Sub>
              {d.note ? `“${d.note}” · ` : ""}
              {d.effect}
            </Sub>
            <ButtonRow>
              <Button title="Approve with Face ID" kind="primary" style={{ flex: 1 }} disabled={decide.isPending} onPress={() => void decideWith(a, "approved")} testID="approve-move" />
              <Button title="Not now" style={{ flex: 1 }} disabled={decide.isPending} onPress={() => void decideWith(a, "declined")} testID="decline-move" />
            </ButtonRow>
          </QCard>
        );
      })}

      {waiting.map((a) => {
        const d = describe(a);
        return (
          <Card key={a.id} style={{ gap: 4 }}>
            <Row>
              <Text style={{ fontWeight: "600", color: p.ink, flexShrink: 1 }}>
                Move {money0(d.amt)} from {d.from} to {d.to}
              </Text>
              <Pill status="neutral" label={`Waiting for ${other}`} />
            </Row>
            <Note>Sent {fmtStampDate(a.requestedAt) === fmtStampDate(new Date().toISOString()) ? "today" : fmtStampDate(a.requestedAt)} · one tap to approve on the other phone.</Note>
          </Card>
        );
      })}

      {flexTotal.b > 0 && (
        <Card>
          <Row>
            <Text style={{ fontWeight: "600", color: p.ink }}>Flexible spending</Text>
            <Sub style={{ fontVariant: ["tabular-nums"] }}>
              {money0(flexTotal.s)} of {money0(flexTotal.b)}
            </Sub>
          </Row>
          <Bar fraction={flexTotal.s / flexTotal.b} />
          <Note>
            {Math.round(fraction * 100)}% of the month is gone · {Math.round((flexTotal.s / flexTotal.b) * 100)}% of flexible money is spent
          </Note>
        </Card>
      )}

      <List>
        {lines.map((l, i) => (
          <BudgetRow key={l.categoryId} line={l} first={i === 0} onPress={() => router.push({ pathname: "/move-money", params: { to: l.categoryId } })} />
        ))}
        {lines.length === 0 && (
          <View style={{ padding: 14 }}>
            <Sub>{budget.isLoading ? "Loading the budget…" : budget.isError ? "Can't reach the budget right now." : "No budget lines yet."}</Sub>
          </View>
        )}
      </List>
      <Stamp>
        Tap a category to move money. Changes go to {other} for one tap of approval, and the reverse applies too.
        {budget.data ? ` Data through ${fmtStampDate(budget.data.dataThrough.at)}.` : ""}
      </Stamp>
    </Screen>
  );
}

function BudgetRow({ line, first, onPress }: { line: BudgetLine; first: boolean; onPress: () => void }): React.JSX.Element {
  const { p } = useTheme();
  const key = line.isAllowance ? undefined : line.isCommitted ? "good" : paceKey(line.pace);
  const tone = key === "watch" ? "watch" : key === "action" ? "action" : "accent";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${line.name}, ${money0(line.leftCents)} left of ${money0(line.budgetCents)}${key ? `, ${key === "good" ? "On track" : key === "watch" ? "Watch" : "Action needed"}` : ""}. Move money.`}
      testID={`budget-${line.categoryId}`}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14, minHeight: 60, borderTopWidth: first ? 0 : 1, borderTopColor: p.line, backgroundColor: pressed ? p.surface2 : "transparent" })}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Row>
          <Text numberOfLines={1} style={{ fontWeight: "600", fontSize: 16, color: p.ink, flexShrink: 1 }}>
            {line.name}
          </Text>
          {key ? <Pill status={key} /> : <Tag>No alerts</Tag>}
        </Row>
        <Bar fraction={line.budgetCents > 0 ? line.spentCents / line.budgetCents : 0} tone={tone} style={{ marginTop: 6 }} />
        <Text style={{ fontSize: 13, color: p.muted, fontVariant: ["tabular-nums"] }}>
          {money0(line.leftCents)} left of {money0(line.budgetCents)}
          {line.isCommitted ? " · fixed" : ""}
        </Text>
      </View>
      <Text style={{ color: p.faint, fontSize: 20 }}>›</Text>
    </Pressable>
  );
}
