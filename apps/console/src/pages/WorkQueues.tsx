import { useState } from "react";
import { useSearchParams } from "react-router";
import type { ConsoleReceiptRow, ConsoleTransactionQueue, ConsoleTransactionRow, RuleSummary } from "@homestead/shared";
import {
  useApproveTransactions,
  useCorrectTransaction,
  useDecideRule,
  useMatchReceipt,
  useReceipts,
  useResolveDuplicate,
  useResolveException,
  useRules,
  useSetBusinessFlag,
  useTransactions,
} from "../api/hooks";
import { QueueTable } from "../components/QueueTable";
import { ExceptionResolveDialog } from "../components/ExceptionResolveDialog";
import { CorrectDialog } from "../components/CorrectDialog";
import { ErrorNotice, JsonDetails, Loading, PageHead, Pager, Tabs, Tag, errorMessage, useToast } from "../components/ui";
import { ago, date, dateTime, money, pct } from "../lib/format";
import { ruleStateView } from "../lib/status";

type Section = "transactions" | "receipts" | "rules" | "exceptions";

const TX_QUEUES: readonly { id: Exclude<ConsoleTransactionQueue, "exception">; label: string }[] = [
  { id: "ready_for_review", label: "Ready for review" },
  { id: "needs_classification", label: "Needs classification" },
  { id: "needs_receipt", label: "Needs receipt" },
  { id: "possible_duplicate", label: "Possible duplicate" },
];

export function WorkQueues() {
  const [params, setParams] = useSearchParams();
  const section = (params.get("tab") as Section | null) ?? "transactions";
  const setSection = (s: Section) => setParams({ tab: s });
  const [toast, say] = useToast();

  // Counts for tab badges
  const ready = useTransactions("ready_for_review", { pageSize: 1 });
  const exceptions = useTransactions("exception", { pageSize: 1 });
  const unmatched = useReceipts("unmatched", { pageSize: 1 });
  const proposed = useRules("proposed", { pageSize: 1 });

  return (
    <>
      <PageHead
        title="Work queues"
        lede="Clear exceptions, low-confidence items, unmatched receipts and possible duplicates. Each approval writes an audit record and, where ready, a BC draft line through the outbox."
        dataThrough={ready.data?.dataThrough}
      />
      <Tabs<Section>
        tabs={[
          { id: "transactions", label: "Transactions", count: ready.data?.total },
          { id: "receipts", label: "Receipts", count: unmatched.data?.total },
          { id: "rules", label: "Rules", count: proposed.data?.total },
          { id: "exceptions", label: "Exceptions", count: exceptions.data?.total },
        ]}
        value={section}
        onChange={setSection}
      />
      {section === "transactions" ? <TransactionsSection say={say} /> : null}
      {section === "receipts" ? <ReceiptsSection say={say} /> : null}
      {section === "rules" ? <RulesSection say={say} /> : null}
      {section === "exceptions" ? <ExceptionsSection say={say} /> : null}
      {toast}
    </>
  );
}

