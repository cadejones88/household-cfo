/**
 * The seven candidate auto-post rules from the spec ("Candidate rules for the first approval"), seeded in state
 * `proposed`. Each stays off until it passes its sandbox test and Cade approves it in writing; R2, R3 and R7
 * go live first, R1, R4, R5 and R6 after one clean month (decision 4 of October 20, 2026).
 */
import type { RuleAction, RuleKind, RuleMatch } from "./rules.js";

export interface RuleSeed {
  ruleNo: string;
  kind: RuleKind;
  name: string;
  match: RuleMatch;
  action: RuleAction;
}

export const RULE_SEEDS: readonly RuleSeed[] = [
  {
    ruleNo: "R1",
    kind: "paycheck",
    name: "HFH paycheck",
    match: { merchantPattern: "henry'?s?\\s*fork|paychex", direction: "in", requires: ["stub_read", "every_component_mapped", "components_tie_to_net_within_1c", "net_within_15pct_of_last_six"] },
    action: { kind: "paycheck", categoryId: "income-hfh-wages", confidence: 0.99 },
  },
  {
    ruleNo: "R2",
    kind: "transfer",
    name: "Own-account transfer",
    match: { requires: ["both_sides_present", "equal_and_opposite", "within_2_days"], direction: "any" },
    action: { kind: "transfer", categoryId: "transfer-own", confidence: 0.99 },
  },
  {
    ruleNo: "R3",
    kind: "card_payment",
    name: "Card payment",
    match: { requires: ["both_sides_present", "bank_side_and_card_side"], direction: "any" },
    action: { kind: "transfer", categoryId: "card-payment", confidence: 0.99 },
  },
  {
    ruleNo: "R4",
    kind: "recurring_bill",
    name: "Recurring bill, fixed",
    match: {
      merchants: [
        { pattern: "verizon", categoryId: "phones" },
        { pattern: "clear management", categoryId: "water-sewer-trash" },
        { pattern: "rocky mountain power", categoryId: "electricity" },
        { pattern: "intermountain gas", categoryId: "gas-propane" },
        { pattern: "netflix|disney\\+|spotify|youtube premium", categoryId: "streaming" },
        { pattern: "northwestern mutual", categoryId: "life-insurance-cade" },
      ],
      cadence: "monthly",
      tolerance: { cents: 500, fraction: 0.05 },
      requires: ["amount_within_tolerance_of_last_three"],
      direction: "out",
    },
    action: { confidence: 0.99 },
  },
  {
    ruleNo: "R5",
    kind: "recurring_bill",
    name: "Tithing",
    match: { merchantPattern: "church of jesus christ|lds\\b|tithing", cadence: "weekly", standingAmountCents: null, requires: ["amount_equals_standing_amount"], direction: "out" },
    action: { categoryId: "tithing", dims: { TAX_TREATMENT: "DED-CHAR" }, confidence: 0.99 },
  },
  {
    ruleNo: "R6",
    kind: "small_merchant",
    name: "Small known merchant",
    match: { maxCents: 2500, minApprovedCount: 10, windowMonths: 6, requires: ["under_materiality", "inside_merchant_band"], direction: "out" },
    action: { confidence: 0.98 },
  },
  {
    ruleNo: "R7",
    kind: "bc_native",
    name: "BC-native payments",
    match: { merchants: [{ pattern: "pennymac" }, { pattern: "frontier" }], requires: ["amount_equals_scheduled_payment", "bank_ledger_entry_found"], direction: "out" },
    action: { kind: "bc_native", confidence: 0.99 },
  },
];
