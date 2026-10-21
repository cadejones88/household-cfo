/**
 * "This is wrong" / the category picker (V4, H7): five suggestions, search across every household category
 * in plain words, and "Do this every time for <merchant>?" which proposes a rule for the other spouse to
 * approve. Before posting the item is fixed at once; after posting a correction request goes to Cade.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCorrectTransaction, usePeople, useProposeRule, useTransaction } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { categoryName, pickableCategories, suggestedCategories, type CategoryOption } from "@/model/categories";
import { bookkeeperName, booksFixWords } from "@/model/people";
import { useTheme } from "@/ui/ThemeProvider";
import { useToast } from "@/ui/Toast";
import { SheetScreen } from "@/ui/Screen";
import { Button, Chip, Chips, Field, List, Note, Sub, Toggle } from "@/ui/primitives";

export default function Wrong(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string; question?: string }>();
  const router = useRouter();
  const { p } = useTheme();
  const auth = useAuth();
  const { otherName: other } = usePeople();
  const { show: toast } = useToast();
  const tx = useTransaction(id);
  const correct = useCorrectTransaction();
  const propose = useProposeRule();
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [rule, setRule] = useState(false);
  const [q, setQ] = useState("");
  const t = tx.data;
  const merchant = t?.merchantNorm.split(" ·")[0] ?? "this";
  const suggestions = useMemo(() => suggestedCategories(t?.categoryId, t?.merchantNorm), [t?.categoryId, t?.merchantNorm]);
  const all = useMemo(() => pickableCategories(), []);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return all.filter((c) => c.name.toLowerCase().includes(needle) || c.group.toLowerCase().includes(needle)).slice(0, 12);
  }, [q, all]);
  const busy = correct.isPending || propose.isPending;

  const save = async () => {
    if (!t || !chosen) return;
    try {
      const r = await correct.mutateAsync({ id: t.id, input: { categoryId: chosen } });
      let ruleNote = "";
      if (rule) {
        try {
          await propose.mutateAsync({ merchantNorm: t.merchantNorm, categoryId: chosen, name: `${merchant} → ${categoryName(chosen)}` });
          ruleNote = ` · rule sent to ${other}`;
        } catch {
          ruleNote = " · the rule didn't send; try again from the item";
        }
      }
      toast(r.correctionRequestId ? `Fix sent to ${bookkeeperName()} — ${categoryName(chosen)}${ruleNote}` : `Updated to ${categoryName(chosen)}${ruleNote}`);
      router.back();
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : "That didn't go through. Try again.");
    }
  };

  const pickRow = (c: CategoryOption, first: boolean) => (
    <Pressable
      key={c.id}
      onPress={() => setChosen(c.id)}
      accessibilityRole="button"
      accessibilityState={{ selected: chosen === c.id }}
      accessibilityLabel={`${c.name}, ${c.group}`}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 52, paddingHorizontal: 14, borderTopWidth: first ? 0 : 1, borderTopColor: p.line, backgroundColor: pressed || chosen === c.id ? p.surface2 : "transparent" })}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ fontWeight: "600", color: p.ink }}>{c.name}</Text>
        <Text style={{ fontSize: 13, color: p.muted }}>{c.group}</Text>
      </View>
      {chosen === c.id && <Text style={{ color: p.accent, fontWeight: "700" }}>✓</Text>}
    </Pressable>
  );

  return (
    <SheetScreen title={`What should ${merchant} be?`} testID="wrong-sheet" footer={<Button title="Save" kind="primary" block disabled={!chosen || busy || !t} onPress={() => void save()} testID="wrong-save" />}>
      {t && <Sub>Now: {categoryName(t.categoryId)}</Sub>}
      <Chips>
        {suggestions.map((c) => (
          <Chip key={c.id} label={c.name} on={chosen === c.id} onPress={() => setChosen(c.id)} testID={`pick-${c.id}`} />
        ))}
      </Chips>
      <Field label="Or pick any category" placeholder="Search: clothes, doctor, gifts…" value={q} onChangeText={setQ} autoCorrect={false} clearButtonMode="while-editing" />
      {filtered.length > 0 && <List>{filtered.map((c, i) => pickRow(c, i === 0))}</List>}
      {q.trim().length > 0 && filtered.length === 0 && <Note>Nothing matches. Try another word.</Note>}
      {chosen && !suggestions.some((c) => c.id === chosen) && filtered.every((c) => c.id !== chosen) && <Note>Chosen: {categoryName(chosen)}</Note>}
      <Toggle label={`Do this every time for ${merchant}?`} note={`We'll ask ${other} to approve the rule. Rules only apply inside the usual amounts.`} value={rule} onChange={setRule} testID="rule-toggle" />
      {t && (t.state === "posted" || t.state === "reconciled") && <Note>This one is already in the books, so {booksFixWords(auth.member?.displayName)}. It shows as “Fix pending” until then.</Note>}
    </SheetScreen>
  );
}
