/**
 * The rule engine (pure): tiers, the drift guard, R4/R5/R6 shapes, proposed rules capped to a suggestion, and the
 * auto-post decision (rule may auto-post AND approved AND household switch on AND no guard tripped).
 */
import { amountBand } from "@homestead/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/services/households.js";
import { decideBatch, evaluateRules, heuristicCategory, type MerchantHistory, type RuleRow, type TxForRules } from "../src/services/rules.js";
import { RULE_SEEDS } from "../src/services/ruleSeeds.js";
import { catalogMap } from "./helpers/catalog.js";

const cats = catalogMap();
let n = 0;
function rule(over: Partial<RuleRow>): RuleRow {
  n += 1;
  return { id: `r${n}`, rule_no: null, kind: "merchant", name: "rule", match: {}, action: {}, may_auto_post: false, state: "approved", proposed_by: "system", approved_by: null, approved_at: null, approval_note: null, effective_from: null, version: 1, supersedes_rule_id: null, test_passed_at: null, created_at: "", updated_at: "", ...over };
}
function tx(amountCents: number, merchant = "MAVERIK #417", over: Partial<TxForRules> = {}): TxForRules {
  return { merchantRaw: merchant, merchantNorm: merchant.toLowerCase().replace(/[#*]+\s*\d+/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(), amountCents, accountId: "a1", bcBankAccountCode: "BEEHIVE-CHK", businessFlag: "none", receiptSplitPending: false, feedStaleHours: 2, ...over };
}
const opts = (autoPost = false, history?: MerchantHistory) => ({ settings: DEFAULT_SETTINGS, householdAutoPostOn: autoPost, ...(history ? { history } : {}) });
const maverik = rule({ name: "Maverik fuel", match: { merchantNorm: "maverik", band: amountBand([3000, 4517, 5200, 6100]), direction: "out" }, action: { categoryId: "fuel", confidence: 0.99 }, may_auto_post: true });

describe("evaluateRules", () => {
  it("files a high-confidence line under an approved rule inside its band", () => {
    const e = evaluateRules([maverik], tx(-4800), cats, opts());
    expect(e).toMatchObject({ categoryId: "fuel", tier: "high", ruleApproved: true, inBand: true, nextState: "approved" });
  });

  it("rule drift: a $600 charge at the rule's merchant is asked, not filed", () => {
    const e = evaluateRules([maverik], tx(-60000), cats, opts(true));
    expect(e.nextState).toBe("ready_for_review");
    expect(e.inBand).toBe(false);
    expect(e.tier).toBe("low");
    expect(e.blockReasons).toContain("outside_band");
    expect(e.mayAutoPost).toBe(false);
    expect(e.reason).toMatch(/unusual amount/);
  });

  it("a proposed rule only suggests (medium, one tap); it never files by itself", () => {
    const proposed = rule({ ...maverik, id: "p1", state: "proposed" });
    const e = evaluateRules([proposed], tx(-4800), cats, opts(true));
    expect(e.tier).toBe("medium");
    expect(e.nextState).toBe("ready_for_review");
  });

  it("business-flagged, watch-listed or receipt-pending lines are never filed by a rule", () => {
    expect(evaluateRules([maverik], tx(-4800, "MAVERIK #417", { businessFlag: "ctj" }), cats, opts()).nextState).toBe("ready_for_review");
    expect(evaluateRules([maverik], tx(-4800), cats, { settings: { ...DEFAULT_SETTINGS, merchantWatchList: ["maverik"] }, householdAutoPostOn: true }).nextState).toBe("ready_for_review");
    const pending = evaluateRules([maverik], tx(-4800, "MAVERIK #417", { receiptSplitPending: true }), cats, opts(true));
    expect(pending.blockReasons).toContain("receipt_pending");
    expect(pending.mayAutoPost).toBe(false);
  });

  it("falls back to a keyword guess at medium confidence, and to low with no guess at all", () => {
    const g = evaluateRules([], tx(-1299, "NETFLIX.COM"), cats, opts());
    expect(g).toMatchObject({ categoryId: "streaming", tier: "medium", nextState: "ready_for_review" });
    const none = evaluateRules([], tx(-1299, "QZXV LLC"), cats, opts());
    expect(none).toMatchObject({ tier: "low", nextState: "ready_for_review" });
    expect(none.categoryId).toBeUndefined();
  });

  it("R4 recurring bill: stable against the last three within $5 or 5%; a moved amount is asked", () => {
    const r4 = rule({ ...RULE_SEEDS.find((r) => r.ruleNo === "R4")!, kind: "recurring_bill", rule_no: "R4", may_auto_post: true });
    const hist: MerchantHistory = { count: 3, categoryId: "phones", amountsCents: [-15320, -15320, -15100], lastThreeCents: [-15320, -15320, -15100] };
    expect(evaluateRules([r4], tx(-15320, "VERIZON WIRELESS"), cats, opts(false, hist))).toMatchObject({ categoryId: "phones", nextState: "approved" });
    expect(evaluateRules([r4], tx(-21000, "VERIZON WIRELESS"), cats, opts(false, hist)).nextState).toBe("ready_for_review");
    const short: MerchantHistory = { count: 1, amountsCents: [-15320], lastThreeCents: [-15320] };
    expect(evaluateRules([r4], tx(-15320, "VERIZON WIRELESS"), cats, opts(false, short)).tier).toBe("medium");
  });

  it("R6 small known merchant: needs 10 approvals to one category, under $25, inside the band", () => {
    const r6 = rule({ ...RULE_SEEDS.find((r) => r.ruleNo === "R6")!, kind: "small_merchant", rule_no: "R6" });
    const ten: MerchantHistory = { count: 10, categoryId: "treats", amountsCents: Array.from({ length: 10 }, (_, i) => -(450 + i * 10)), lastThreeCents: [-540, -530, -520] };
    expect(evaluateRules([r6], tx(-500, "SODALICIOUS"), cats, opts(false, ten))).toMatchObject({ categoryId: "treats", nextState: "approved" });
    const nine: MerchantHistory = { ...ten, count: 9 };
    expect(evaluateRules([r6], tx(-500, "SODALICIOUS"), cats, opts(false, nine)).ruleApproved).toBe(false);
    expect(evaluateRules([r6], tx(-2600, "SODALICIOUS"), cats, opts(false, ten)).nextState).toBe("ready_for_review");
  });
});

describe("decideBatch", () => {
  it("is AUTOPOST only when the rule may auto-post, is approved, the switch is on and no guard tripped", () => {
    const e = evaluateRules([maverik], tx(-4800), cats, opts(true));
    expect(e.mayAutoPost).toBe(true);
    expect(decideBatch(e, maverik, true, "FEEDS")).toBe("AUTOPOST");
    expect(decideBatch(e, maverik, false, "FEEDS")).toBe("FEEDS");
    expect(decideBatch(e, { ...maverik, state: "proposed" }, true, "FEEDS")).toBe("FEEDS");
    expect(decideBatch(e, { ...maverik, may_auto_post: false }, true, "RECEIPTS")).toBe("RECEIPTS");
    const off = evaluateRules([maverik], tx(-4800), cats, opts(false));
    expect(off.blockReasons).toEqual(["autopost_off"]);
    expect(decideBatch(off, maverik, true, "FEEDS")).toBe("FEEDS");
  });
});

describe("heuristicCategory", () => {
  it("never suggests an unsplit or suspense category, and keeps income for money in", () => {
    expect(heuristicCategory(tx(-5000, "WALMART"), cats)?.categoryId).not.toBe("walmart-unsplit");
    expect(heuristicCategory(tx(313559, "HENRYS FORK HOMES PAYCHEX"), cats)?.categoryId).toBe("income-hfh-wages");
  });
});
