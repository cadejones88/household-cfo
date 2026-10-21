/**
 * Welcome and sign-in. Entra mode: one button that opens the system browser on homestead.cadejonescpa.com,
 * where the LastPass passkey signs her in; back in the app, Face ID takes over day to day. Dev mode: pick
 * Vanessa or Cade from the seed (the API runs with AUTH_MODE=dev).
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/auth/AuthProvider";
import { unlockWord } from "@/auth/localAuth";
import { devMembers, env } from "@/lib/env";
import { useTheme } from "@/ui/ThemeProvider";
import { BrandMark } from "@/ui/Icons";
import { Body, Button, ButtonRow, Eyebrow, H1, Note, Sub } from "@/ui/primitives";

export default function SignIn(): React.JSX.Element {
  const auth = useAuth();
  const { p, display } = useTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const word = unlockWord(auth.biometrics);
  const members = devMembers();

  return (
    <View testID="sign-in" style={{ flex: 1, backgroundColor: p.bg, justifyContent: "center", gap: 18, paddingHorizontal: 24, paddingTop: insets.top, paddingBottom: insets.bottom + 24 }}>
      <View accessible accessibilityRole="header" accessibilityLabel="Homestead" style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <BrandMark size={30} bg={p.accent} fg={p.accentInk} />
        <Text style={{ fontFamily: display, fontSize: 28, color: p.ink }}>Homestead</Text>
      </View>
      <H1 style={{ fontSize: 34, lineHeight: 38 }}>Our family's money, at a glance.</H1>
      {env.apiMode === "mock" ? (
        <Sub>This is a try-it-out version with example numbers. Nothing here is connected to a real account.</Sub>
      ) : (
        <Sub>Sign in once with your passkey. After that, {word} opens the app.</Sub>
      )}

      {auth.mode === "entra" ? (
        <View style={{ gap: 10 }}>
          <Button
            title={busy ? "Opening sign-in…" : "Sign in with your passkey"}
            kind="primary"
            block
            disabled={busy}
            testID="sign-in-entra"
            onPress={() => {
              setBusy(true);
              void auth.signInEntra().finally(() => setBusy(false));
            }}
          />
          <Note>A browser page opens at homestead.cadejonescpa.com. LastPass offers your passkey; tap it and you're back here.</Note>
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <Eyebrow>Who's using it?</Eyebrow>
          <ButtonRow>
            {members.map((m) => (
              <Button key={m.id} title={m.name} kind="primary" style={{ flex: 1 }} testID={`sign-in-${m.name.toLowerCase()}`} onPress={() => void auth.signInDev(m)} />
            ))}
          </ButtonRow>
          <Note>Development sign-in. The real app signs in with a passkey through the browser.</Note>
        </View>
      )}

      {auth.error !== undefined && <Body style={{ color: p.action }}>{auth.error}</Body>}
      <Note>Homestead never sees your bank password and can't move money.</Note>
    </View>
  );
}
