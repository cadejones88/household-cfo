/**
 * Read-back and the nightly poll (spec: "Idempotency and retries" items 6–7; "Webhooks and polling").
 *
 * readBackHousehold: for every draft the app holds, read the G/L entries by External Document No.; entries
 * found -> Posted with bc_entry_nos and the posting date. Bank ledger entries closed by BC's bank reconciliation
 * -> Reconciled. A G/L entry whose External Document No. starts with HHAPP- but matches no app transaction is
 * an exception (an alert to Cade with the keys on BC's side).
 *
 * nightlyPoll: the completeness guarantee. For every HHAPP document of the last 45 days compare the line count
 * (and, once posted, the debit sum) the app expects with what the ledger reports; any difference opens an
 * Exception with the keys on both sides. The webhook only makes things faster.
 */
import { isHomesteadDocumentNo } from "@homestead/shared";
import { audit, addDays, dateIsoInTz, getHousehold, linesFor, loadAccount, loadCategories, loadSplits, loadTx, raiseException, recordPosted, recordReconciled, type Deps, type Queryable, type TxRow } from "@homestead/api";

export interface ReadbackCounts {
  posted: number;
  reconciled: number;
  unknownDocuments: number;
  checked: number;
}

export async function readBackHousehold(db: Queryable, householdId: string, deps: Deps, now: Date, actor = "bc-readback"): Promise<ReadbackCounts> {
  const counts: ReadbackCounts = { posted: 0, reconciled: 0, unknownDocuments: 0, checked: 0 };
  const drafts = await db.query<{ id: string }>("select id from transactions where household_id = $1 and state in ('sent_to_bc','bc_draft_created') and bc_external_doc_no is not null order by posted_date", [householdId]);
  for (const { id } of drafts.rows) {
    const tx = await loadTx(db, id);
    counts.checked += 1;
    const entries = await deps.ledger.readGlEntriesByExternalDocNo({ externalDocumentNo: tx.bc_external_doc_no! });
    if (entries.length === 0) continue;
    if (tx.state === "sent_to_bc") continue; // the worker records the draft first; the poll handles the rest
    const first = entries[0]!;
    await recordPosted(db, householdId, tx.id, { entryNos: entries.map((e) => e.entryNo), postingDate: first.postingDate, ...(first.documentNo ? { documentNo: first.documentNo } : {}) }, "poll", actor);
    counts.posted += 1;
  }
  // Bank reconciliation state from the HH App Connector's bank ledger entries.
  const posted = await db.query<{ id: string }>("select id from transactions where household_id = $1 and state = 'posted' and bc_external_doc_no is not null and kind <> 'bc_native'", [householdId]);
  for (const { id } of posted.rows) {
    const tx = await loadTx(db, id);
    const acct = await loadAccount(db, tx.account_id);
    if (!acct.bc_bank_account_code) continue;
    const bank = await deps.ledger.readBankLedgerEntries({ bankAccountCode: acct.bc_bank_account_code, externalDocumentNo: tx.bc_external_doc_no! });
    const closed = bank.find((b) => !b.open && !b.reversed);
    if (closed) {
      await recordReconciled(db, householdId, tx.id, closed.entryNo, "poll", actor);
      counts.reconciled += 1;
    }
  }
  // Unknown HHAPP documents on BC's side.
  const hh = await getHousehold(db, householdId);
  const today = dateIsoInTz(now, hh.timezone);
  const all = await deps.ledger.readGlEntriesByExternalDocNo({ externalDocumentNoStartsWith: "HHAPP-", postingDateFrom: addDays(today, -45) });
  const docs = new Set(all.map((e) => e.externalDocumentNo));
  for (const doc of docs) {
    if (!isHomesteadDocumentNo(doc)) continue;
    const known = await db.query<{ id: string }>("select id from transactions where household_id = $1 and bc_external_doc_no = $2", [householdId, doc]);
    if (known.rows.length) continue;
    const entries = all.filter((e) => e.externalDocumentNo === doc);
    const fp = `bc_unknown_document:${doc}`;
    await db.query(
      "insert into alerts (household_id, member_id, kind, level, fingerprint, payload) values ($1,null,'bc_unknown_document','action',$2,$3) on conflict do nothing",
      [householdId, fp, JSON.stringify({ title: "A Homestead document in BC has no app record", body: `${doc} has ${entries.length} G/L entr${entries.length === 1 ? "y" : "ies"} dated ${entries[0]?.postingDate ?? "?"} that the app does not know. It is in the Console's exception queue.`, externalDocumentNo: doc, entryNos: entries.map((e) => e.entryNo), bcSide: { documentNo: entries[0]?.documentNo, postingDate: entries[0]?.postingDate, lineCount: entries.length } })],
    );
    await audit(db, householdId, { actor, action: "bc.unknown_document", entity: "bc_document", entityId: doc, after: { entryNos: entries.map((e) => e.entryNo) } });
    counts.unknownDocuments += 1;
  }
  await db.query("update ledger_connections set last_poll_at = $2 where household_id = $1", [householdId, now.toISOString()]);
  return counts;
}

