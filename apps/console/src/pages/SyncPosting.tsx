import { useState } from "react";
import type { BatchStatus, BcBatch } from "@homestead/shared";
import { useOutbox, usePostBatch, useSyncStatus } from "../api/hooks";
import { Dialog, ErrorNotice, Loading, PageHead, Tag, useToast } from "../components/ui";
import { ago, dateTime, money } from "../lib/format";
import { bcJournalBatchUrl, bcJournalUrl, bcLinksConfigured } from "../lib/bcLinks";
import { freshnessTone } from "../lib/status";

const BATCH_NOTES: Record<BcBatch, string> = {
  FEEDS: "Approved bank-feed and file lines, and paycheck documents. Cade posts.",
  RECEIPTS: "Receipt-split documents (one document per receipt, one line per category). Cade posts.",
  AUTOPOST: "Lines approved by an auto-post rule (R1–R7). The AUTOPOST job posts hourly once the household switch is on.",
};

export function SyncPosting() {
  const sync = useSyncStatus();
  const dead = useOutbox({ deadLettered: true, pageSize: 5 });
  const post = usePostBatch();
  const [confirm, setConfirm] = useState<BatchStatus | null>(null);
  const [toast, say] = useToast();

  async function doPost() {
    if (!confirm) return;
    try {
      const r = await post.mutateAsync(confirm.batch);
      say(`Post request queued for HHAPP/${r.batch} (${r.lineCount} lines, outbox ${r.outboxId}).`);
      setConfirm(null);
    } catch (err) {
      say(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <PageHead
        title="BC sync and posting"
        lede="Every line's state on both sides. The app writes drafts; posting happens in BC, under Cade's own sign-in, or by the AUTOPOST job for rule-approved lines. The nightly poll is the completeness guarantee; the webhook only makes things faster."
        dataThrough={sync.data?.dataThrough}
        right={
          bcLinksConfigured() ? (
            <a className="btn" href={bcJournalUrl()} target="_blank" rel="noreferrer">
              Open HHAPP journal in BC
            </a>
          ) : (
            <span className="tag muted plain" title="Set VITE_BC_TENANT and VITE_BC_COMPANY">
              BC links not configured
            </span>
          )
        }
      />
      {sync.isLoading ? <Loading what="Reading sync status" /> : sync.error ? <ErrorNotice error={sync.error} /> : null}
      {sync.data ? (
        <>
          <div className="grid cols-4" style={{ marginBottom: 14 }}>
            <div className="card stat">
              <span className="label">Last webhook</span>
              <span className="value small">{ago(sync.data.lastWebhookAt)}</span>
              <span className="sub">{dateTime(sync.data.lastWebhookAt)}</span>
            </div>
            <div className="card stat">
              <span className="label">Last poll</span>
              <span className="value small">
                {ago(sync.data.lastPollAt)} <Tag tone={sync.data.lastPollStatus === "failed" ? "action" : freshnessTone(sync.data.lastPollAt, 30)}>{sync.data.lastPollStatus ?? "—"}</Tag>
              </span>
              <span className="sub">Nightly at 2:00 am Mountain · compares count and sum by batch and date for 45 days</span>
            </div>
            <div className="card stat">
              <span className="label">Outbox depth</span>
              <span className="value">{sync.data.outbox.depth}</span>
              <span className="sub">{sync.data.outbox.oldestPendingAt ? `oldest ${ago(sync.data.outbox.oldestPendingAt)}` : "nothing waiting"}</span>
            </div>
            <div className="card stat">
              <span className="label">Dead letters</span>
              <span className="value" style={{ color: sync.data.outbox.deadLetters > 0 ? "var(--action)" : undefined }}>
                {sync.data.outbox.deadLetters}
              </span>
              <span className="sub">Non-retryable BC replies; each one raised an Exception. Retry from Health.</span>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Journal batches (HHAPP)</h2>
              <span className="hint">Auto-post switch: {sync.data.autoPostEnabled ? <Tag tone="watch">on</Tag> : <Tag tone="neutral">off</Tag>}</span>
            </div>
            <div className="table-wrap" style={{ maxHeight: "none" }}>
              <table className="data" data-testid="batches-table">
                <thead>
                  <tr>
                    <th>Batch</th>
                    <th className="num">Drafts (app)</th>
                    <th className="num">Drafts (BC)</th>
                    <th className="num">In flight</th>
                    <th className="num">Differences</th>
                    <th>Last post request</th>
                    <th>Last posted</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sync.data.batches.map((b) => {
                    const mismatch = b.bcDraftCount !== undefined && (b.bcDraftCount !== b.appDraftCount || (b.bcDraftSumCents !== undefined && b.bcDraftSumCents !== b.appDraftSumCents));
                    return (
                      <tr key={b.batch}>
                        <td>
                          <strong>HHAPP/{b.batch}</strong>
                          <span className="sub">{BATCH_NOTES[b.batch]}</span>
                        </td>
                        <td className="num">
                          {b.appDraftCount}
                          <span className="sub">{money(b.appDraftSumCents)}</span>
                        </td>
                        <td className="num">
                          {b.bcDraftCount ?? "—"}
                          <span className="sub">{b.bcDraftSumCents !== undefined ? money(b.bcDraftSumCents) : "not polled"}</span>
                          {mismatch ? (
                            <span className="sub">
                              <Tag tone="action">differs</Tag>
                            </span>
                          ) : null}
                        </td>
                        <td className="num">{b.inFlightCount}</td>
                        <td className="num">{b.differenceCount > 0 ? <Tag tone="action">{b.differenceCount}</Tag> : 0}</td>
                        <td>{b.lastPostRequestedAt ? dateTime(b.lastPostRequestedAt) : "—"}</td>
                        <td>{b.lastPostedAt ? dateTime(b.lastPostedAt) : "—"}</td>
                        <td className="actions">
                          <button type="button" className="btn small primary" disabled={b.appDraftCount === 0 || post.isPending} onClick={() => setConfirm(b)} data-testid={`post-${b.batch}`}>
                            Post batch
                          </button>{" "}
                          {bcLinksConfigured() ? (
                            <a className="btn small" href={bcJournalBatchUrl(b.batch)} target="_blank" rel="noreferrer">
                              Open in BC
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p style={{ marginTop: 10, color: "var(--muted)", fontSize: 12.5 }}>
              <strong>Post batch</strong> only queues the request. The API has no posting right of its own: HHAPP/FEEDS and HHAPP/RECEIPTS post with Cade's BC sign-in (in BC, or when the queued request runs under his delegated session), and HHAPP/AUTOPOST posts by the hourly job under permission set HH-APP once an auto-post rule is approved. After posting, the webhook or the nightly poll reads the G/L entries back by External Document No. and the lines move to Posted.
            </p>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Webhook subscriptions</h2>
              <span className="hint">Expire after three days; renewed daily; recreated after any environment update</span>
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
                {sync.data.subscriptions.map((s) => (
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

          {dead.data && dead.data.items.length > 0 ? (
            <div className="card">
              <div className="card-head">
                <h2>Recent dead letters</h2>
                <a className="hint" href="/health?tab=jobs">
                  All failed jobs and retry →
                </a>
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {dead.data.items.map((o) => (
                  <li key={o.id}>
                    <code>{o.operation}</code> on {o.aggregate} <code>{o.aggregateId}</code> after {o.attempts} attempts · {o.lastError ?? "no error text"} · {ago(o.createdAt)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      <Dialog
        open={confirm !== null}
        title={`Post HHAPP/${confirm?.batch ?? ""}`}
        onClose={() => setConfirm(null)}
        testId="post-dialog"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirm(null)} disabled={post.isPending}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void doPost()} disabled={post.isPending} data-testid="post-confirm">
              Queue the post request
            </button>
          </>
        }
      >
        {confirm ? (
          <>
            <p>
              This queues a request to post <strong>{confirm.appDraftCount} draft lines</strong> ({money(confirm.appDraftSumCents)}) in HHAPP/{confirm.batch}. The whole batch posts at once; only approved drafts are in it.
            </p>
            {confirm.bcDraftCount !== undefined && confirm.bcDraftCount !== confirm.appDraftCount ? (
              <div className="notice action">BC reports {confirm.bcDraftCount} lines in this batch; the app expects {confirm.appDraftCount}. Resolve the difference in the Exceptions queue before posting, or post in BC where you can see every line.</div>
            ) : null}
            <div className="notice">
              {confirm.batch === "AUTOPOST" ? "The AUTOPOST job posts this batch on its hourly schedule when the household switch is on; queuing a request here asks it to run at its next tick." : "Posting runs with your BC sign-in, not the API's identity. If the queued request cannot run under your session, post the batch in BC; the poll will read the entries back either way."}
            </div>
          </>
        ) : null}
      </Dialog>
      {toast}
    </>
  );
}
