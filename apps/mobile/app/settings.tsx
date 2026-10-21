/**
 * Settings (H14): who is signed in, Face ID unlock, notifications, quiet hours (view), linked logins
 * (status only — Plaid holds the bank sign-ins, never the app), Export my data (step-up), sign out.
 * No prototype scene switch: the numbers are whatever the API says.
 */
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useApi } from "@/api/ApiProvider";
import { useAccounts, useAlerts, useMe, useRequestExport } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { unlockWord } from "@/auth/localAuth";
import { KEYS, SecureKeyValueStore } from "@/auth/tokenStore";
import { env } from "@/lib/env";
import { pushPermission, registerForPush } from "@/push/notifications";
import { useTheme } from "@/ui/ThemeProvider";
import { useToast } from "@/ui/Toast";
import { SheetScreen } from "@/ui/Screen";
import { Button, Card, Eyebrow, KV, Note, Toggle } from "@/ui/primitives";

function quietText(start: string, end: string): string {
  const fmt = (hm: string) => {
    const h = Number(hm.slice(0, 2));
    const m = hm.slice(3, 5);
    const suffix = h >= 12 ? "pm" : "am";
    const hour = h % 12 === 0 ? 12 : h % 12;
    return m === "00" ? `${hour} ${suffix}` : `${hour}:${m} ${suffix}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

export default function Settings(): React.JSX.Element {
  const router = useRouter();
  const { p } = useTheme();
  const auth = useAuth();
  const api = useApi();
  const me = useMe();
  const accounts = useAccounts();
  const alerts = useAlerts();
  const exportReq = useRequestExport();
  const { show: toast } = useToast();
  const store = useMemo(() => new SecureKeyValueStore(), []);
  const [notif, setNotif] = useState<boolean | undefined>(undefined);
  const word = unlockWord(auth.biometrics);
  const quiet = me.data?.household.quietHours ?? { start: "21:00", end: "07:00" };
  const unread = (alerts.data ?? []).filter((a) => !a.resolvedAt).length;

  useEffect(() => {
    void store.get<boolean>(KEYS.notifications).then((v) => setNotif(v ?? false));
  }, [store]);

  const toggleNotif = async (on: boolean) => {
    setNotif(on);
    await store.set(KEYS.notifications, on);
    if (on) {
      const perm = await pushPermission();
      if (perm !== "granted") {
        setNotif(false);
        await store.set(KEYS.notifications, false);
        toast(perm === "denied" ? "Turn on notifications for Homestead in Settings first." : "Notifications aren't available here.");
        return;
      }
      const token = await registerForPush(api, store).catch(() => undefined);
      toast(token ? "Notifications on" : "Notifications on here; the server will know once push is set up.");
    } else {
      toast("Notifications off");
    }
  };

  const toggleFaceId = async (on: boolean) => {
    if (!on) {
      const ok = await auth.stepUp(`Turn off ${word} unlock`);
      if (!ok) return;
    }
    await auth.setFaceIdEnabled(on);
    toast(on ? `${word} unlock on` : `${word} unlock off`);
  };

  const exportData = async () => {
    const ok = await auth.stepUp("Export your data");
    if (!ok) return;
    try {
      const r = await exportReq.mutateAsync();
      toast(r.available ? "Export requested. We'll tell you when the file is ready." : "Export isn't available yet — ask Cade for a copy from the Console.");
    } catch {
      toast("Export didn't go through. Try again.");
    }
  };

  const status = (feed: string) => (feed === "ok" ? ["Connected", p.good] : feed === "file_only" ? ["Statement upload", p.watch] : feed === "needs_relink" ? ["Needs a re-link", p.action] : feed === "stale" ? ["Out of date", p.watch] : ["Not linked", p.muted]) as [string, string];

  return (
    <SheetScreen title="Settings" onClose={() => (router.canGoBack() ? router.back() : router.replace("/"))} testID="settings">
      <Card style={{ gap: 0 }}>
        <Eyebrow style={{ paddingBottom: 6 }}>Signed in as {auth.member?.displayName ?? "you"}</Eyebrow>
        <Toggle label={`Unlock with ${word}`} value={auth.faceIdEnabled} onChange={(v) => void toggleFaceId(v)} testID="toggle-faceid" />
        <Toggle label="Notifications" note="Action-needed alerts and the weekly pulse" value={notif === true} onChange={(v) => void toggleNotif(v)} testID="toggle-notifications" />
        <View style={{ minHeight: 48, justifyContent: "center", paddingVertical: 4 }}>
          <Text style={{ fontSize: 16, color: p.ink }}>Quiet hours {quietText(quiet.start, quiet.end)}</Text>
          <Note>Only an emergency gets through at night. Both of you change this together in the Console.</Note>
        </View>
      </Card>

      <Card style={{ gap: 0 }}>
        <Eyebrow style={{ paddingBottom: 6 }}>Linked logins</Eyebrow>
        {(accounts.data?.accounts ?? []).map((a, i) => {
          const [label, color] = status(a.feedStatus);
          return <KV key={a.id} first={i === 0} label={`${a.institution}${a.mask ? ` ·${a.mask}` : ""}`} value={label} valueColor={color} />;
        })}
        {!accounts.data && <Note>{accounts.isLoading ? "Checking…" : "Can't reach the list right now."}</Note>}
        <Note style={{ paddingTop: 8 }}>Homestead never sees your bank password and can't move money. Only the last four digits are shown.</Note>
      </Card>

      <Card style={{ gap: 8 }}>
        <Button title="Export my data" block onPress={() => void exportData()} disabled={exportReq.isPending} testID="export-data" />
        <Note>Everything in Homestead, as a file you can open anywhere. Confirms with {word} first.</Note>
      </Card>

      {unread > 0 && <Button title={`Alerts (${unread})`} kind="ghost" block onPress={() => router.push("/alerts")} />}
      {unread === 0 && <Button title="Alerts" kind="ghost" block onPress={() => router.push("/alerts")} />}

      <Card style={{ gap: 8 }}>
        <Button title="Sign out" block onPress={() => void auth.signOut()} testID="sign-out" />
        <Note>{auth.mode === "entra" ? "Next time you'll sign in with your passkey again." : "Development sign-in."}</Note>
      </Card>
      <Note>
        Homestead {env.apiMode === "mock" ? "· sample data, no real accounts" : ""}
      </Note>
    </SheetScreen>
  );
}
