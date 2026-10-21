import { useState } from "react";
import { useSearchParams } from "react-router";
import type { SyncRunSummary } from "@homestead/shared";
import { useAudit, useConnections, useHealthReport, useOutbox, useRetryOutbox, useSyncRuns } from "../api/hooks";
import { ErrorNotice, JsonDetails, Loading, PageHead, Pager, Tabs, Tag, errorMessage, useToast } from "../components/ui";
import { ago, dateTime } from "../lib/format";
import { feedStatusView, freshnessTone, syncRunStatusView } from "../lib/status";

type Section = "connections" | "runs" | "jobs" | "audit" | "nightly";

const RUN_KINDS: readonly SyncRunSummary["kind"][] = ["plaid", "matching", "ocr", "file_import", "outbox_relay", "bc_worker", "autopost", "bc_readback", "bc_poll", "bc_webhook", "webhook_renewal", "alerts", "paycheck_fallback", "receipt_fallback", "rule_proposals"];

/** Entities the API and jobs write to the audit log (services/api, services/jobs). */
const AUDIT_ENTITIES = ["transaction", "receipt", "rule", "approval", "batch", "outbox", "paycheck", "account", "feed_connection", "household", "member", "budget_revision", "bc_document", "alert", "ask_conversation"] as const;

export function Health() {
  const [params, setParams] = useSearchParams();
  const section = (params.get("tab") as Section | null) ?? "connections";
  const conn = useConnections();
  const [toast, say] = useToast();
  return (
    <>
      <PageHead
        title="Connection health, logs and audit"
        lede="Plaid logins, BC webhook subscriptions, poll results, failed jobs and the append-only audit history. A stale feed, a dead-lettered BC write or a failed webhook renewal should reach this page within 15 minutes."
        dataThrough={conn.data?.dataThrough}
      />
      <Tabs<Section>
        tabs={[
          { id: "connections", label: "Connections", count: conn.data ? conn.data.feeds.filter((f) => f.needsRelink || f.status === "stale").length + conn.data.subscriptions.filter((s) => s.needsRenewal).length : undefined },
          { id: "runs", label: "Sync runs" },
          { id: "jobs", label: "Failed jobs" },
          { id: "audit", label: "Audit log" },
          { id: "nightly", label: "Nightly acceptance" },
        ]}
        value={section}
        onChange={(s) => setParams({ tab: s })}
      />
      {section === "connections" ? <Connections /> : null}
      {section === "runs" ? <Runs /> : null}
      {section === "jobs" ? <FailedJobs say={say} /> : null}
      {section === "audit" ? <Audit /> : null}
      {section === "nightly" ? <Nightly /> : null}
      {toast}
    </>
  );
}

