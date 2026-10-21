import { Link } from "react-router";
import { useConnections, useReconciliation, useSyncStatus, useTransactions } from "../api/hooks";
import { LATER_PAGES } from "../components/Shell";
import { PageHead, Tag } from "../components/ui";
import { ago } from "../lib/format";
import { freshnessTone } from "../lib/status";

export function Overview() {
  const ready = useTransactions("ready_for_review", { pageSize: 1 });
  const exceptions = useTransactions("exception", { pageSize: 1 });
  const dup = useTransactions("possible_duplicate", { pageSize: 1 });
  const needsClass = useTransactions("needs_classification", { pageSize: 1 });
  const needsReceipt = useTransactions("needs_receipt", { pageSize: 1 });
  const sync = useSyncStatus();
  const recon = useReconciliation();
  const conn = useConnections();

  const drafts = sync.data?.batches.reduce((n, b) => n + b.appDraftCount, 0);
  const differences = sync.data?.batches.reduce((n, b) => n + b.differenceCount, 0) ?? 0;
  const openRecon = recon.data?.bankCards.reduce((n, c) => n + c.openCount, 0);
  const reconDiffs = recon.data?.bankCards.reduce((n, c) => n + c.differences.length, 0) ?? 0;
  const relink = conn.data?.feeds.filter((f) => f.needsRelink).length ?? 0;
  const stale = conn.data?.feeds.filter((f) => f.status === "stale").length ?? 0;
  const renewals = conn.data?.subscriptions.filter((s) => s.needsRenewal).length ?? 0;

  return (
    <>
      <PageHead title="Overview" lede="The six MVP functions and what needs you now. Every number opens to its parts and its data-through date." dataThrough={sync.data?.dataThrough} />
      <div className="grid cols-3">
        <Link to="/queues" className="card tile">
          <div className="tile-title">
            1 · Work queues {(exceptions.data?.total ?? 0) > 0 ? <Tag tone="action">{exceptions.data?.total} exceptions</Tag> : (ready.data?.total ?? 0) > 0 ? <Tag tone="watch">{ready.data?.total} to review</Tag> : <Tag tone="good">Clear</Tag>}
          </div>
          <div className="tile-body">
            {ready.data?.total ?? "—"} ready for review · {needsClass.data?.total ?? "—"} need classification · {needsReceipt.data?.total ?? "—"} need a receipt · {dup.data?.total ?? "—"} possible duplicates
          </div>
          <div className="tile-foot">Transactions, receipts, rule proposals, exceptions</div>
        </Link>
        <Link to="/sync" className="card tile">
          <div className="tile-title">
            2 · BC sync and posting {differences > 0 ? <Tag tone="action">{differences} differences</Tag> : (sync.data?.outbox.deadLetters ?? 0) > 0 ? <Tag tone="action">{sync.data?.outbox.deadLetters} dead letters</Tag> : <Tag tone="good">In sync</Tag>}
          </div>
          <div className="tile-body">
            {drafts ?? "—"} drafts across FEEDS, RECEIPTS, AUTOPOST · outbox {sync.data?.outbox.depth ?? "—"} · last poll {ago(sync.data?.lastPollAt)} · last webhook {ago(sync.data?.lastWebhookAt)}
          </div>
          <div className="tile-foot">Post batch, outbox depth, dead letters, deep links into BC</div>
        </Link>
        <Link to="/reconciliation" className="card tile">
          <div className="tile-title">3 · Reconciliation {reconDiffs > 0 ? <Tag tone="watch">{reconDiffs} differences</Tag> : <Tag tone="good">No differences</Tag>}</div>
          <div className="tile-body">
            {openRecon ?? "—"} open bank ledger lines across {recon.data?.bankCards.length ?? 14} cards ·{" "}
            {recon.data?.missing?.includes("loans") ? "loan rollforwards not in the API yet" : `loans ${recon.data?.loans.filter((l) => l.matchedEntryNo).length ?? "—"} of ${recon.data?.loans.length ?? 3} matched this period`}
          </div>
          <div className="tile-foot">Per bank card, plus the Frontier and PennyMac rollforwards</div>
        </Link>
        <Link to="/mappings" className="card tile">
          <div className="tile-title">
            4 · Mappings <Tag tone="neutral">Read, propose</Tag>
          </div>
          <div className="tile-body">Household categories → G/L account and the five dimensions; dimension dictionary; bank cards; employers and paycheck components.</div>
          <div className="tile-foot">Changes go to the other spouse as a proposal; versions shown</div>
        </Link>
        <Link to="/authority" className="card tile">
          <div className="tile-title">
            11 · Authority matrix <Tag tone="watch">I-09 TBD</Tag>
          </div>
          <div className="tile-body">Who approves what, step-up requirements, which rules may auto-post. Read-only until approved in writing.</div>
          <div className="tile-foot">Household settings v1 (draft from the Phase 3 spec)</div>
        </Link>
        <Link to="/health" className="card tile">
          <div className="tile-title">
            12 · Health, logs and audit {relink + renewals > 0 ? <Tag tone="action">{relink > 0 ? `${relink} re-link` : ""}{relink > 0 && renewals > 0 ? " · " : ""}{renewals > 0 ? `${renewals} renewal` : ""}</Tag> : stale > 0 ? <Tag tone="watch">{stale} stale</Tag> : <Tag tone={freshnessTone(conn.data?.ledger.lastPollAt)}>OK</Tag>}
          </div>
          <div className="tile-body">Feed connections, BC subscriptions, sync runs, failed jobs with retry, the append-only audit log, and the nightly acceptance result.</div>
          <div className="tile-foot">Nothing here retries in a way that can duplicate a line</div>
        </Link>
      </div>
      <h2 style={{ margin: "22px 0 10px" }}>After the pilot</h2>
      <div className="grid cols-3">
        {LATER_PAGES.map((p) => (
          <Link key={p.to} to={p.to} className="card tile later">
            <div className="tile-title">
              {p.fn} · {p.label}
            </div>
            <div className="tile-body">{p.body}</div>
            <div className="tile-foot">After the pilot</div>
          </Link>
        ))}
      </div>
    </>
  );
}