export interface PollCounts extends ReadbackCounts {
  compared: number;
  differences: number;
  /** (batch, posting date) groups compared on count and debit sum, and how many differed. */
  batchDates: number;
  batchDateDifferences: number;
}

interface GroupTotals {
  count: number;
  debits: number;
  docs: Set<string>;
}

function addTo(map: Map<string, GroupTotals>, key: string, doc: string, amountCents: number): void {
  const g = map.get(key) ?? { count: 0, debits: 0, docs: new Set<string>() };
  g.count += 1;
  if (amountCents > 0) g.debits += amountCents;
  g.docs.add(doc);
  map.set(key, g);
}

/** Compare count and sum per document over 45 days; open an Exception with the keys on both sides for any difference. */
export async function nightlyPoll(db: Queryable, householdId: string, deps: Deps, now: Date, actor = "nightly-poll"): Promise<PollCounts> {
  const hh = await getHousehold(db, householdId);
  const today = dateIsoInTz(now, hh.timezone);
  const rb = await readBackHousehold(db, householdId, deps, now, actor);
  const counts: PollCounts = { ...rb, compared: 0, differences: 0, batchDates: 0, batchDateDifferences: 0 };
  const cats = await loadCategories(db, householdId);
  const from = addDays(today, -45);
  const appGroups = new Map<string, GroupTotals>();
  const rows = await db.query<{ id: string }>(
    "select id from transactions where household_id = $1 and bc_external_doc_no is not null and kind <> 'bc_native' and state in ('bc_draft_created','posted','reconciled') and posted_date >= $2::date order by posted_date",
    [householdId, from],
  );
  for (const { id } of rows.rows) {
    const tx = await loadTx(db, id);
    counts.compared += 1;
    for (const l of await linesFor(db, tx, await loadSplits(db, tx.id), cats)) addTo(appGroups, `${tx.bc_batch ?? "?"}|${l.postingDate}`, tx.bc_external_doc_no!, l.amountCents);
    const diff = await compareOne(db, tx, deps, cats);
    if (!diff) {
      if (tx.sync_status !== "in_sync") await db.query("update transactions set sync_status = 'in_sync', sync_difference = null, last_sync_at = now() where id = $1", [tx.id]);
      continue;
    }
    counts.differences += 1;
    await raiseException(db, householdId, tx.id, diff.reason, "poll", actor, { sync_difference: diff.detail });
  }
  // Per batch and posting date (spec: "Webhooks and polling"): count and debit sum of HHAPP lines on each side.
  if (deps.ledger.listAppDocuments) {
    const inFlight = new Set((await db.query<{ doc: string }>("select bc_external_doc_no as doc from transactions where household_id = $1 and state = 'sent_to_bc' and bc_external_doc_no is not null", [householdId])).rows.map((r) => r.doc));
    const ledgerGroups = new Map<string, GroupTotals>();
    for (const r of await deps.ledger.listAppDocuments({ externalDocumentNoStartsWith: "HHAPP-", postingDateFrom: from })) {
      if (inFlight.has(r.externalDocumentNo)) continue;
      addTo(ledgerGroups, `${r.batch ?? "?"}|${r.postingDate}`, r.externalDocumentNo, r.amountCents);
    }
    for (const key of new Set([...appGroups.keys(), ...ledgerGroups.keys()])) {
      counts.batchDates += 1;
      const a = appGroups.get(key) ?? { count: 0, debits: 0, docs: new Set<string>() };
      const b = ledgerGroups.get(key) ?? { count: 0, debits: 0, docs: new Set<string>() };
      if (a.count === b.count && a.debits === b.debits) continue;
      counts.batchDateDifferences += 1;
      const [batch, postingDate] = key.split("|");
      const onlyInBc = [...b.docs].filter((d) => !a.docs.has(d));
      const onlyInApp = [...a.docs].filter((d) => !b.docs.has(d));
      // Documents the app does not hold at all are raised for Cade; per-document differences were raised above.
      for (const doc of onlyInBc) {
        const known = await db.query<{ id: string }>("select id from transactions where household_id = $1 and bc_external_doc_no = $2", [householdId, doc]);
        if (known.rows.length) continue;
        await db.query("insert into alerts (household_id, member_id, kind, level, fingerprint, payload) values ($1,null,'bc_unknown_document','action',$2,$3) on conflict do nothing", [
          householdId,
          `bc_unknown_document:${doc}`,
          JSON.stringify({ title: "A Homestead document in BC has no app record", body: `${doc} is in HHAPP/${batch} for ${postingDate} but the app does not know it. It is in the Console's exception queue.`, externalDocumentNo: doc, bcSide: { batch, postingDate } }),
        ]);
      }
      await audit(db, householdId, { actor, action: "bc.poll_batch_date_difference", entity: "batch", entityId: key, after: { batch, postingDate, app: { lines: a.count, debits: a.debits }, bc: { lines: b.count, debits: b.debits }, onlyInBc, onlyInApp } });
    }
  }
  await db.query("update ledger_connections set last_poll_at = $2 where household_id = $1", [householdId, now.toISOString()]);
  await audit(db, householdId, { actor, action: "bc.nightly_poll", entity: "household", entityId: householdId, after: counts });
  return counts;
}

