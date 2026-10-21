/**
 * Goals: the current priority (emergency fund), the next debt to clear, and what is set aside this month.
 * Targets read "sample" until they are approved in the budget chat (V5).
 */
import { Text, View } from "react-native";
import type { Goal } from "@homestead/shared";
import { useAuth } from "@/auth/AuthProvider";
import { useAlerts, useGoals } from "@/api/hooks";
import { fmtStampDate, money0 } from "@/model/format";
import { useTheme } from "@/ui/ThemeProvider";
import { Screen } from "@/ui/Screen";
import { Bar, Card, Eyebrow, H2, KV, Note, Row, Stamp, Sub } from "@/ui/primitives";

export default function Goals(): React.JSX.Element {
  const { p, display } = useTheme();
  const auth = useAuth();
  const goals = useGoals();
  const alerts = useAlerts();
  const list = goals.data?.goals ?? [];
  const emergency = list.find((g) => g.fundGoal.startsWith("EMERG"));
  const debt = list.find((g) => g.fundGoal.startsWith("DEBT"));
  const sinking = list.filter((g) => g !== emergency && g !== debt);
  const unread = (alerts.data ?? []).filter((a) => !a.resolvedAt).length;

  const bigNumber = (cents: number) => <Text style={{ fontFamily: display, fontSize: 28, lineHeight: 32, color: p.ink, fontVariant: ["tabular-nums"] }}>{money0(cents)}</Text>;
  const targetText = (g: Goal) => (g.targetCents > 0 ? `of ${money0(g.targetCents)}${g.isSample ? " (sample target)" : ""}` : "Target not set yet");

  return (
    <Screen initial={(auth.member?.displayName ?? "V").charAt(0)} badge={unread} refreshing={goals.isFetching} onRefresh={() => void goals.refetch()} testID="goals">
      <Text accessibilityRole="header" style={{ fontFamily: display, fontSize: 26, lineHeight: 30, color: p.ink }}>
        Goals
      </Text>

      {emergency && (
        <Card testID="goal-emergency">
          <Eyebrow>Our current priority</Eyebrow>
          <H2>A one-month emergency fund</H2>
          <Sub>Money we don't touch unless something breaks. It stays out of “safe to spend.”</Sub>
          <Row>
            {bigNumber(emergency.currentCents)}
            <Sub style={{ fontVariant: ["tabular-nums"] }}>{targetText(emergency)}</Sub>
          </Row>
          <Bar fraction={emergency.targetCents > 0 ? emergency.currentCents / emergency.targetCents : 0} tone="wheat" />
          {emergency.nextMilestone !== undefined && <Note>Next milestone: {emergency.nextMilestone}</Note>}
        </Card>
      )}

      {debt && (
        <Card testID="goal-debt">
          <Eyebrow>Next debt to clear</Eyebrow>
          <H2>{debt.name}</H2>
          <Row>
            {bigNumber(debt.currentCents)}
            <Sub style={{ fontVariant: ["tabular-nums"] }}>{debt.targetCents > debt.currentCents ? `down ${money0(debt.targetCents - debt.currentCents)} from where we started` : "balance"}</Sub>
          </Row>
          <Bar fraction={debt.targetCents > 0 ? Math.max(0, 1 - debt.currentCents / debt.targetCents) : 0} />
          {debt.nextMilestone !== undefined && <Note>{debt.nextMilestone}</Note>}
        </Card>
      )}

      {sinking.length > 0 && (
        <Card style={{ gap: 0 }}>
          <Eyebrow style={{ paddingBottom: 6 }}>Set aside this month</Eyebrow>
          {sinking.map((g, i) => (
            <KV key={g.id} first={i === 0} label={g.name} value={money0(g.currentCents)} />
          ))}
          <Note style={{ paddingTop: 8 }}>These are already out of “safe to spend.”</Note>
        </Card>
      )}

      {list.length === 0 && (
        <Card>
          <H2>{goals.isLoading ? "Loading goals…" : "Target not set yet"}</H2>
          <Sub>Goals show here once they're approved in the budget.</Sub>
        </Card>
      )}

      <View>
        <Stamp>{goals.data ? `Data through ${fmtStampDate(goals.data.dataThrough.at)} · balances are from the books.` : ""}</Stamp>
      </View>
    </Screen>
  );
}
