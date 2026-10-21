/**
 * Ask Homestead (V6, H12): plain questions, answers with "Data through … · N items pending", and when the
 * answer drafts a budget move, a button that opens Move money prefilled. Ask never moves money or writes.
 */
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View, type ScrollViewInstance } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AskAnswer } from "@homestead/shared";
import { useAsk, useAskHistory } from "@/api/hooks";
import { categoryName } from "@/model/categories";
import { fmtStampDate, money0 } from "@/model/format";
import { dataThroughLine } from "@/model/safeToSpendVm";
import { useTheme } from "@/ui/ThemeProvider";
import { Button, Chip, Chips, CloseButton, Grab, H1, Note, Stamp, Sub } from "@/ui/primitives";
import { GUTTER, RADIUS } from "@/ui/theme";

const STARTERS = ["How much have we spent eating out?", "What's due before payday?", "How's the emergency fund?", "Can we afford $120 for Peyton's cleats?"];

interface Turn {
  id: string;
  question: string;
  answer?: AskAnswer;
  error?: string;
}

export default function Ask(): React.JSX.Element {
  const router = useRouter();
  const { p } = useTheme();
  const insets = useSafeAreaInsets();
  const ask = useAsk();
  const history = useAskHistory();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const scroll = useRef<ScrollViewInstance>(null);

  useEffect(() => {
    if (turns.length) setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
  }, [turns.length]);

  const submit = async (q: string) => {
    const question = q.trim();
    if (!question || ask.isPending) return;
    const id = `t-${Date.now()}`;
    setText("");
    setTurns((t) => [...t, { id, question }]);
    try {
      const answer = await ask.mutateAsync(question);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, answer } : x)));
    } catch (err) {
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: err instanceof Error && err.message ? err.message : "Couldn't get an answer just now." } : x)));
    }
  };

  const past = (history.data ?? []).slice(0, 5).reverse();

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: p.bg }} testID="ask">
      <View style={{ paddingTop: 10, paddingHorizontal: GUTTER, gap: 10 }}>
        <Grab />
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <H1 style={{ fontSize: 22, lineHeight: 26 }}>Ask Homestead</H1>
          <CloseButton onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} />
        </View>
      </View>
      <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 12, paddingBottom: 16, gap: 14 }}>
        <Sub>Plain questions about our money. Every answer says what date its numbers run through.</Sub>
        <Chips>
          {STARTERS.map((s) => (
            <Chip key={s} label={s} onPress={() => void submit(s)} />
          ))}
        </Chips>
        {past.length > 0 && turns.length === 0 && (
          <>
            <Note>Earlier</Note>
            {past.map((h) => (
              <View key={h.id} style={{ backgroundColor: p.surface, borderRadius: RADIUS, paddingVertical: 14, paddingHorizontal: 16, gap: 8, opacity: 0.8 }}>
                <Text style={{ alignSelf: "flex-end", backgroundColor: p.accentSoft, color: p.ink, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 14, maxWidth: "85%" }}>{h.question}</Text>
                <Text style={{ backgroundColor: p.surface2, color: p.ink, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, maxWidth: "92%", lineHeight: 22 }}>{h.answer}</Text>
                <Stamp>Data through {fmtStampDate(h.dataThrough)}</Stamp>
              </View>
            ))}
          </>
        )}
        {turns.map((t) => (
          <View key={t.id} style={{ backgroundColor: p.surface, borderRadius: RADIUS, paddingVertical: 14, paddingHorizontal: 16, gap: 8 }} accessible accessibilityLabel={`You asked ${t.question}. ${t.answer?.answer ?? t.error ?? "Thinking"}`}>
            <Text style={{ alignSelf: "flex-end", backgroundColor: p.accentSoft, color: p.ink, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 14, borderBottomRightRadius: 4, maxWidth: "85%" }}>{t.question}</Text>
            <Text style={{ backgroundColor: p.surface2, color: t.error ? p.action : p.ink, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, borderBottomLeftRadius: 4, maxWidth: "92%", lineHeight: 22 }}>{t.answer?.answer ?? t.error ?? "Thinking…"}</Text>
            {t.answer?.draftAction && (
              <Button
                title={`Open Move money: ${money0(t.answer.draftAction.amountCents)} ${categoryName(t.answer.draftAction.fromCategoryId)} → ${categoryName(t.answer.draftAction.toCategoryId)}`}
                kind="ghost"
                small
                onPress={() => {
                  const d = t.answer?.draftAction;
                  if (d) router.push({ pathname: "/move-money", params: { to: d.toCategoryId, from: d.fromCategoryId, amount: String(Math.round(d.amountCents / 100)) } });
                }}
              />
            )}
            {t.answer && <Stamp testID="ask-data-through">{dataThroughLine(t.answer.dataThrough)}</Stamp>}
          </View>
        ))}
      </ScrollView>
      <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: 12 + insets.bottom }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Ask anything…"
          placeholderTextColor={p.faintText}
          accessibilityLabel="Ask Homestead"
          testID="ask-input"
          returnKeyType="send"
          onSubmitEditing={() => void submit(text)}
          autoCorrect
          style={{ flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: p.line, backgroundColor: p.surface, paddingHorizontal: 12, color: p.ink, fontSize: 16 }}
        />
        <Button title="Ask" kind="primary" disabled={ask.isPending || !text.trim()} onPress={() => void submit(text)} testID="ask-send" />
      </View>
    </KeyboardAvoidingView>
  );
}
