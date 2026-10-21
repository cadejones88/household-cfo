/**
 * First run, step two (V10, the prototype's welcome): "One more thing: Face ID". Shown once on this phone right
 * after the first sign-in. Turning it on asks the phone to confirm once (which also brings up iOS's own Face ID
 * permission prompt); "Not now" leaves it off, and Settings can turn it on later.
 */
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../auth/AuthProvider";
import { unlockWord } from "../auth/localAuth";
import { useTheme } from "./ThemeProvider";
import { Button, Eyebrow, H1, Note, Sub } from "./primitives";

export function FaceIdIntro(): React.JSX.Element {
  const auth = useAuth();
  const { p } = useTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const word = unlockWord(auth.biometrics);
  const name = auth.member?.displayName?.split(" ")[0] ?? "there";

  const answer = async (enable: boolean) => {
    setBusy(true);
    const ok = await auth.finishFaceIdIntro(enable);
    setBusy(false);
    setFailed(!ok);
  };

  return (
    <View accessibilityViewIsModal testID="face-id-intro" style={{ flex: 1, backgroundColor: p.bg, justifyContent: "center", gap: 18, paddingHorizontal: 24, paddingTop: insets.top, paddingBottom: insets.bottom + 24 }}>
      <Eyebrow>Hi, {name}</Eyebrow>
      <H1>One more thing: {word === "your passcode" ? "your passcode" : word}</H1>
      <Sub>It keeps Homestead to the two of you. You'll use it to open the app and to say yes to a budget change.</Sub>
      <View style={{ gap: 10 }}>
        <Button title={`Turn on ${word === "your passcode" ? "passcode unlock" : word}`} kind="primary" block disabled={busy} onPress={() => void answer(true)} testID="face-id-on" />
        <Button title="Not now" kind="ghost" block disabled={busy} onPress={() => void answer(false)} testID="face-id-not-now" />
      </View>
      {failed && <Note>That didn't go through. Try again, or choose Not now and turn it on later in Settings.</Note>}
    </View>
  );
}
