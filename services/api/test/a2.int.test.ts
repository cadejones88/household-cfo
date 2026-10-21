/**
 * A2 (integration): a transfer, a card payment and a loan payment never show as spending. Kinds transfer, transfer,
 * bc_native; both sides of each pair linked; the documents go through 115101 and 115201, which net to zero; nothing
 * lands on a spending account; the budget counts only the grocery line. With R2/R3 approved and the household switch
 * on, the pairs go to HHAPP/AUTOPOST; the PennyMac payment is matched to BC's own bank ledger entry and reconciled.
 */
import { idempotencyKey, isSpendingAccount } from "@homestead/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { budgetStatus } from "../src/services/budget.js";
import { runMatching } from "../src/services/classify.js";
import { netByAccount } from "../src/services/journalLines.js";
import { InMemoryLedger, type LedgerJournalLine } from "../src/services/ledgerPort.js";
import { answerQuestion, listQuestions } from "../src/services/questions.js";
import { importTransaction, loadTx, type TxRow } from "../src/services/transactions.js";
import type { SeedResult } from "../src/db/seed.js";
import { approveSeedRule, closePool, describeDb, inHh, seeded, setAutoPost } from "./helpers/db.js";

describeDb("A2: transfers, card payments and loan payments are never spending", () => {
  let hh: SeedResult;
  const ledger = new InMemoryLedger();
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    hh = await seeded("a2", { today: "2026-10-20" });
    await inHh(hh, async (db) => {
      for (const r of ["R2", "R3", "R7"]) await approveSeedRule(db, hh, r);
      const add = async (name: string, code: string, date: string, amountCents: number, merchant: string) => {
        const t = await importTransaction(db, hh.householdId, { accountId: hh.accounts[code]!, source: "plaid", sourceRef: name, idempotencyKey: idempotencyKey.plaid(code, name), postedDate: date, amountCents, merchantRaw: merchant }, "plaid-sync");
        ids[name] = t.transaction.id;
      };
      await add("xfer-out", "BEEHIVE-CHK", "2026-10-09", -50000, "ONLINE TRANSFER TO SAV 6289-001");
      await add("xfer-in", "BEEHIVE-SAV", "2026-10-10", 50000, "ONLINE TRANSFER FROM CHK");
      await add("pay-out", "AFCU-CHK", "2026-10-12", -36300, "CAPITAL ONE ONLINE PMT");
      await add("pay-in", "CAPONE-CC", "2026-10-13", 36300, "PAYMENT THANK YOU");
      await add("pennymac", "AFCU-CHK", "2026-10-01", -567039, "PENNYMAC LOAN SERVICES PAYMENT");
      await add("groceries", "BEEHIVE-CHK", "2026-10-06", -6233, "BROULIMS REXBURG");
    });
    // BC's own recurring journal posted the mortgage payment on the America First card (no HHAPP document).
    ledger.addNativeBankEntry({ bankAccountCode: "AFCU-CHK", postingDate: "2026-10-01", amountCents: -567039, documentNo: "RJ-1001", externalDocumentNo: "" });
    await inHh(hh, (db) => runMatching(db, hh.householdId, { ledger, actor: "matching", now: new Date("2026-10-20T15:00:00Z") }));
  });
  afterAll(async () => {
    await closePool();
  });

  async function tx(name: string): Promise<TxRow> {
    return inHh(hh, (db) => loadTx(db, ids[name]!));
  }
  async function linesOf(name: string): Promise<LedgerJournalLine[]> {
    return inHh(hh, async (db) => (await db.query<{ payload: { lines: LedgerJournalLine[] } }>("select payload from outbox where aggregate_id = $1 and operation = 'send_to_bc'", [ids[name]])).rows[0]!.payload.lines);
  }

  it("classifies the three kinds and links both sides of each pair", async () => {
    const [xo, xi, po, pi, pm] = await Promise.all(["xfer-out", "xfer-in", "pay-out", "pay-in", "pennymac"].map(tx));
    expect([xo!.kind, xi!.kind, po!.kind, pi!.kind, pm!.kind]).toEqual(["transfer", "transfer", "transfer", "transfer", "bc_native"]);
    expect(xo!.pair_id).toBe(xi!.id);
    expect(pi!.pair_id).toBe(po!.id);
    expect([xo!.category_id, po!.category_id]).toEqual(["transfer-own", "card-payment"]);
    expect([xo!.state, xi!.state, po!.state, pi!.state]).toEqual(["approved", "approved", "approved", "approved"]);
  });

  it("posts the pairs through 115101 and 115201, which net to zero, and never touches a spending account", async () => {
    const all = (await Promise.all(["xfer-out", "xfer-in", "pay-out", "pay-in"].map(linesOf))).flat();
    const net = netByAccount(all);
    expect(net.get("115101")).toBe(0);
    expect(net.get("115201")).toBe(0);
    for (const l of all) if (l.accountType === "G/L Account") expect(isSpendingAccount(l.accountNo)).toBe(false);
    expect((await tx("xfer-out")).bc_batch).toBe("FEEDS"); // the household switch is off
  });

  it("matches the PennyMac payment to BC's own bank ledger entry: Reconciled, no HHAPP document, no outbox row", async () => {
    const pm = await tx("pennymac");
    expect(pm).toMatchObject({ state: "reconciled", kind: "bc_native", bc_document_no: "RJ-1001" });
    expect(pm.bc_external_doc_no).toMatch(/^BCNATIVE-/);
    await inHh(hh, async (db) => expect((await db.query("select 1 from outbox where aggregate_id = $1", [pm.id])).rowCount).toBe(0));
  });

  it("budget totals count the groceries and nothing else", async () => {
    const q = (await inHh(hh, (db) => listQuestions(db, hh.householdId, hh.members.vanessa))).find((x) => x.transactionId === ids["groceries"]);
    expect(q?.kind).toBe("confirm_category");
    await inHh(hh, (db) => answerQuestion(db, hh.householdId, hh.members.vanessa, q!.id, { optionId: "confirm", stepUp: false }));
    const b = await inHh(hh, (db) => budgetStatus(db, hh.householdId, ledger, "2026-10", "2026-10-20"));
    expect(b.lines.filter((l) => l.spentCents !== 0).map((l) => [l.categoryId, l.spentCents])).toEqual([["groceries", 6233]]);
    expect(b.totals?.spentCents).toBe(6233);
    expect(b.isSample).toBe(true);
  });

  it("with the household switch on, a new approved pair goes to HHAPP/AUTOPOST", async () => {
    await inHh(hh, async (db) => {
      await setAutoPost(db, hh.householdId, true);
      for (const [name, code, amt] of [["x2-out", "MACU-CHK", -12000], ["x2-in", "MACU-SAV", 12000]] as const) {
        ids[name] = (await importTransaction(db, hh.householdId, { accountId: hh.accounts[code]!, source: "plaid", sourceRef: name, idempotencyKey: idempotencyKey.plaid(code, name), postedDate: "2026-10-18", amountCents: amt, merchantRaw: "TRANSFER" }, "plaid-sync")).transaction.id;
      }
      await runMatching(db, hh.householdId, { ledger, actor: "matching", now: new Date("2026-10-20T15:00:00Z") });
      await setAutoPost(db, hh.householdId, false);
    });
    expect((await tx("x2-out")).bc_batch).toBe("AUTOPOST");
    expect((await tx("x2-in")).bc_batch).toBe("AUTOPOST");
  });
});
