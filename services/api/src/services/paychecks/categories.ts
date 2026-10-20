/**
 * CFO-only categories for paycheck components (withholding and payroll deductions). They are not in the shared
 * household catalog because Vanessa never picks them; the seed adds them per household so paycheck splits can
 * reference a category like every other split.
 */
import { account } from "@homestead/shared";
import type { PaycheckComponentKind } from "@homestead/shared";

export interface ExtraCategorySeed {
  id: string;
  name: string;
  group: string;
  glAccount: string;
}

export const PAYCHECK_CATEGORY_SEEDS: readonly ExtraCategorySeed[] = [
  { id: "withholding-federal-hfh", name: "Federal withholding (HFH)", group: "Income", glAccount: "701101" },
  { id: "withholding-federal-ctj", name: "Federal withholding (CTJ)", group: "Income", glAccount: "701102" },
  { id: "withholding-idaho-hfh", name: "Idaho withholding (HFH)", group: "Income", glAccount: "701201" },
  { id: "withholding-idaho-ctj", name: "Idaho withholding (CTJ)", group: "Income", glAccount: "701202" },
  { id: "social-security-hfh", name: "Social Security (HFH)", group: "Income", glAccount: "701301" },
  { id: "social-security-ctj", name: "Social Security (CTJ)", group: "Income", glAccount: "701302" },
  { id: "medicare-hfh", name: "Medicare (HFH)", group: "Income", glAccount: "701401" },
  { id: "medicare-ctj", name: "Medicare (CTJ)", group: "Income", glAccount: "701402" },
  { id: "other-payroll-deductions", name: "Other payroll deductions", group: "Income", glAccount: "701801" },
];

/** The split category for a paycheck line's G/L account. */
export function categoryForPaycheckAccount(glAccount: string, kind: PaycheckComponentKind | "net"): string {
  const extra = PAYCHECK_CATEGORY_SEEDS.find((c) => c.glAccount === glAccount);
  if (extra) return extra.id;
  switch (glAccount) {
    case "401101":
      return "income-hfh-wages";
    case "401102":
      return "income-hfh-bonus";
    case "401201":
      return "income-ctj-wages";
    case "401202":
      return "income-ctj-bonus";
    case "605301":
      return "health-insurance";
    case "605101":
      return "life-insurance-cade";
    case "605401":
      return "identity-protection";
    case "605501":
      return "other-insurance";
    default:
      account(glAccount); // throws on an unknown account
      if (kind === "benefit") return "health-insurance";
      return "other-payroll-deductions";
  }
}
