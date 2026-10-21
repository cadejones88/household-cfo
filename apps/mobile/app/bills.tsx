/**
 * Bills (H13): a calendar of bills and minimums until the next two paydays, with payday marked and
 * "before payday" on the ones safe-to-spend already holds back. Nothing here moves money.
 */
import { View } from "react-native";
import { useRouter } from "expo-router";
import { useBills, useTransactions } from "@/api/hooks";
import { categoryName } from "@/model/categories";
import { dayOf, fmtDate, fmtStampDate, money, todayIso, weekdayOf } from "@/model/format";
import { SheetScreen } from "@/ui/Screen";
import { CalRow, List, PayLine, Stamp, Sub } from "@/ui/primitives";

export default function Bills(): React.JSX.Element {
  const router = useRouter();
  const bills = useBills();
  const recent = useTransactions({ kind: "paycheck", limit: 1 });
  const today = todayIso();
  const list = [...(bills.data?.bills ?? [])].filter((b) => b.dueDate >= today).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const payday = bills.data?.nextPayday;
  const paycheck = recent.data?.transactions[0];
  const payLine = payday ? `Payday ${fmtDate(payday)}${paycheck ? ` · ${paycheck.merchantNorm.split(" · ")[0]} ${money(paycheck.amountCents)}` : ""}` : undefined;
  const rows: React.JSX.Element[] = [];
  let payShown = false;
  list.forEach((b, i) => {
    if (payday && payLine && !payShown && b.dueDate >= payday) {
      rows.push(<PayLine key="payday">{payLine}</PayLine>);
      payShown = true;
    }
    rows.push(<CalRow key={b.id} first={i === 0} weekday={weekdayOf(b.dueDate)} day={dayOf(b.dueDate)} title={b.name} note={`${categoryName(b.categoryId)}${b.beforePayday ? " · before payday" : ""}${b.isMinimum ? " · minimum" : ""}${b.autopay ? " · autopay" : ""}`} amount={money(b.amountCents)} />);
  });
  if (payday && payLine && !payShown && list.length > 0) rows.push(<PayLine key="payday-end">{payLine}</PayLine>);

  return (
    <SheetScreen title="Bills" onClose={() => (router.canGoBack() ? router.back() : router.replace("/"))} testID="bills">
      <Sub>Everything due in the next few weeks. Paychecks are marked.</Sub>
      <List>
        {rows}
        {rows.length === 0 && (
          <View style={{ padding: 14 }}>
            <Sub>{bills.isLoading ? "Looking at the calendar…" : bills.isError ? "Can't reach the bills right now." : "Nothing due in the next few weeks."}</Sub>
          </View>
        )}
      </List>
      <Stamp>Due dates come from the bills themselves. Nothing here moves money.{bills.data ? ` Data through ${fmtStampDate(bills.data.dataThrough.at)}.` : ""}</Stamp>
    </SheetScreen>
  );
}