async function compareOne(db: Queryable, tx: TxRow, deps: Deps, cats: Awaited<ReturnType<typeof loadCategories>>): Promise<{ reason: string; detail: string } | undefined> {
  const doc = tx.bc_external_doc_no!;
  const splits = await loadSplits(db, tx.id);
  const appLines = await linesFor(db, tx, splits, cats);
  const appCount = appLines.length;
  const appDebits = appLines.filter((l) => l.amountCents > 0).reduce((s, l) => s + l.amountCents, 0);
  const found = await deps.ledger.findByExternalDocumentNo(doc);
  const appSide = `app: ${appCount} lines, debits ${appDebits}, key ${tx.idempotency_key}, doc ${doc}, line ids ${(tx.bc_line_ids ?? []).join("/") || "-"}, entries ${(tx.bc_entry_nos ?? []).join("/") || "-"}`;
  if (tx.state === "bc_draft_created") {
    if (found.glEntryNos.length > 0) return undefined; // readBackHousehold moves it to posted on the next pass
    if (found.journalLineIds.length !== appCount) {
      return { reason: found.journalLineIds.length === 0 ? "The draft is gone from Business Central (deleted or posted under another number)." : "The draft in Business Central has a different number of lines than the app sent.", detail: `${appSide}; bc: ${found.journalLineIds.length} draft lines ${found.journalLineIds.join("/") || "-"}` };
    }
    return undefined;
  }
  const entries = await deps.ledger.readGlEntriesByExternalDocNo({ externalDocumentNo: doc });
  const bcDebits = entries.filter((e) => e.amountCents > 0).reduce((s, e) => s + e.amountCents, 0);
  if (entries.length !== appCount || bcDebits !== appDebits) {
    return { reason: entries.length === 0 ? "The posted entries are gone from Business Central (reversed?)." : "Business Central's posted entries differ from the app's lines in count or amount; BC wins.", detail: `${appSide}; bc: ${entries.length} entries ${entries.map((e) => e.entryNo).join("/") || "-"}, debits ${bcDebits}, document ${entries[0]?.documentNo ?? "-"}` };
  }
  return undefined;
}
