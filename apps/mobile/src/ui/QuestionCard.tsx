/**
 * One "Needs your answer" card: the question in plain words, one tap per option, and why we're asking.
 * Option ids follow the API: `confirm` / `edit` (confirm_split, confirm_category), `category:<id>` / `edit`
 * (pick_category), `not_repeat` / `same_thing`, `no_receipt` / `later`, `approve` / `decline` (step-up),
 * `kind:<component>` (paycheck_component). "Change" / "Something else" hand off to the category picker.
 */
import { View } from "react-native";
import type { Question } from "@homestead/shared";
import { categoryName } from "../model/categories";
import { money } from "../model/format";
import { Button, ButtonRow, Chip, Chips, H2, KV, QCard } from "./primitives";

export interface QuestionCardProps {
  question: Question;
  busy?: boolean;
  /** Called with the option id; the card decides nothing itself. */
  onAnswer: (optionId: string, categoryId?: string) => void;
  /** "Change" / "Something else": open the category picker for the item. */
  onEdit?: () => void;
  /** needs_receipt: open the camera. */
  onSnap?: () => void;
}

const EDIT_IDS = new Set(["edit", "change"]);

export function QuestionCard({ question: q, busy, onAnswer, onEdit, onSnap }: QuestionCardProps): React.JSX.Element {
  const stepUp = q.kind === "approve_budget_move" || q.kind === "approve_rule";
  const asChips = q.kind === "pick_category" || q.kind === "paycheck_component" || q.options.length > 2;
  const splits = q.kind === "confirm_split" ? (q.splits ?? []) : [];
  const pick = (o: Question["options"][number]) => {
    if (EDIT_IDS.has(o.id) && !o.categoryId && onEdit) {
      onEdit();
      return;
    }
    onAnswer(o.id, o.categoryId);
  };
  return (
    <QCard why={q.why} testID={`question-${q.id}`}>
      <H2>{q.prompt}</H2>
      {splits.length > 0 && (
        <View>
          {splits.map((s, i) => (
            <KV key={s.lineNo} first={i === 0} label={categoryName(s.categoryId)} value={money(Math.abs(s.amountCents))} />
          ))}
        </View>
      )}
      {asChips ? (
        <Chips>
          {q.options.map((o) => (
            <Chip key={o.id} label={o.label} onPress={() => pick(o)} testID={`option-${o.id}`} />
          ))}
        </Chips>
      ) : (
        <ButtonRow>
          {q.options.map((o, i) => (
            <Button
              key={o.id}
              title={o.label}
              kind={i === 0 ? "primary" : "default"}
              disabled={busy}
              style={{ flex: 1 }}
              onPress={() => pick(o)}
              testID={`option-${o.id}`}
              accessibilityLabel={stepUp && i === 0 ? `${o.label}. Confirms with Face ID` : o.label}
            />
          ))}
        </ButtonRow>
      )}
      {q.kind === "needs_receipt" && onSnap && <Button title="Snap the receipt" kind="ghost" small onPress={onSnap} />}
    </QCard>
  );
}
