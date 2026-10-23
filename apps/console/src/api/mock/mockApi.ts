/**
 * In-memory ConsoleApi for VITE_API_MODE=mock. Mutations follow the same rules as the real API: the state
 * machine from @homestead/shared (assertTransition), an audit row per change, and an outbox row for anything
 * bound for BC. Nothing here talks to a network.
 */
import {
  assertTransition,
  plainStatus,
  BANK_CARD_LIST,
  CATEGORIES,
  type AccountSummary,
  type Actor,
  type FeedConnectionSummary,
  type AuditEntry,
  type BcBatch,
  type ConsolePage,
  type ConsoleTransactionRow,
  type DataThrough,
  type ExceptionResolution,
  type OutboxItem,
  type RuleSummary,
  type SyncStatus,
  type TransactionState,
} from "@homestead/shared";
import { ApiError, type BankLoginAccount, type ConsoleApi, type PageQuery } from "../types";
import * as data from "./data";

const latency = () => new Promise<void>((r) => setTimeout(r, 120 + Math.random() * 180));

function page<T>(items: readonly T[], q: PageQuery | undefined, dataThrough: DataThrough): ConsolePage<T> {
  const pageSize = q?.pageSize ?? 50;
  const pageNo = q?.page ?? 1;
  const start = (pageNo - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page: pageNo, pageSize, dataThrough };
}

/** What the mock Link "returns" (lib/plaidLink.ts mockOpenLink uses the same list). */
export const mockLinkAccounts: BankLoginAccount[] = [
  { plaidAccountId: "pa-frontier-share", name: "Primary Share", mask: "7003", type: "depository", subtype: "savings" },
  { plaidAccountId: "pa-frontier-auto", name: "Auto Loan", mask: "0001", type: "loan", subtype: "auto" },
];

