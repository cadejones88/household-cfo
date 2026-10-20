/**
 * Resolve an Exception (state machine: Exception → Ready for review, or Exception → Posted against an existing
 * BC entry). The keys on both sides are shown and the resolution is recorded with them (spec: "A person
 * resolves it; the resolution is recorded with the keys on both sides").
 */
import { useEffect, useState } from "react";
import type { ConsoleTransactionRow, ExceptionResolution } from "@homestead/shared";
import { Dialog } from "./ui";
import { date, money } from "../lib/format";

export interface ExceptionResolveDialogProps {
  row: ConsoleTransactionRow | null;
  onClose: () => void;
  onResolve: (id: string, resolution: ExceptionResolution) => Promise<unknown> | void;
  busy?: boolean;
}

export function parseEntryNos(input: string): number[] {
  return input
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function ExceptionResolveDialog({ row, onClose, onResolve, busy }: ExceptionResolveDialogProps) {
  const [to, setTo] = useState<ExceptionResolution["to"]>("ready_for_review");
  const [note, setNote] = useState("");
  const [entryNos, setEntryNos] = useState("");
  const [docNo, setDocNo] = useState("");
  const [postingDate, setPostingDate] = useState("");
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!row) return;
    setTo(row.exception?.bcSide?.entryNos?.length ? "posted" : "ready_for_review");
    setNote("");
    setEntryNos(row.exception?.bcSide?.entryNos?.join(", ") ?? "");
    setDocNo(row.exception?.bcSide?.documentNo ?? "");
    setPostingDate(row.exception?.bcSide?.postingDate ?? "");
    setError(undefined);
  }, [row]);

  const open = row !== null;
  const ex = row?.exception;
  const parsed = parseEntryNos(entryNos);
  const canSubmit = note.trim().length > 0 && (to === "ready_for_review" || parsed.length > 0) && !busy;

  async function submit() {
    if (!row) return;
    setError(undefined);
    const resolution: ExceptionResolution = to === "ready_for_review" ? { to, note: note.trim() } : { to, note: note.trim(), bcEntryNos: parsed, bcDocumentNo: docNo || undefined, bcPostingDate: postingDate || undefined };
    try {
      await onResolve(row.id, resolution);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Dialog
      open={open}
      title="Resolve exception"
      onClose={onClose}
      testId="exception-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={!canSubmit} data-testid="resolve-submit">
            {to === "posted" ? "Record as posted" : "Send back to review"}
          </button>
        </>
      }
    >
      {row ? (
        <>
          <div>
            <strong>{row.merchantRaw}</strong> · {date(row.postedDate)} · {money(row.amountCents)} · {row.accountName}
            <div className="notice action" style={{ marginTop: 8 }}>
              {ex?.reason ?? row.bc?.difference ?? "No reason recorded."}
              {ex ? (
                <span className="sub" style={{ display: "block", marginTop: 4 }}>
                  Raised {date(ex.raisedAt)} by {ex.raisedBy}
                </span>
              ) : null}
            </div>
          </div>
          <div className="keys" data-testid="exception-keys">
            <div className="side">
              <h4>App side</h4>
              <dl>
                <dt>Key</dt>
                <dd className="mono">{ex?.appSide.idempotencyKey ?? row.idempotencyKey}</dd>
                <dt>External Doc No.</dt>
                <dd className="mono">{ex?.appSide.externalDocumentNo ?? row.bc?.externalDocumentNo ?? "—"}</dd>
                <dt>Line IDs</dt>
                <dd className="mono">{ex?.appSide.lineIds?.join(", ") || "—"}</dd>
                <dt>State</dt>
                <dd>{ex?.appSide.state ?? row.state}</dd>
                <dt>Amount</dt>
                <dd>
                  {money(ex?.appSide.amountCents ?? row.amountCents)} · {row.splits.length} line{row.splits.length === 1 ? "" : "s"}
                </dd>
              </dl>
            </div>
            <div className="side">
              <h4>BC side</h4>
              {ex?.bcSide ? (
                <dl>
                  <dt>Document</dt>
                  <dd className="mono">{ex.bcSide.documentNo ?? "—"}</dd>
                  <dt>Entry Nos.</dt>
                  <dd className="mono">{ex.bcSide.entryNos?.join(", ") || "—"}</dd>
                  <dt>Posting date</dt>
                  <dd>{ex.bcSide.postingDate ? date(ex.bcSide.postingDate) : "—"}</dd>
                  <dt>Lines / sum</dt>
                  <dd>
                    {ex.bcSide.lineCount ?? "—"} / {ex.bcSide.sumCents !== undefined ? money(ex.bcSide.sumCents) : "—"}
                  </dd>
                  <dt>Note</dt>
                  <dd>{ex.bcSide.note ?? "—"}</dd>
                </dl>
              ) : (
                <span className="sub">BC reported nothing for this key.</span>
              )}
            </div>
          </div>
          <div className="radio-row" role="radiogroup" aria-label="Resolution">
            <label>
              <input type="radio" name="resolution" value="ready_for_review" checked={to === "ready_for_review"} onChange={() => setTo("ready_for_review")} />
              Send back to Ready for review (the app will write a fresh draft after approval)
            </label>
          </div>
          <div className="radio-row">
            <label>
              <input type="radio" name="resolution" value="posted" checked={to === "posted"} onChange={() => setTo("posted")} />
              Mark Posted against an existing BC entry (BC wins; the app stores the entry numbers)
            </label>
          </div>
          {to === "posted" ? (
            <div className="inline-form">
              <label className="field">
                BC entry numbers (comma-separated)
                <input type="text" value={entryNos} onChange={(e) => setEntryNos(e.target.value)} placeholder="4471, 4472" aria-label="BC entry numbers" />
              </label>
              <label className="field">
                Document No.
                <input type="text" value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="G01016" aria-label="BC document number" />
              </label>
              <label className="field">
                Posting date
                <input type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} aria-label="BC posting date" />
              </label>
            </div>
          ) : null}
          <label className="field">
            Resolution note (recorded in the audit log with the keys above)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} aria-label="Resolution note" placeholder="What was wrong and what you checked in BC" />
          </label>
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