function TransactionsSection({ say }: { say: (m: string) => void }) {
  const [queue, setQueue] = useState<Exclude<ConsoleTransactionQueue, "exception">>("ready_for_review");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [wrong, setWrong] = useState<ConsoleTransactionRow | null>(null);
  const q = useTransactions(queue, { page, pageSize: 50 });
  const approve = useApproveTransactions();
  const correct = useCorrectTransaction();
  const flag = useSetBusinessFlag();
  const dup = useResolveDuplicate();
  const counts = {
    ready_for_review: useTransactions("ready_for_review", { pageSize: 1 }).data?.total,
    needs_classification: useTransactions("needs_classification", { pageSize: 1 }).data?.total,
    needs_receipt: useTransactions("needs_receipt", { pageSize: 1 }).data?.total,
    possible_duplicate: useTransactions("possible_duplicate", { pageSize: 1 }).data?.total,
  };
  const busy = approve.isPending || correct.isPending || flag.isPending || dup.isPending;

  async function approveSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      const r = await approve.mutateAsync(ids);
      setSelected(new Set());
      say(`${r.approved} approved${r.skipped.length ? `, ${r.skipped.length} skipped (${r.skipped.map((s) => s.reason).join("; ")})` : ""}. Drafts go to BC through the outbox.`);
    } catch (err) {
      say(errorMessage(err));
    }
  }

  return (
    <>
      <div className="toolbar">
        <Tabs tabs={TX_QUEUES.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))} value={queue} onChange={(v) => { setQueue(v); setPage(1); setSelected(new Set()); }} />
      </div>
      {queue === "ready_for_review" ? (
        <div className="toolbar">
          <button type="button" className="btn primary" disabled={selected.size === 0 || busy} onClick={() => void approveSelected()} data-testid="approve-selected">
            Approve selected ({selected.size})
          </button>
          <span className="sub" style={{ color: "var(--muted)", fontSize: 12.5 }}>
            Space selects a row, Enter opens its action, A approves the selection. Approval writes the draft line to HHAPP/FEEDS or HHAPP/RECEIPTS; posting is a separate step.
          </span>
        </div>
      ) : queue === "needs_receipt" ? (
        <div className="notice">Walmart, club and Amazon lines of $25 or more wait up to 10 days for a receipt, then post to the unsplit account with "estimated split". Match a receipt from the Receipts tab.</div>
      ) : queue === "possible_duplicate" ? (
        <div className="notice">Same account, amount and date within 3 days from another source. "Same thing" drops the newer row and keeps its key so it cannot come back; "Not a repeat" lets it continue.</div>
      ) : null}
      {q.isLoading ? <Loading what="Loading the queue" /> : q.error ? <ErrorNotice error={q.error} /> : null}
      {q.data ? (
        <>
          <QueueTable
            rows={q.data.items}
            selectable={queue === "ready_for_review"}
            selected={selected}
            onSelectedChange={setSelected}
            onApproveSelected={() => void approveSelected()}
            onWrong={setWrong}
            onBusinessFlag={(row, f) => flag.mutate({ id: row.id, flag: f }, { onSuccess: () => say(`Marked ${f === "none" ? "personal" : f.toUpperCase()}.`), onError: (e) => say(errorMessage(e)) })}
            onDuplicate={(row, decision) => dup.mutate({ id: row.id, decision }, { onSuccess: () => say(decision === "same_thing" ? "Dropped as a repeat; the key is kept." : "Kept; it continues through the queue."), onError: (e) => say(errorMessage(e)) })}
            busy={busy}
          />
          <Pager page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
        </>
      ) : null}
      <CorrectDialog row={wrong} onClose={() => setWrong(null)} busy={correct.isPending} onSubmit={async (id, input) => {
          const r = await correct.mutateAsync({ id, ...input });
          say(r.correctionRequestId ? "Already with BC: a correction request is open for Cade (reverse and repost in BC with reason CORRECT)." : input.makeRule ? "Fixed, and a rule proposal was created for the other spouse." : "Fixed.");
        }} />
    </>
  );
}

function ExceptionsSection({ say }: { say: (m: string) => void }) {
  const [page, setPage] = useState(1);
  const [resolving, setResolving] = useState<ConsoleTransactionRow | null>(null);
  const q = useTransactions("exception", { page, pageSize: 50 });
  const resolve = useResolveException();
  const flag = useSetBusinessFlag();
  return (
    <>
      <div className="notice action">
        BC wins. An exception means the app and BC disagree about a line: a draft edited or deleted in BC, a count or sum that differs at the nightly poll, a non-retryable write error, or a BC entry carrying an HHAPP- number the app does not know. Resolving records the keys on both sides.
      </div>
      {q.isLoading ? <Loading what="Loading exceptions" /> : q.error ? <ErrorNotice error={q.error} /> : null}
      {q.data ? (
        <>
          <QueueTable rows={q.data.items} onResolveException={setResolving} onBusinessFlag={(row, f) => flag.mutate({ id: row.id, flag: f }, { onError: (e) => say(errorMessage(e)) })} busy={resolve.isPending} />
          <Pager page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
        </>
      ) : null}
      <ExceptionResolveDialog
        row={resolving}
        onClose={() => setResolving(null)}
        busy={resolve.isPending}
        onResolve={async (id, resolution) => {
          await resolve.mutateAsync({ id, resolution });
          say(resolution.to === "posted" ? "Recorded as posted against the BC entry." : "Sent back to Ready for review.");
        }}
      />
    </>
  );
}

