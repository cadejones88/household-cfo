/**
 * The lock screen shown on open (and after a long time in the background) when Face ID unlock is on. One tap
 * retries; "Sign out" is the way out when the phone's biometrics stop working. The prompt itself is the
 * system Face ID sheet.
 */
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useAuth } from "../auth/AuthProvider";
import { unlockWord } from "../auth/localAuth";
import { useTheme } from "./ThemeProvider";
import { FaceIdIcon } from "./Icons";
import { Button, Note } from "./primitives";

export function FaceIdGate(): React.JSX.Element {
  const auth = useAuth();
  const { p } = useTheme();
  const [failed, setFailed] = useState(false);
  const tried = useRef(false);
  const word = unlockWord(auth.biometrics);

  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    void auth.unlock().then((ok) => setFailed(!ok));
  }, [auth]);

  return (
    <View accessibilityViewIsModal testID="face-id-gate" style={{ flex: 1, backgroundColor: p.scrim, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <View style={{ backgroundColor: p.surface, borderRadius: 20, paddingVertical: 24, paddingHorizontal: 28, alignItems: "center", gap: 10, minWidth: 240 }}>
        <FaceIdIcon color={p.accent} />
        <Text style={{ fontWeight: "600", fontSize: 17, color: p.ink }}>{word === "your passcode" ? "Passcode" : word}</Text>
        <Note>{failed ? `Couldn't confirm it's you.` : auth.faceIdEnabled ? "Confirming it's you…" : "Confirm with your passcode…"}</Note>
        {failed && (
          <View style={{ gap: 8, alignSelf: "stretch", marginTop: 6 }}>
            <Button title={`Try ${word} again`} kind="primary" block onPress={() => void auth.unlock().then((ok) => setFailed(!ok))} testID="unlock-retry" />
            <Button title="Sign out" kind="ghost" block onPress={() => void auth.signOut()} />
          </View>
        )}
      </View>
    </View>
  );
}