function Connections() {
  const q = useConnections();
  if (q.isLoading) return <Loading what="Checking connections" />;
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return null;
  const d = q.data;
  return (
    <>
      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <div className="card stat">
          <span className="label">Business Central</span>
          <span className="value small">
            {d.ledger.apiReachable === false ? (
              <Tag tone="action">unreachable</Tag>
            ) : d.ledger.apiReachable === true ? (
              <Tag tone={freshnessTone(d.ledger.lastPollAt, 30)}>reachable</Tag>
            ) : (
              <Tag tone={d.ledger.lastPollAt ? freshnessTone(d.ledger.lastPollAt, 30) : "watch"}>{d.ledger.lastPollAt ? `polled ${ago(d.ledger.lastPollAt)}` : "never polled"}</Tag>
            )}
          </span>
          <span className="sub">
            poll {ago(d.ledger.lastPollAt)} · webhook {ago(d.ledger.lastWebhookAt)} · checked {ago(d.ledger.checkedAt)}
          </span>
        </div>
        <div className="card stat">
          <span className="label">Plaid logins needing re-link</span>
          <span className="value" style={{ color: d.feeds.some((f) => f.needsRelink) ? "var(--action)" : undefined }}>
            {d.feeds.filter((f) => f.needsRelink).length}
          </span>
          <span className="sub">Only the login's owner can re-link; alerts on those accounts pause</span>
        </div>
        <div className="card stat">
          <span className="label">Subscriptions due for renewal</span>
          <span className="value" style={{ color: d.subscriptions.some((s) => s.needsRenewal) ? "var(--action)" : undefined }}>
            {d.subscriptions.filter((s) => s.needsRenewal).length}
          </span>
          <span className="sub">Renewed daily; three-day expiry</span>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Feed connections</h2>
          <span className="hint">Plaid every 4 hours and on SYNC_UPDATES_AVAILABLE; files on upload. Stale after 48 hours.</span>
        </div>
        <table className="data" data-testid="feeds-table">
          <thead>
            <tr>
              <th>Institution</th>
              <th>Provider</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Last sync</th>
              <th className="num">Accounts</th>
              <th>Cursor</th>
            </tr>
          </thead>
          <tbody>
            {d.feeds.length === 0 ? (
              <tr>
                <td colSpan={7} className="sub">
                  No bank logins linked yet. Each spouse links their own from the phone app; statement files are imported without a login.
                </td>
              </tr>
            ) : null}
            {d.feeds.map((f) => {
              const sv = feedStatusView(f.status);
              return (
                <tr key={f.id}>
                  <td>{f.institutionName}</td>
                  <td>{f.provider}</td>
                  <td>{f.ownerName}</td>
                  <td>
                    <Tag tone={sv.tone}>{sv.label}</Tag>
                    {f.needsRelink ? <span className="sub">ITEM_LOGIN_REQUIRED · {f.ownerName} sees a calm re-link card</span> : null}
                  </td>
                  <td>
                    <Tag tone={f.provider === "file" ? "neutral" : freshnessTone(f.lastSyncedAt)} plain>
                      {ago(f.lastSyncedAt)}
                    </Tag>
                    <span className="sub">{dateTime(f.lastSyncedAt)}</span>
                  </td>
                  <td className="num">{f.accountCount}</td>
                  <td>{f.cursorPresent ? "yes" : <span className="sub">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>BC webhook subscriptions</h2>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>Resource</th>
              <th>Subscription</th>
              <th>Expires</th>
              <th>Last renewed</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {d.subscriptions.length === 0 ? (
              <tr>
                <td colSpan={5} className="sub">
                  No subscriptions yet. The daily webhook-renewal job creates them once the BC connection is live.
                </td>
              </tr>
            ) : null}
            {d.subscriptions.map((s) => (
              <tr key={s.resource}>
                <td>{s.resource}</td>
                <td className="mono">{s.subscriptionId}</td>
                <td>{dateTime(s.expiresAt)}</td>
                <td>{dateTime(s.lastRenewedAt)}</td>
                <td>{s.needsRenewal ? <Tag tone="action">renewal due</Tag> : <Tag tone="good">active</Tag>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Runs() {
  const [kind, setKind] = useState<SyncRunSummary["kind"] | "">("");
  const [status, setStatus] = useState<SyncRunSummary["status"] | "">("");
  const [page, setPage] = useState(1);
  const q = useSyncRuns({ kind: kind || undefined, status: status || undefined, page, pageSize: 25 });
  return (
    <>
      <div className="toolbar">
        <label className="field">
          Kind
          <select value={kind} onChange={(e) => { setKind(e.target.value as SyncRunSummary["kind"] | ""); setPage(1); }} aria-label="Run kind">
            <option value="">All</option>
            {RUN_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Status
          <select value={status} onChange={(e) => { setStatus(e.target.value as SyncRunSummary["status"] | ""); setPage(1); }} aria-label="Run status">
            <option value="">All</option>
            <option value="ok">ok</option>
            <option value="failed">failed</option>
            <option value="running">running</option>
          </select>
        </label>
      </div>
      {q.isLoading ? <Loading what="Loading sync runs" /> : q.error ? <ErrorNotice error={q.error} /> : null}
      {q.data ? (
        <>
          <div className="table-wrap">
            <table className="data" data-testid="runs-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Counts</th>
                  <th>Error (scrubbed)</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((r) => {
                  const sv = syncRunStatusView(r.status);
                  const dur = r.finishedAt ? Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)) : undefined;
                  return (
                    <tr key={r.id}>
                      <td>
                        {dateTime(r.startedAt)}
                        <span className="sub">{ago(r.startedAt)}</span>
                      </td>
                      <td>{r.kind}</td>
                      <td>
                        <Tag tone={sv.tone}>{sv.label}</Tag>
                      </td>
                      <td>{dur === undefined ? "running" : `${Math.abs(dur)} s`}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {Object.entries(r.counts)
                          .map(([k, v]) => `${k} ${v}`)
                          .join(" · ") || "—"}
                      </td>
                      <td>{r.error ?? <span className="sub">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
        </>
      ) : null}
    </>
  );
}

function FailedJobs({ say }: { say: (m: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const q = useOutbox(showAll ? { pageSize: 50 } : { deadLettered: true, pageSize: 50 });
  const retry = useRetryOutbox();
  return (
    <>
      <div className="notice" style={{ marginBottom: 10 }}>
        A dead-lettered outbox row is a BC write (or budget write) that got a non-retryable reply. Retry re-runs the pre-write check first, so a retry can never create a second line: if the External Document No. already exists in BC, the worker records the found IDs and moves on.
      </div>
      <div className="toolbar">
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show the whole outbox
        </label>
      </div>
      {q.isLoading ? <Loading what="Loading the outbox" /> : q.error ? <ErrorNotice error={q.error} /> : null}
      {q.data ? (
        q.data.items.length === 0 ? (
          <div className="empty">
            <strong>No failed jobs.</strong>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data" data-testid="outbox-table">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Aggregate</th>
                  <th>Operation</th>
                  <th className="num">Attempts</th>
                  <th>Next attempt</th>
                  <th>Last error</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      {dateTime(o.createdAt)}
                      <span className="sub mono">{o.id}</span>
                    </td>
                    <td>
                      {o.aggregate}
                      <span className="sub mono">{o.aggregateId}</span>
                    </td>
                    <td className="mono">{o.operation}</td>
                    <td className="num">{o.attempts}</td>
                    <td>{o.completedAt ? "—" : dateTime(o.nextAttemptAt)}</td>
                    <td>{o.lastError ?? <span className="sub">—</span>}</td>
                    <td>{o.deadLettered ? <Tag tone="action">dead letter</Tag> : o.completedAt ? <Tag tone="good">done</Tag> : o.publishedAt ? <Tag tone="neutral">published</Tag> : <Tag tone="neutral">queued</Tag>}</td>
                    <td className="actions">
                      {o.deadLettered ? (
                        <button type="button" className="btn small primary" disabled={retry.isPending} onClick={() => retry.mutate(o.id, { onSuccess: () => say("Requeued; the worker re-runs the pre-write check before writing."), onError: (e) => say(errorMessage(e)) })}>
                          Retry
                        </button>
                      ) : null}
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

function Audit() {
  const [entity, setEntity] = useState("");
  const [entityId, setEntityId] = useState("");
  const [page, setPage] = useState(1);
  const q = useAudit({ entity: entity || undefined, entityId: entityId || undefined, page, pageSize: 25 });
  return (
    <>
      <div className="toolbar">
        <label className="field">
          Entity
          <select value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }} aria-label="Entity">
            <option value="">All</option>
            {AUDIT_ENTITIES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Entity id
          <input type="text" value={entityId} onChange={(e) => { setEntityId(e.target.value); setPage(1); }} aria-label="Entity id" placeholder="transaction id, FEEDS, …" />
        </label>
        <span className="spacer" />
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Append-only: the database role cannot update or delete rows here.</span>
      </div>
      {q.isLoading ? <Loading what="Loading the audit log" /> : q.error ? <ErrorNotice error={q.error} /> : null}
      {q.data ? (
        <>
          <div className="table-wrap">
            <table className="data" data-testid="audit-table">
              <thead>
                <tr>
                  <th>At</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {dateTime(a.at)}
                      <span className="sub">{ago(a.at)}</span>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {a.actor}
                    </td>
                    <td className="mono">{a.action}</td>
                    <td>
                      {a.entity}
                      <span className="sub mono">{a.entityId}</span>
                    </td>
                    <td>
                      <JsonDetails label="before" value={a.before} />
                    </td>
                    <td>
                      <JsonDetails label="after" value={a.after} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
        </>
      ) : null}
    </>
  );
}

function durationOf(a: { id: string; durationMs?: number }): string {
  return typeof a.durationMs === "number" && a.durationMs > 0 ? `${Math.round(a.durationMs / 1000)} s` : "—";
}

function Nightly() {
  const q = useHealthReport();
  if (q.isLoading) return <Loading what="Reading the nightly result" />;
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) {
    return (
      <div className="empty" data-testid="nightly-empty">
        <strong>No nightly run yet.</strong>
        The sandbox-acceptance job in CI writes <code>health.json</code> next to this app after A1–A9 run against the BC sandbox. It needs the sandbox secrets as repository secrets first.
      </div>
    );
  }
  const r = q.data;
  const failed = r.acceptance.filter((a) => a.status === "fail").length;
  return (
    <>
      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <div className="card stat">
          <span className="label">Last run</span>
          <span className="value small">{ago(r.generatedAt)}</span>
          <span className="sub">
            {dateTime(r.generatedAt)} · {r.environment} · {r.commit ?? "—"}
          </span>
        </div>
        <div className="card stat">
          <span className="label">Acceptance A1–A9</span>
          <span className="value" style={{ color: failed > 0 ? "var(--action)" : "var(--good)" }}>
            {r.acceptance.filter((a) => a.status === "pass").length} / {r.acceptance.length}
          </span>
          <span className="sub">{failed > 0 ? `${failed} failing` : "all passing or skipped"}</span>
        </div>
        <div className="card stat">
          <span className="label">Nightly poll differences</span>
          <span className="value" style={{ color: (r.nightlyPoll?.differences ?? 0) > 0 ? "var(--action)" : undefined }}>
            {r.nightlyPoll?.differences ?? "—"}
          </span>
          <span className="sub">{r.nightlyPoll ? dateTime(r.nightlyPoll.ranAt) : "not run"}</span>
        </div>
      </div>
      <div className="card">
        <table className="data" data-testid="nightly-table">
          <thead>
            <tr>
              <th>Test</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {[...r.acceptance, ...(r.resilience ?? [])].map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.id}</strong> · {a.name}
                </td>
                <td>
                  <Tag tone={a.status === "pass" ? "good" : a.status === "fail" ? "action" : "muted"}>{a.status}</Tag>
                </td>
                <td>{durationOf(a)}</td>
                <td>{a.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
