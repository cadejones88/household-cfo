/**
 * The alerts inbox: one card per problem (Action needed, Watch) and the weekly pulse. The API decides what is
 * sent and when (forecast-driven, one alert per problem, quiet hours); the phone only shows the list.
 */
import { View } from "react-native";
import { useRouter } from "expo-router";
import type { Alert } from "@homestead/shared";
import { useAlerts } from "@/api/hooks";
import { fmtStampDate } from "@/model/format";
import { SheetScreen } from "@/ui/Screen";
import { Card, H2, Note, Pill, Row, Stamp, Sub } from "@/ui/primitives";

function pillFor(a: Alert): { status: "action" | "watch" | "neutral"; label: string } {
  if (a.level === "action") return { status: "action", label: "Action needed" };
  if (a.level === "watch") return { status: "watch", label: "Watch" };
  return { status: "neutral", label: "This week" };
}

export default function Alerts(): React.JSX.Element {
  const router = useRouter();
  const alerts = useAlerts();
  const list = [...(alerts.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <SheetScreen title="Alerts" onClose={() => (router.canGoBack() ? router.back() : router.replace("/"))} testID="alerts">
      <Sub>One note per problem, repeated only if something changes. Nothing here at night unless it's an emergency.</Sub>
      {list.map((a) => {
        const pill = pillFor(a);
        return (
          <Card key={a.id} style={{ opacity: a.resolvedAt ? 0.6 : 1 }} testID={`alert-${a.id}`}>
            <Row>
              <H2 style={{ flexShrink: 1 }}>{a.title}</H2>
              <Pill status={pill.status} label={a.resolvedAt ? "Resolved" : pill.label} />
            </Row>
            <Sub>{a.body}</Sub>
            <Stamp>{fmtStampDate(a.createdAt)}{a.snoozedUntil ? ` · snoozed until ${fmtStampDate(a.snoozedUntil)}` : ""}</Stamp>
          </Card>
        );
      })}
      {list.length === 0 && (
        <View>
          <Note>{alerts.isLoading ? "Checking…" : "Nothing to show. That's good."}</Note>
        </View>
      )}
    </SheetScreen>
  );
}
