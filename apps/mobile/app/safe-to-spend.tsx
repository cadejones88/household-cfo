/**
 * "Safe to spend, in parts" (V2): cash, set-asides, bills before payday (each one listed), giving due and
 * the floor when set, the result, the per-day figure, the next payday and the data-through line.
 * When short, the one small move that fixes it, with "Send to …" which drafts the request for the other spouse.
 */
import { useRouter } from "expo-router";
import { useBudget, usePeople, useSafeToSpend } from "@/api/hooks";
import { buildSafeToSpendVm } from "@/model/safeToSpendVm";
import { fmtShort, money, todayIso } from "@/model/format";
import { useTheme } from "@/ui/ThemeProvider";
import { SheetScreen } from "@/ui/Screen";
import { Button, ButtonRow, Card, Eyebrow, H2, KV, Note, Pill, Row, Stamp, Sub } from "@/ui/primitives";

export default function SafeToSpendSheet(): React.JSX.Element {
  const router = useRouter();
  const { p } = useTheme();
  const { otherName: other } = usePeople();
  const safe = useSafeToSpend();
  const budget = useBudget();
  const today = todayIso();
  const v = safe.data;
  const vm = v ? buildSafeToSpendVm(v, today) : undefined;

  if (!v || !vm) {
    return (
      <SheetScreen title="Safe to spend, in parts">
        <Sub>{safe.isLoading ? "Adding things up…" : "Can't reach the numbers right now."}</Sub>
      </SheetScreen>
    );
  }

  // The smallest flexible category with room, for the "one small move" suggestion when short.
  const shortBy = -v.safeCents;
  const donor = (budget.data?.lines ?? []).filter((l) => !l.isCommitted && !l.isAllowance && l.leftCents >= shortBy).sort((a, b) => a.leftCents - b.leftCents)[0];

  return (
    <SheetScreen title="Safe to spend, in parts" testID="safe-sheet">
      <Card style={{ gap: 0 }}>
        {vm.parts.map((part, i) => (
          <KV key={part.label} first={i === 0} label={part.label} value={part.text} />
        ))}
        <KV label={vm.resultLabel} value={vm.resultText} bold valueColor={p.ink} />
      </Card>

      <Card style={{ gap: 6 }}>
        <Row>
          <Eyebrow>{vm.untilText}</Eyebrow>
          <Pill status={vm.status} />
        </Row>
        <Sub>{vm.paydayText}</Sub>
        {vm.perDayText !== "" && <Note>{vm.perDayText}</Note>}
      </Card>

      {v.billsBeforePayday.length > 0 && (
        <Card style={{ gap: 0 }}>
          <Eyebrow style={{ paddingBottom: 6 }}>Bills due before {fmtShort(v.nextPaydayIso)}</Eyebrow>
          {v.billsBeforePayday.map((b, i) => (
            <KV key={`${b.dueDateIso}-${i}`} first={i === 0} label={`${b.name ?? "Bill"} · ${fmtShort(b.dueDateIso)}`} value={money(b.amountCents)} />
          ))}
        </Card>
      )}

      {vm.isShort && (
        <Card>
          <H2>One small move fixes it</H2>
          <Sub>
            {vm.suggestion ?? (donor ? `Moving ${money(shortBy)} from ${donor.name} covers it, with ${money(donor.leftCents - shortBy)} still left there. Want to send that to ${other}?` : `Holding one flexible purchase until payday covers it. Want to ask ${other}?`)}
          </Sub>
          <ButtonRow>
            <Button title={`Send to ${other}`} kind="primary" style={{ flex: 1 }} onPress={() => router.replace({ pathname: "/move-money", params: donor ? { from: donor.categoryId, amount: String(Math.ceil(shortBy / 100)) } : {} })} />
            <Button title="Not now" style={{ flex: 1 }} onPress={() => router.back()} />
          </ButtonRow>
        </Card>
      )}

      <Note>{vm.forecast}</Note>
      <Stamp testID="safe-data-through">
        {vm.asOf}. Cash is from the bank; set-aside amounts are from the books. {vm.dataThroughText}.
      </Stamp>
    </SheetScreen>
  );
}
