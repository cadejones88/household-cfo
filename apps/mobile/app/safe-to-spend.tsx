/**
 * "Safe to spend, in parts" (V2): cash, set-asides, bills before payday (each one listed), giving due and
 * the floor when set, the result, the per-day figure, the next payday and the data-through line.
 * When short, the one small move that fixes it, with "Send to …" which drafts the request for the other spouse.
 */
import { useRouter } from "expo-router";
import { useSafeToSpend, useMe, useBudget } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { buildSafeToSpendVm } from "@/model/safeToSpendVm";
import { fmtDate, fmtShort, fmtStampDate, money, todayIso } from "@/model/format";
import { useTheme } from "@/ui/ThemeProvider";
import { SheetScreen } from "@/ui/Screen";
import { Button, ButtonRow, Card, Eyebrow, H2, KV, Note, Pill, Stamp, Sub } from "@/ui/primitives";

export default function SafeToSpendSheet(): React.JSX.Element {
  const router = useRouter();
  const { p } = useTheme();
  const auth = useAuth();
  const me = useMe();
  const safe = useSafeToSpend();
  const budget = useBudget();
  const today = todayIso();
  const other = me.data?.members.find((m) => m.id !== auth.member?.id)?.displayName ?? "the other spouse";
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
        <KV label={vm.resultLabel} value={vm.resultText} bold valueColor={vm.isShort ? p.action : p.ink} />
      </Card>

      <Card style={{ gap: 6 }}>
        <Eyebrow>{vm.untilText}</Eyebrow>
        <Sub>{vm.isShort ? `Payday is ${fmtDate(v.nextPaydayIso)}, ${v.daysUntilPayday} day${v.daysUntilPayday === 1 ? "" : "s"} away.` : vm.perDayText}</Sub>
        <Pill status={vm.status} style={{ alignSelf: "flex-start" }} />
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
      <Stamp>
        {vm.asOf}. Cash is from the bank; set-aside amounts are from the books. Data through {fmtStampDate(v.dataThrough.at)}
        {v.dataThrough.pendingCount ? ` · ${v.dataThrough.pendingCount} items still being recorded` : ""}.
      </Stamp>
    </SheetScreen>
  );
}