function ReceiptsSection({ say }: { say: (m: string) => void }) {
  const [status, setStatus] = useState<"unmatched" | "needs_review">("unmatched");
  const q = useReceipts(status, { pageSize: 50 });
  const match = useMatchReceipt();
  const counts = { unmatched: useReceipts("unmatched", { pageSize: 1 }).data?.total, needs_review: useReceipts("needs_review", { pageSize: 1 }).data?.total };
  return (
    <>
      <Tabs tabs={[{ id: "unmatched" as const, label: "Unmatched", count: counts.unmatched }, { id: "needs_review" as const, label: "Needs review", count: counts.needs_review }]} value={status} onChange={setStatus} />
      {q.isLoading ? <Loading what="Loading receipts" /> : q.error ? <ErrorNotice error={q.error} /> : null}
      {q.data ? (
        q.data.items.length === 0 ? (
          <div className="empty">
            <strong>No receipts here.</strong>
            Receipts match on amount, a −3 to +5 day window, merchant similarity and account; two plausible candidates come here for a person.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data" data-testid="receipts-table">
              <thead>
                <tr>
                  <th>Captured</th>
                  <th>By</th>
                  <th>Merchant</th>
                  <th className="num">Total</th>
                  <th className="num">Tax</th>
                  <th>Receipt date</th>
                  <th>OCR</th>
                  <th>Candidates</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((r: ConsoleReceiptRow) => (
                  <tr key={r.id}>
                    <td>
                      {dateTime(r.capturedAt)}
                      <span className="sub">{r.syncState === "synced" ? `uploaded ${ago(r.uploadedAt)}` : r.syncState}</span>
                    </td>
                    <td>{r.memberName}</td>
                    <td>
                      {r.merchant ?? <span className="sub">not read</span>}
                      <span className="sub mono">sha {r.sha256.slice(0, 8)}…</span>
                    </td>
                    <td className="num">{money(r.totalCents)}</td>
                    <td className="num">{money(r.taxCents)}</td>
                    <td>{date(r.receiptDate)}</td>
                    <td>
                      <Tag tone={r.ocrStatus === "read" ? "good" : r.ocrStatus === "failed" ? "action" : r.ocrStatus === "needs_review" ? "watch" : "neutral"}>{r.ocrStatus.replace("_", " ")}</Tag>
                    </td>
                    <td>
                      {r.candidates && r.candidates.length > 0 ? (
                        <ul style={{ margin: 0, paddingLeft: 16 }}>
                          {r.candidates.map((c) => (
                            <li key={c.transactionId}>
                              {date(c.postedDate)} · {c.merchant} · {money(c.amountCents)} · {pct(c.confidence)}{" "}
                              <button type="button" className="btn small" disabled={match.isPending} onClick={() => match.mutate({ receiptId: r.id, transactionId: c.transactionId }, { onSuccess: () => say("Receipt matched; the line moves to Needs classification."), onError: (e) => say(errorMessage(e)) })}>
                                Match
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="sub">{r.ocrStatus === "failed" ? "Image could not be read; ask for a retake." : "No bank line in the window yet."}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </>
  );
}

function RulesSection({ say }: { say: (m: string) => void }) {
  const [state, setState] = useState<"proposed" | "approved" | "retired">("proposed");
  const q = useRules(state, { pageSize: 50 });
  const decide = useDecideRule();
  const counts = { proposed: useRules("proposed", { pageSize: 1 }).data?.total, approved: useRules("approved", { pageSize: 1 }).data?.total };
  return (
    <>
      <Tabs tabs={[{ id: "proposed" as const, label: "Proposed", count: counts.proposed }, { id: "approved" as const, label: "Approved", count: counts.approved }, { id: "retired" as const, label: "Retired" }]} value={state} onChange={setState} />
      <div className="notice">The spouse who did not propose a rule approves it, with step-up. Rules apply only once approved and inside their amount band; the auto-post flag needs Cade's written approval and the household switch, which is off.</div>
      {q.isLoading ? <Loading what="Loading rules" /> : q.error ? <ErrorNotice error={q.error} /> : null}
      {q.data ? (
        q.data.items.length === 0 ? (
          <div className="empty">
            <strong>No {state} rules.</strong>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data" data-testid="rules-table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Kind</th>
                  <th>Match</th>
                  <th>Action</th>
                  <th>Auto-post</th>
                  <th>State</th>
                  <th>Proposed by</th>
                  <th>Stats</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((r: RuleSummary) => {
                  const sv = ruleStateView(r.state);
                  return (
                    <tr key={r.id}>
                      <td>
                        {r.ruleNo ? <strong>{r.ruleNo} · </strong> : null}
                        {r.name}
                        <span className="sub">v{r.version}{r.effectiveFrom ? ` · from ${date(r.effectiveFrom)}` : ""}</span>
                      </td>
                      <td>{r.kind.replace("_", " ")}</td>
                      <td>
                        <JsonDetails label="match" value={r.match} />
                      </td>
                      <td>
                        <JsonDetails label="action" value={r.action} />
                      </td>
                      <td>
                        {r.mayAutoPost ? <Tag tone="watch">may auto-post</Tag> : <span className="sub">no</span>}
                        {r.testPassedAt ? <span className="sub">test passed {date(r.testPassedAt)}</span> : r.mayAutoPost ? <span className="sub">sandbox test pending</span> : null}
                      </td>
                      <td>
                        <Tag tone={sv.tone}>{sv.label}</Tag>
                      </td>
                      <td>{r.proposedByName ?? r.proposedBy}</td>
                      <td>{r.stats ? `${r.stats.fired} fired · ${r.stats.corrected} corrected` : "—"}</td>
                      <td className="actions">
                        {r.state === "proposed" ? (
                          <>
                            <button type="button" className="btn small primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: "approve" }, { onSuccess: () => say("Rule approved."), onError: (e) => say(errorMessage(e)) })}>
                              Approve
                            </button>{" "}
                            <button type="button" className="btn small" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: "decline" }, { onSuccess: () => say("Rule declined."), onError: (e) => say(errorMessage(e)) })}>
                              Decline
                            </button>
                          </>
                        ) : r.state === "approved" ? (
                          <button type="button" className="btn small" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: "retire" }, { onSuccess: () => say("Rule retired."), onError: (e) => say(errorMessage(e)) })}>
                            Retire
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </>
  );
}
