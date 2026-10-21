/**
 * Move money (V7, H9): pick the amount and where it comes from, see the effect on both categories before
 * sending, then send it to the other spouse for one tap of approval. Nothing changes until they say yes.
 * Opens prefilled from Ask Homestead's drafted move and from the safe-to-spend sheet.
 */
import { useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { BudgetLine } from "@homestead/shared";
import { useBudget, usePeople, useProposeBudgetMove } from "@/api/hooks";
import { parseCents } from "@homestead/shared";
import { money0 } from "@/model/format";
import { useTheme } from "@/ui/ThemeProvider";
import { useToast } from "@/ui/Toast";
import { SheetScreen } from "@/ui/Screen";
import { Button, Card, Chip, Chips, Field, Note, Sub } from "@/ui/primitives";

export default function MoveMoney(): React.JSX.Element {
  const params = useLocalSearchParams<{ to?: string; from?: string; amount?: string }>();
  const router = useRouter();
  const { p, display } = useTheme();
  const { otherName: other } = usePeople();
  const { show: toast } = useToast();
  const budget = useBudget();
  const propose = useProposeBudgetMove();
  const lines = budget.data?.lines ?? [];
  const [to, setTo] = useState<string | undefined>(params.to);
  const [from, setFrom] = useState<string | undefined>(params.from);
  const [amount, setAmount] = useState(params.amount ?? "50");
  const [note, setNote] = useState("");
  const target = lines.find((l) => l.categoryId === to);
  const sources = useMemo(() => lines.filter((l) => !l.isCommitted && !l.isAllowance && l.categoryId !== to), [lines, to]);
  const source = sources.find((l) => l.categoryId === from) ?? sources[0];
  const cents = useMemo(() => {
    try {
      return Math.max(0, parseCents(amount || "0"));
    } catch {
      return 0;
    }
  }, [amount]);
  const month = budget.data?.month;

  const send = async () => {
    if (!target || !source || cents <= 0) return;
    try {
      await propose.mutateAsync({ fromCategoryId: source.categoryId, toCategoryId: target.categoryId, amountCents: cents, ...(month ? { month } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      toast(`Sent to ${other}. One tap there approves it.`);
      router.dismissTo("/budget");
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : "That didn't send. Try again.");
    }
  };

  const effect = (line: BudgetLine, delta: number) => `${line.name} would have ${money0(line.leftCents + delta)} left`;

  return (
    <SheetScreen
      title={target ? `Move money into ${target.name}` : "Move money"}
      eyebrow={target?.name}
      testID="move-money"
      footer={
        <>
          <Button title={`Send to ${other} for a tap of approval`} kind="primary" block disabled={!target || !source || cents <= 0 || propose.isPending} onPress={() => void send()} testID="move-send" />
          <Note>Budget changes need both of us. {other} gets one tap; nothing changes until they say yes.</Note>
        </>
      }
    >
      {target && (
        <Sub style={{ fontVariant: ["tabular-nums"] }}>
          {money0(target.leftCents)} left of {money0(target.budgetCents)} this month.
        </Sub>
      )}
      {!target && (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 13, color: p.muted, fontWeight: "600" }}>Move money into</Text>
          <Chips>
            {lines
              .filter((l) => !l.isCommitted)
              .map((l) => (
                <Chip key={l.categoryId} label={l.name} on={to === l.categoryId} onPress={() => setTo(l.categoryId)} />
              ))}
          </Chips>
        </View>
      )}
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ fontFamily: display, fontSize: 34, color: p.ink }}>$</Text>
          <TextInput
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            inputMode="decimal"
            accessibilityLabel="Amount"
            testID="move-amount"
            selectTextOnFocus
            style={{ flex: 1, fontFamily: display, fontSize: 34, color: p.ink, padding: 0, minHeight: 44 }}
          />
        </View>
        <Text style={{ fontSize: 13, color: p.muted, fontWeight: "600" }}>Take it from</Text>
        <Chips>
          {sources.map((l) => (
            <Chip key={l.categoryId} label={`${l.name} · ${money0(l.leftCents)} left`} on={source?.categoryId === l.categoryId} onPress={() => setFrom(l.categoryId)} testID={`from-${l.categoryId}`} />
          ))}
        </Chips>
        {target && source && cents > 0 && (
          <Note testID="move-effect">
            {effect(target, cents)} · {effect(source, -cents)}.
          </Note>
        )}
        {source && cents > source.leftCents && <Note>That's more than {source.name} has left this month. {other} can still approve it.</Note>}
      </Card>
      <Field label="A note for them (optional)" placeholder="Two trips to Idaho Falls this week." value={note} onChangeText={setNote} maxLength={200} />
    </SheetScreen>
  );
}
