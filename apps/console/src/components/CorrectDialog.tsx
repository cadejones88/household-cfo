/**
 * "This is wrong" for the Console: pick the right category (household words, grouped), optionally propose a
 * rule. Before posting the fix applies at once; after posting it becomes a correction request (BC entries are
 * immutable; Cade reverses and reposts in BC with reason CORRECT).
 */
import { useEffect, useMemo, useState } from "react";
import { CATEGORIES, type ConsoleTransactionRow } from "@homestead/shared";
import { Dialog, errorMessage } from "./ui";
import { date, money } from "../lib/format";

export interface CorrectDialogProps {
  row: ConsoleTransactionRow | null;
  onClose: () => void;
  onSubmit: (id: string, input: { categoryId: string; note?: string; makeRule?: boolean }) => Promise<unknown> | void;
  busy?: boolean;
}

export function CorrectDialog({ row, onClose, onSubmit, busy }: CorrectDialogProps) {
  const [categoryId, setCategoryId] = useState("");
  const [note, setNote] = useState("");
  const [makeRule, setMakeRule] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    setCategoryId(row?.categoryId ?? "");
    setNote("");
    setMakeRule(false);
    setError(undefined);
  }, [row]);

  const groups = useMemo(() => {
    const m = new Map<string, typeof CATEGORIES>();
    for (const c of CATEGORIES) m.set(c.group, [...(m.get(c.group) ?? []), c]);
    return [...m.entries()];
  }, []);
  const posted = row ? ["posted", "reconciled"].includes(row.state) : false;

  async function submit() {
    if (!row || !categoryId) return;
    try {
      await onSubmit(row.id, { categoryId, note: note || undefined, makeRule });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Dialog
      open={row !== null}
      title={posted ? "Request a correction" : "This is wrong"}
      onClose={onClose}
      testId="correct-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || !categoryId || categoryId === row?.categoryId}>
            {posted ? "Send to correction queue" : "Fix it"}
          </button>
        </>
      }
    >
      {row ? (
        <>
          <div>
            <strong>{row.merchantRaw}</strong> · {date(row.postedDate)} · {money(row.amountCents)} · {row.accountName}
            {row.categoryName ? <span className="sub"> currently {row.categoryName}</span> : null}
          </div>
          {posted ? <div className="notice watch">This line is already in the books. The fix becomes a correction request: reverse in BC with reason REVERSE and repost with CORRECT; the app links the new entry.</div> : null}
          <label className="field">
            Category
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category">
              <option value="">Choose…</option>
              {groups.map(([group, cats]) => (
                <optgroup key={group} label={group}>
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.glAccount}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="field">
            Note (optional)
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Correction note" />
          </label>
          {!posted ? (
            <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} />
              Do this every time for this merchant (creates a rule proposal for the other spouse; it never auto-posts)
            </label>
          ) : null}
          {error ? (
            <div className="notice action" role="alert">
              {error}
            </div>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}
