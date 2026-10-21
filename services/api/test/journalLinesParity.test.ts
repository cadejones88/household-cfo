/**
 * The outbox payload (services/api journalLines.ts) and the adapter's own mapping (ledger-adapter-bc mapping.ts) must
 * produce the same document for the same transaction: same accounts, same amounts, same dimension sets on the G/L
 * lines. Compared per account (line order and line numbers differ by design).
 */
import { bankCard, externalDocumentNo, idempotencyKey, type BankCardCode } from "@homestead/shared";
import { mapTransactionToJournalLines, type AppTransactionForLedger } from "@homestead/ledger-adapter-bc";
import { describe, expect, it } from "vitest";
import { buildJournalLines, type LineSource, type SplitSource } from "../src/services/journalLines.js";
import { catalogMap } from "./helpers/catalog.js";

const cats = catalogMap();

interface Case {
  name: string;
  card: BankCardCode;
  amountCents: number;
  splits: [number, string][];
  app: Partial<LineSource>;
  adapter: Partial<AppTransactionForLedger>;
}

const CASES: Case[] = [
  { name: "a grocery charge on checking", card: "BEEHIVE-CHK", amountCents: -4827, splits: [[-4827, "groceries"]], app: {}, adapter: { kind: "spend" } },
  { name: "a split Walmart receipt on the card", card: "CAPONE-CC", amountCents: -10000, splits: [[-6000, "groceries"], [-2500, "household-supplies"], [-1500, "school"]], app: {}, adapter: { kind: "spend" } },
  { name: "a transfer to savings", card: "BEEHIVE-CHK", amountCents: -50000, splits: [[-50000, "transfer-own"]], app: { kind: "transfer" }, adapter: { kind: "transfer", clearing: "own" } },
  { name: "a card payment from checking", card: "AFCU-CHK", amountCents: -36300, splits: [[-36300, "card-payment"]], app: { kind: "transfer" }, adapter: { kind: "transfer", clearing: "card" } },
  { name: "a household-card charge due from CTJ (A4)", card: "CAPONE-CC", amountCents: -12999, splits: [[-12999, "software"]], app: { businessFlag: "ctj" }, adapter: { kind: "spend", businessFlag: "ctj" } },
  { name: "a card payment CTJ made (A4)", card: "CAPONE-CC", amountCents: 36300, splits: [[36300, "card-payment"]], app: { businessFlag: "ctj", kind: "transfer" }, adapter: { kind: "transfer", paidBy: "ctj" } },
];

type Net = Record<string, { cents: number; dims: string }>;
const dimsKey = (d: readonly { code: string; valueCode: string }[]) =>
  d
    .map((x) => `${x.code}=${x.valueCode}`)
    .sort()
    .join(",");

describe("journal lines: the outbox payload matches the adapter's mapping", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const key = idempotencyKey.plaid("parity", `case${CASES.indexOf(c)}`);
      const doc = externalDocumentNo(key, "2026-10-15");
      const splits: SplitSource[] = c.splits.map(([cents, cat], i) => ({ lineNo: i + 1, amountCents: cents, categoryId: cat, glAccount: cats.get(cat)!.gl_account, dimensionSet: {}, description: "" }));
      const mine = buildJournalLines(
        { idempotencyKey: key, externalDocumentNo: doc, postedDate: "2026-10-15", amountCents: c.amountCents, merchantRaw: "PARITY", businessFlag: "none", kind: "spend", dimensionSet: {}, ...c.app },
        splits,
        { bcBankAccountCode: c.card, bcGlAccount: bankCard(c.card).glAccount, displayName: c.card },
        cats,
      );
      const theirs = mapTransactionToJournalLines({
        externalDocumentNo: doc,
        postingDate: "2026-10-15",
        description: "PARITY",
        amountCents: c.amountCents,
        bankCard: c.card,
        kind: "spend",
        businessFlag: "none",
        splits: c.adapter.kind === "transfer" || c.adapter.businessFlag === "ctj" ? [] : splits.map((s) => ({ lineNo: s.lineNo, amountCents: s.amountCents, glAccount: s.glAccount, dims: cats.get(s.categoryId)!.dimension_defaults })),
        ...c.adapter,
      } as AppTransactionForLedger);
      const a: Net = {};
      for (const l of mine) {
        const k = l.accountType === "Bank Account" ? `BANK:${l.accountNo}` : l.accountNo;
        a[k] = { cents: (a[k]?.cents ?? 0) + l.amountCents, dims: l.accountType === "Bank Account" ? "" : dimsKey(l.dimensions) };
      }
      const b: Net = {};
      for (const l of theirs.lines) {
        const k = l.accountType === "Bank Account" ? `BANK:${l.accountNumber}` : l.accountNumber;
        b[k] = { cents: (b[k]?.cents ?? 0) + l.amountCents, dims: l.accountType === "Bank Account" ? "" : dimsKey(l.dimensionSetLines ?? []) };
      }
      expect(a).toEqual(b);
      expect(theirs.lines.every((l) => l.externalDocumentNumber === doc)).toBe(true);
    });
  }
});