export function createMockApi(): ConsoleApi {
  const tx = data.transactions.map((t) => ({ ...t, splits: [...t.splits] }));
  const receipts = data.receipts.map((r) => ({ ...r }));
  const rules = data.rules.map((r) => ({ ...r }));
  const outbox = data.outbox.map((o) => ({ ...o }));
  const audit = data.auditLog.map((a) => ({ ...a }));
  const proposals: { approvalId: string; categoryId: string; requestedBy: string; requestedAt: string }[] = [];
  // Bank logins: the household's accounts (one per bank card) and which Plaid login feeds each.
  const feeds: FeedConnectionSummary[] = data.feeds.map((f) => ({ ...f }));
  const plaidFeedOf: Record<string, string> = { "BEEHIVE-CHK": "feed-beehive", "BEEHIVE-CHK2": "feed-beehive", "BEEHIVE-SAV": "feed-beehive", VENMO: "feed-venmo", "AFCU-CHK": "feed-afcu", "AFCU-SAV": "feed-afcu", "AFCU-VISA": "feed-afcu", "AFCU-ODL": "feed-afcu", "MACU-CHK": "feed-macu", "MACU-SAV": "feed-macu", "CAPONE-CC": "feed-capone" };
  const plaidKind = (kind: string): Pick<BankLoginAccount, "type" | "subtype"> =>
    kind === "card" ? { type: "credit", subtype: "credit card" } : kind === "line" ? { type: "credit", subtype: "line of credit" } : kind === "checking" ? { type: "depository", subtype: "checking" } : { type: "depository", subtype: kind === "wallet" ? "paypal" : "savings" };
  const accts = BANK_CARD_LIST.map((b) => ({ id: `acct-${b.code}`, code: b.code, displayName: b.name, institution: b.institution, kind: b.kind, mask: b.mask, feedId: plaidFeedOf[b.code] as string | undefined, plaidAccountId: plaidFeedOf[b.code] ? `pa-${b.code}` : undefined }));
  const itemAccounts = new Map<string, BankLoginAccount[]>();
  for (const a of accts) {
    if (!a.feedId) continue;
    itemAccounts.set(a.feedId, [...(itemAccounts.get(a.feedId) ?? []), { plaidAccountId: a.plaidAccountId!, name: a.displayName, mask: a.mask.replace(/\D/g, "").slice(-4) || null, ...plaidKind(a.kind) }]);
  }
  const liveFeed = (feedId: string) => {
    const f = feeds.find((x) => x.id === feedId && x.provider === "plaid" && x.status !== "disabled");
    if (!f) throw new ApiError(404, "not_found", "That connection was not found.");
    return f;
  };
  const ownFeed = (feedId: string, action: string) => {
    const f = liveFeed(feedId);
    if (f.ownerMemberId !== data.CADE_ID) throw new ApiError(400, "owner_only", `Only the person who connected this login can ${action}`);
    return f;
  };
  const checkLinks = (links: readonly { accountId: string; plaidAccountId: string }[], feedId?: string) => {
    if (new Set(links.map((l) => l.accountId)).size !== links.length) throw new ApiError(400, "duplicate_account", "Each household account can take one bank account");
    if (new Set(links.map((l) => l.plaidAccountId)).size !== links.length) throw new ApiError(400, "duplicate_plaid_account", "Each bank account can feed one household account");
    for (const l of links) {
      const a = accts.find((x) => x.id === l.accountId);
      if (!a) throw new ApiError(400, "unknown_account", "One of those accounts is not in this household");
      const other = a.feedId && a.feedId !== feedId ? feeds.find((f) => f.id === a.feedId && f.status !== "disabled") : undefined;
      if (other) throw new ApiError(409, "account_already_connected", `${a.displayName} is already connected through ${other.institutionName}; remove that login first`);
    }
  };
  const recount = () => {
    for (const f of feeds) if (f.provider === "plaid") f.accountCount = accts.filter((a) => a.feedId === f.id).length;
  };
  let lastPostRequested: Partial<Record<BcBatch, string>> = {};
  let seq = 100;

  const pendingCount = () => tx.filter((t) => !["posted", "reconciled", "reversed", "dropped"].includes(t.state)).length;
  const through = (quality: DataThrough["quality"] = "imported_pending", msAgo = 20 * 60_000): DataThrough => ({ at: data.iso(msAgo), quality, pendingCount: pendingCount() });

  function find(id: string): ConsoleTransactionRow {
    const t = tx.find((x) => x.id === id);
    if (!t) throw new ApiError(404, "not_found", `No transaction ${id}`);
    return t;
  }
  function record(a: Omit<AuditEntry, "id" | "at">): void {
    audit.unshift({ id: `aud-${seq++}`, at: new Date().toISOString(), ...a });
  }
  function move(t: ConsoleTransactionRow, to: TransactionState, actor: AuditEntry["actor"], action: string, extra?: Record<string, unknown>, as?: Actor): void {
    assertTransition(t.state, to, as ?? (actor === data.CADE_ID ? "cade" : "member"));
    const before = { state: t.state, ...extra };
    t.state = to;
    t.status = plainStatus(to);
    t.updatedAt = new Date().toISOString();
    record({ actor, action, entity: "transaction", entityId: t.id, before, after: { state: to, ...extra } });
  }
  function enqueue(t: ConsoleTransactionRow): void {
    outbox.unshift({
      id: `ob-${seq++}`,
      aggregate: "transaction",
      aggregateId: t.id,
      operation: "send_to_bc",
      attempts: 0,
      nextAttemptAt: new Date().toISOString(),
      deadLettered: false,
      createdAt: new Date().toISOString(),
    });
  }

  const api: ConsoleApi = {
    async me() {
      await latency();
      return data.me;
    },

    async transactions(queue, q) {
      await latency();
      const items = tx.filter((t) => t.state === queue).sort((a, b) => (a.postedDate < b.postedDate ? 1 : -1));
      return page(items, q, through());
    },

    async approveTransactions(ids) {
      await latency();
      const skipped: { id: string; reason: string }[] = [];
      let approved = 0;
      for (const id of ids) {
        const t = tx.find((x) => x.id === id);
        if (!t) {
          skipped.push({ id, reason: "not found" });
          continue;
        }
        if (t.state !== "ready_for_review") {
          skipped.push({ id, reason: `state is ${t.state}` });
          continue;
        }
        if (!t.categoryId) {
          skipped.push({ id, reason: "no category chosen" });
          continue;
        }
        move(t, "approved", data.CADE_ID, "transaction.approve", { categoryId: t.categoryId });
        enqueue(t);
        approved += 1;
      }
      return { approved, skipped };
    },

    async correctTransaction(id, input) {
      await latency();
      const t = find(id);
      const cat = CATEGORIES.find((c) => c.id === input.categoryId);
      if (!cat) throw new ApiError(400, "unknown_category");
      const before = { categoryId: t.categoryId, state: t.state };
      if (["posted", "reconciled"].includes(t.state)) {
        // After posting: a correction request to the CFO queue; the posted entry is immutable.
        const correctionRequestId = `appr-${seq++}`;
        record({ actor: data.CADE_ID, action: "correction.requested", entity: "approval", entityId: correctionRequestId, before, after: { transactionId: t.id, categoryId: cat.id, reason: input.note } });
        return { ...t, correctionRequestId };
      }
      t.categoryId = cat.id;
      t.categoryName = cat.name;
      t.dims = cat.dims;
      t.splits = [{ lineNo: 1, amountCents: t.amountCents, categoryId: cat.id, glAccount: cat.glAccount, dims: cat.dims }];
      // A person's pick on a needs_classification item is the rule engine's input: the API's classifyOne moves it
      // to ready_for_review as rule_engine (the state machine allows no person transition out of needs_classification).
      if (t.state === "needs_classification") move(t, "ready_for_review", "jobs:rule_engine", "transaction.classify", { categoryId: cat.id, pickedBy: data.CADE_ID }, "rule_engine");
      else record({ actor: data.CADE_ID, action: "transaction.correct", entity: "transaction", entityId: t.id, before, after: { categoryId: cat.id } });
      if (input.makeRule) {
        rules.unshift({
          id: `rule-${seq++}`,
          kind: "merchant",
          name: `${t.merchantNorm.split(" ").slice(0, 2).join(" ")} → ${cat.name}`,
          match: { merchant: t.merchantNorm, amountBandCents: { min: Math.round(Math.abs(t.amountCents) * 0.95) - 500, max: Math.round(Math.abs(t.amountCents) * 1.05) + 500 } },
          action: { category: cat.id },
          mayAutoPost: false,
          state: "proposed",
          proposedBy: data.CADE_ID,
          proposedByName: "Cade",
          version: 1,
          stats: { fired: 0, corrected: 0 },
        });
      }
      return t;
    },

    async setBusinessFlag(id, flag) {
      await latency();
      const t = find(id);
      const before = t.businessFlag;
      t.businessFlag = flag;
      t.updatedAt = new Date().toISOString();
      record({ actor: data.CADE_ID, action: "transaction.business_flag", entity: "transaction", entityId: t.id, before: { businessFlag: before }, after: { businessFlag: flag } });
      return t;
    },

    async resolveDuplicate(id, decision) {
      await latency();
      const t = find(id);
      if (decision === "same_thing") move(t, "dropped", data.CADE_ID, "duplicate.same_thing", { duplicateOfId: t.duplicateOfId });
      else move(t, t.receiptStatus === "needed" ? "needs_receipt" : "needs_classification", data.CADE_ID, "duplicate.not_a_repeat");
      return t;
    },

    async resolveException(id, resolution) {
      await latency();
      const t = find(id);
      if (t.state !== "exception") throw new ApiError(409, "not_an_exception");
      if (!resolution.note.trim()) throw new ApiError(400, "note_required", "A resolution needs a note; it is recorded with the keys on both sides.");
      if (resolution.to === "posted") {
        if (!resolution.bcEntryNos.length) throw new ApiError(400, "entry_nos_required", "Resolving against an existing BC entry needs its entry number(s).");
        t.bc = { ...(t.bc ?? { externalDocumentNo: t.idempotencyKey }), entryNos: [...resolution.bcEntryNos], documentNo: resolution.bcDocumentNo, postingDate: resolution.bcPostingDate ?? t.postedDate, syncStatus: "in_sync", lastSyncAt: new Date().toISOString() };
        delete t.bc.difference;
      } else if (t.bc) {
        t.bc.syncStatus = "pending";
        delete t.bc.difference;
      }
      const ex = t.exception;
      delete t.exception;
      move(t, resolution.to, data.CADE_ID, "exception.resolve", { note: resolution.note, appKey: ex?.appSide.idempotencyKey, bcEntryNos: resolution.to === "posted" ? resolution.bcEntryNos : undefined });
      return t;
    },

    async receipts(status, q) {
      await latency();
      const items = receipts.filter((r) => (status === "unmatched" ? !r.matchedTransactionId && r.ocrStatus !== "needs_review" && r.ocrStatus !== "failed" : r.ocrStatus === "needs_review" || r.ocrStatus === "failed" || (r.candidates?.length ?? 0) > 1));
      return page(items, q, through());
    },

    async matchReceipt(receiptId, transactionId) {
      await latency();
      const r = receipts.find((x) => x.id === receiptId);
      if (!r) throw new ApiError(404, "not_found");
      const t = find(transactionId);
      r.matchedTransactionId = t.id;
      r.matchConfidence = 1;
      t.receiptId = r.id;
      t.receiptStatus = "matched";
      if (t.state === "needs_receipt") move(t, "needs_classification", data.CADE_ID, "receipt.match", { receiptId: r.id });
      else record({ actor: data.CADE_ID, action: "receipt.match", entity: "receipt", entityId: r.id, after: { transactionId: t.id } });
      return r;
    },

    async rules(state, q) {
      await latency();
      return page(
        rules.filter((r) => r.state === state),
        q,
        through("posted_unreconciled"),
      );
    },

    async decideRule(id, decision, note) {
      await latency();
      const r = rules.find((x) => x.id === id);
      if (!r) throw new ApiError(404, "not_found");
      if (decision === "approve" && r.proposedBy === data.CADE_ID) throw new ApiError(403, "other_spouse_decides", "The spouse who did not propose a rule approves it.");
      const before = r.state;
      if (decision === "approve") {
        r.state = "approved";
        r.approvedBy = data.CADE_ID;
        r.approvedAt = new Date().toISOString();
        r.effectiveFrom = new Date().toISOString().slice(0, 10);
      } else if (decision === "retire") r.state = "retired";
      else r.state = "retired";
      record({ actor: data.CADE_ID, action: `rule.${decision}`, entity: "rule", entityId: r.id, before: { state: before }, after: { state: r.state, note, stepUp: true } });
      return r;
    },

    async syncStatus(): Promise<SyncStatus> {
      await latency();
      const batches = (["FEEDS", "RECEIPTS", "AUTOPOST"] as BcBatch[]).map((batch) => {
        const drafts = tx.filter((t) => t.state === "bc_draft_created" && t.bc?.batch === batch);
        const inFlight = tx.filter((t) => (t.state === "sent_to_bc" || t.state === "approved") && (t.bc?.batch === batch || (batch === "FEEDS" && !t.bc?.batch && t.receiptStatus !== "matched") || (batch === "RECEIPTS" && !t.bc?.batch && t.receiptStatus === "matched")));
        const differences = tx.filter((t) => t.state === "exception" && t.bc?.batch === batch);
        const appSum = drafts.reduce((n, t) => n + t.amountCents, 0);
        return {
          batch,
          journalId: `journal-${batch.toLowerCase()}`,
          appDraftCount: drafts.length,
          appDraftSumCents: appSum,
          bcDraftCount: batch === "FEEDS" ? drafts.length + 1 : drafts.length,
          bcDraftSumCents: batch === "FEEDS" ? appSum - 4210 : appSum,
          inFlightCount: inFlight.length,
          differenceCount: differences.length,
          lastPostRequestedAt: lastPostRequested[batch],
          lastPostedAt: batch === "AUTOPOST" ? undefined : data.iso(24 * 3_600_000 * (batch === "FEEDS" ? 1 : 2)),
        };
      });
      return {
        batches,
        lastWebhookAt: data.iso(5 * 3_600_000),
        lastPollAt: data.iso(12 * 3_600_000),
        lastPollStatus: "ok",
        outbox: {
          depth: outbox.filter((o) => !o.completedAt && !o.deadLettered).length,
          deadLetters: outbox.filter((o) => o.deadLettered).length,
          oldestPendingAt: outbox.filter((o) => !o.completedAt && !o.deadLettered).map((o) => o.createdAt).sort()[0],
        },
        subscriptions: data.subscriptions,
        autoPostEnabled: false,
        dataThrough: through("posted_unreconciled", 5 * 3_600_000),
      };
    },

    async postBatch(batch) {
      await latency();
      const lines = tx.filter((t) => t.state === "bc_draft_created" && t.bc?.batch === batch);
      if (lines.length === 0) throw new ApiError(409, "nothing_to_post", `HHAPP/${batch} has no app drafts to post.`);
      const now = new Date().toISOString();
      lastPostRequested = { ...lastPostRequested, [batch]: now };
      const id = `ob-${seq++}`;
      outbox.unshift({ id, aggregate: "household", aggregateId: data.HOUSEHOLD_ID, operation: "post_batch", attempts: 0, nextAttemptAt: now, deadLettered: false, createdAt: now });
      record({ actor: data.CADE_ID, action: "post.requested", entity: "batch", entityId: batch, after: { lineCount: lines.length, outboxId: id, stepUp: true } });
      // Same answer as the API (services/api/src/services/console.ts requestPostBatch); the mock's switch is off.
      const message =
        batch === "AUTOPOST"
          ? "Auto-posting is switched off for this household; the request is recorded and nothing is posted."
          : `Recorded. HHAPP/${batch} is posted under Cade's own BC sign-in (the app credential has no posting right there); the read-back marks the lines Posted.`;
      return { batch, outboxId: id, queuedAt: now, lineCount: lines.length, enqueued: false, message };
    },

    async reconciliation() {
      await latency();
      return { bankCards: data.reconciliationCards(), loans: data.loans, dataThrough: through("posted_unreconciled", 12 * 3_600_000) };
    },

    async mappings() {
      await latency();
      return { ...data.mappings, pendingProposals: [...proposals] };
    },

    async proposeMapping(input) {
      await latency();
      const approvalId = `appr-${seq++}`;
      proposals.push({ approvalId, categoryId: input.categoryId, requestedBy: "Cade", requestedAt: new Date().toISOString() });
      record({ actor: data.CADE_ID, action: "mapping.propose", entity: "approval", entityId: approvalId, after: { ...input } });
      return { approvalId };
    },

    async authority() {
      await latency();
      return data.authority;
    },

    async connections() {
      await latency();
      return {
        feeds: feeds.map((f) => ({ ...f })),
        subscriptions: data.subscriptions,
        ledger: { lastPollAt: data.iso(12 * 3_600_000), lastWebhookAt: data.iso(5 * 3_600_000), apiReachable: true, checkedAt: data.iso(10 * 60_000) },
        dataThrough: through("imported_pending", 10 * 60_000),
      };
    },

    async syncRuns(q) {
      await latency();
      const items = data.syncRuns.filter((r) => (!q?.kind || r.kind === q.kind) && (!q?.status || r.status === q.status)).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
      return page(items, q, through("imported_pending", 10 * 60_000));
    },

    async outbox(q) {
      await latency();
      const items = outbox.filter((o) => q?.deadLettered === undefined || o.deadLettered === q.deadLettered);
      return page(items, q, through("imported_pending", 60_000));
    },

    async retryOutbox(id) {
      await latency();
      const o = outbox.find((x) => x.id === id);
      if (!o) throw new ApiError(404, "not_found");
      if (!o.deadLettered) throw new ApiError(409, "not_dead_lettered", "Only a dead-lettered row can be retried");
      // As the API: a BC write whose line is now an exception is resolved, not retried (services/api console.ts).
      if (o.aggregate === "transaction" && o.operation === "send_to_bc" && tx.find((t) => t.id === o.aggregateId)?.state === "exception") {
        throw new ApiError(409, "resolve_exception_first", "This item is an exception. Resolve it to ready for review and approve it again; that sends it once more.");
      }
      const before: OutboxItem = { ...o };
      o.deadLettered = false;
      o.attempts = 0;
      o.nextAttemptAt = new Date().toISOString();
      o.lastError = undefined;
      record({ actor: data.CADE_ID, action: "outbox.retry", entity: "outbox", entityId: o.id, before: { attempts: before.attempts, deadLettered: true }, after: { attempts: 0, deadLettered: false } });
      return o;
    },

    async audit(q) {
      await latency();
      const items = audit.filter((a) => (!q?.entity || a.entity === q.entity) && (!q?.entityId || a.entityId === q.entityId) && (!q?.actor || a.actor === q.actor));
      return page(items, { page: q?.page, pageSize: q?.pageSize ?? 25 }, through("posted_unreconciled", 0));
    },

    async householdAccounts(): Promise<AccountSummary[]> {
      await latency();
      return accts.map((a) => {
        const f = a.feedId ? feeds.find((x) => x.id === a.feedId) : undefined;
        const feedStatus: AccountSummary["feedStatus"] = !f || f.status === "disabled" ? "none" : f.needsRelink ? "needs_relink" : f.status === "stale" ? "stale" : "ok";
        return { id: a.id, displayName: a.displayName, institution: a.institution, kind: a.kind as AccountSummary["kind"], mask: a.mask, bcBankAccountCode: a.code, feedStatus, ...(f && f.status !== "disabled" ? { feedConnectionId: f.id } : {}) };
      });
    },

    async confirmStepUp() {
      await latency();
    },

    async bankLinkToken() {
      await latency();
      return { linkToken: "link-mock-new", expiration: new Date(Date.now() + 4 * 3_600_000).toISOString() };
    },

    async linkBank(input) {
      await latency();
      if (!input.publicToken) throw new ApiError(400, "invalid_request", "publicToken is required");
      checkLinks(input.accounts);
      const id = `feed-${Math.random().toString(36).slice(2, 8)}`;
      feeds.push({ id, provider: "plaid", institutionName: input.institutionName ?? "Bank", ownerMemberId: data.CADE_ID, ownerName: "Cade", status: "ok", needsRelink: false, accountCount: input.accounts.length, cursorPresent: false });
      itemAccounts.set(id, mockLinkAccounts.map((a) => ({ ...a })));
      for (const l of input.accounts) {
        const a = accts.find((x) => x.id === l.accountId)!;
        a.feedId = id;
        a.plaidAccountId = l.plaidAccountId;
      }
      record({ actor: data.CADE_ID, action: "feed.linked", entity: "feed_connection", entityId: id, after: { provider: "plaid", institutionId: input.institutionId, owner: data.CADE_ID } });
      return { feedConnectionId: id, itemId: `item-${id}` };
    },

    async feedLinkToken(feedId) {
      await latency();
      ownFeed(feedId, "reconnect it");
      return { linkToken: `link-mock-update-${feedId}`, expiration: new Date(Date.now() + 4 * 3_600_000).toISOString() };
    },

    async feedReconnected(feedId) {
      await latency();
      const f = ownFeed(feedId, "reconnect it");
      // As the API: a sync is queued; the sync (here: at once) clears the re-link flag.
      f.needsRelink = false;
      f.status = "ok";
      f.lastSyncedAt = new Date().toISOString();
      record({ actor: data.CADE_ID, action: "feed.reconnected", entity: "feed_connection", entityId: feedId, after: { syncQueued: true } });
      return { syncQueued: true };
    },

    async feedAccounts(feedId) {
      await latency();
      const f = liveFeed(feedId);
      return {
        feedConnectionId: feedId,
        institutionName: f.institutionName,
        ownerMemberId: f.ownerMemberId ?? "",
        accounts: (itemAccounts.get(feedId) ?? []).map((p) => ({ ...p, accountId: accts.find((a) => a.feedId === feedId && a.plaidAccountId === p.plaidAccountId)?.id ?? null })),
      };
    },

    async setFeedAccounts(feedId, links) {
      await latency();
      ownFeed(feedId, "change its accounts");
      checkLinks(links, feedId);
      const known = new Set((itemAccounts.get(feedId) ?? []).map((p) => p.plaidAccountId));
      if (links.some((l) => !known.has(l.plaidAccountId))) throw new ApiError(400, "unknown_plaid_account", "That bank account is not part of this login");
      let attached = 0;
      let detached = 0;
      for (const a of accts.filter((x) => x.feedId === feedId)) {
        const keep = links.find((l) => l.accountId === a.id);
        if (keep?.plaidAccountId === a.plaidAccountId) continue;
        if (!keep) detached += 1;
        a.feedId = undefined;
        a.plaidAccountId = undefined;
      }
      for (const l of links) {
        const a = accts.find((x) => x.id === l.accountId)!;
        if (a.feedId === feedId && a.plaidAccountId === l.plaidAccountId) continue;
        a.feedId = feedId;
        a.plaidAccountId = l.plaidAccountId;
        attached += 1;
      }
      recount();
      record({ actor: data.CADE_ID, action: "feed.accounts_set", entity: "feed_connection", entityId: feedId, after: { accounts: links.map((l) => l.accountId), attached, detached, historyReplay: attached > 0 } });
      return { attached, detached, syncQueued: attached > 0 };
    },

    async unlinkFeed(feedId) {
      await latency();
      const f = ownFeed(feedId, "remove it");
      f.status = "disabled";
      f.needsRelink = false;
      let n = 0;
      for (const a of accts.filter((x) => x.feedId === feedId)) {
        a.feedId = undefined;
        a.plaidAccountId = undefined;
        n += 1;
      }
      recount();
      record({ actor: data.CADE_ID, action: "feed.unlinked", entity: "feed_connection", entityId: feedId, after: { plaid: "removed", accountsDetached: n } });
    },

    async healthReport() {
      await latency();
      return {
        generatedAt: data.iso(9 * 3_600_000),
        commit: "mock",
        environment: "dev (mock data)",
        acceptance: [
          { id: "A1", name: "Receipt to reconciled, no duplicates after retries", status: "pass", durationMs: 48_200 },
          { id: "A2", name: "Transfers, card and loan payments never show as spending", status: "pass", durationMs: 9_100 },
          { id: "A3", name: "Walmart receipt splits by line", status: "pass", durationMs: 22_400 },
          { id: "A4", name: "CTJ-paid personal bill lands in 404102", status: "pass", durationMs: 6_300 },
          { id: "A5", name: "Offline capture syncs cleanly", status: "skipped", note: "device test; runs in the Maestro suite" },
          { id: "A6", name: "Webhook outage caught by the poll", status: "pass", durationMs: 71_000 },
          { id: "A7", name: "Safe-to-spend excludes restricted funds", status: "pass", durationMs: 2_900 },
          { id: "A8", name: "Budget change needs the other spouse", status: "fail", note: "hhBudgetEntries write returned 403 on BUD26-REV2 (sandbox permission set)" },
          { id: "A9", name: "Everything ties to BC with data-through", status: "pass", durationMs: 15_800 },
        ],
        resilience: [
          { id: "R-batch", name: "Forced-failure batch leaves zero lines", status: "pass" },
          { id: "R-dup", name: "Duplicate import", status: "pass" },
          { id: "R-drift", name: "Rule drift ($600 at a rule merchant is asked)", status: "pass" },
        ],
        nightlyPoll: { ranAt: data.iso(12 * 3_600_000), differences: 3 },
      };
    },
  };
  return api;
}

export type RuleLike = RuleSummary;
