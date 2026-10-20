/**
 * Paycheck components and the BC accounts they post to (spec: "Paychecks").
 * One net-pay deposit becomes one BC document whose lines are the components.
 */
import type { Cents } from "./money.js";
import { sumCents } from "./money.js";
import type { DimensionSet } from "./dimensions.js";
import { PENDING_SANDBOX_ACCOUNTS } from "./chart.js";

export type EmployerCode = "HFH" | "CTJ";

export type PaycheckComponentKind =
  | "regular"
  | "bonus"
  | "overtime"
  | "fit"
  | "state_tax"
  | "social_security"
  | "medicare"
  | "benefit"
  | "other_deduction";

export interface PaycheckComponent {
  kind: PaycheckComponentKind;
  label: string;
  /** Positive for earnings and for deductions alike; the sign is applied when the lines are built. */
  amountCents: Cents;
  /** For `benefit`: the natural 605xxx account chosen from the stub label. */
  glAccountOverride?: string;
}

export interface PaycheckLine {
  glAccount: string;
  /** Signed as BC wants it: credit negative, debit positive. */
  amountCents: Cents;
  description: string;
  dims: DimensionSet;
  kind: PaycheckComponentKind | "net";
}

const EMPLOYER_ACCOUNTS: Record<EmployerCode, { regular: string; bonus: string; fit: string; state: string; ss: string; medicare: string; descriptor: RegExp }> = {
  HFH: { regular: "401101", bonus: "401102", fit: "701101", state: "701201", ss: "701301", medicare: "701401", descriptor: /henry'?s?\s*fork|paychex/i },
  CTJ: { regular: "401201", bonus: "401202", fit: "701102", state: "701202", ss: "701302", medicare: "701402", descriptor: /cade\s*t\.?\s*jones|gusto/i },
};

export function employerForDescriptor(descriptor: string): EmployerCode | undefined {
  for (const [code, e] of Object.entries(EMPLOYER_ACCOUNTS) as [EmployerCode, (typeof EMPLOYER_ACCOUNTS)[EmployerCode]][]) {
    if (e.descriptor.test(descriptor)) return code;
  }
  return undefined;
}

export interface BuildPaycheckOptions {
  employer: EmployerCode;
  components: readonly PaycheckComponent[];
  netCents: Cents;
  /** The receiving bank card's G/L account is not used here; the bank side is the balancing line in BC. */
  /** Accounts that exist in the target company. Bonus falls back to gross wages with a BONUS comment until 401102/401202 exist. */
  existingAccounts?: ReadonlySet<string>;
  payDateIso: string;
}

export class PaycheckDoesNotTieError extends Error {
  constructor(public readonly expectedNet: Cents, public readonly computedNet: Cents) {
    super(`Paycheck components do not tie to net: expected ${expectedNet}, computed ${computedNet}`);
    this.name = "PaycheckDoesNotTieError";
  }
}

/** Earnings minus deductions must equal net within one cent (R1 threshold), or the stub goes back for a look. */
export function buildPaycheckLines(opts: BuildPaycheckOptions): PaycheckLine[] {
  const e = EMPLOYER_ACCOUNTS[opts.employer];
  const lines: PaycheckLine[] = [];
  let earnings = 0;
  let deductions = 0;
  for (const c of opts.components) {
    if (c.amountCents < 0) throw new Error(`Component ${c.kind} must be non-negative`);
    switch (c.kind) {
      case "regular":
      case "overtime": {
        earnings += c.amountCents;
        lines.push({ glAccount: e.regular, amountCents: -c.amountCents, description: c.label, dims: { FAMILY_AREA: "CADE", TAX_TREATMENT: "TAXABLE" }, kind: c.kind });
        break;
      }
      case "bonus": {
        earnings += c.amountCents;
        const bonusExists = opts.existingAccounts ? opts.existingAccounts.has(e.bonus) : !PENDING_SANDBOX_ACCOUNTS.includes(e.bonus);
        lines.push({
          glAccount: bonusExists ? e.bonus : e.regular,
          amountCents: -c.amountCents,
          description: bonusExists ? c.label : `BONUS ${c.label}`.slice(0, 100),
          dims: { FAMILY_AREA: "CADE", TAX_TREATMENT: "TAXABLE" },
          kind: "bonus",
        });
        break;
      }
      case "fit":
        deductions += c.amountCents;
        lines.push({ glAccount: e.fit, amountCents: c.amountCents, description: c.label, dims: { SPEND_CLASS: "COMMITTED", FAMILY_AREA: "CADE" }, kind: c.kind });
        break;
      case "state_tax":
        deductions += c.amountCents;
        lines.push({ glAccount: e.state, amountCents: c.amountCents, description: c.label, dims: { SPEND_CLASS: "COMMITTED", FAMILY_AREA: "CADE", TAX_TREATMENT: "DED-SALT" }, kind: c.kind });
        break;
      case "social_security":
        deductions += c.amountCents;
        lines.push({ glAccount: e.ss, amountCents: c.amountCents, description: c.label, dims: { SPEND_CLASS: "COMMITTED", FAMILY_AREA: "CADE", TAX_TREATMENT: "NONDEDUCT" }, kind: c.kind });
        break;
      case "medicare":
        deductions += c.amountCents;
        lines.push({ glAccount: e.medicare, amountCents: c.amountCents, description: c.label, dims: { SPEND_CLASS: "COMMITTED", FAMILY_AREA: "CADE", TAX_TREATMENT: "NONDEDUCT" }, kind: c.kind });
        break;
      case "benefit": {
        deductions += c.amountCents;
        const gl = c.glAccountOverride ?? "605301";
        if (!/^605\d{3}$/.test(gl)) throw new Error(`Benefit premiums post to a 605xxx account, got ${gl}`);
        lines.push({ glAccount: gl, amountCents: c.amountCents, description: c.label, dims: { SPEND_CLASS: "COMMITTED", FAMILY_AREA: "CADE" }, kind: c.kind });
        break;
      }
      case "other_deduction":
        deductions += c.amountCents;
        lines.push({ glAccount: "701801", amountCents: c.amountCents, description: c.label, dims: { SPEND_CLASS: "COMMITTED", FAMILY_AREA: "JOINT", TAX_TREATMENT: "REVIEW" }, kind: c.kind });
        break;
    }
  }
  const computedNet = earnings - deductions;
  if (Math.abs(computedNet - opts.netCents) > 1) throw new PaycheckDoesNotTieError(opts.netCents, computedNet);
  // The net line is the bank side: debit the receiving bank card for the actual net deposit.
  lines.push({ glAccount: "", amountCents: opts.netCents, description: `Net pay ${opts.payDateIso}`, dims: {}, kind: "net" });
  const check = sumCents(lines.map((l) => l.amountCents));
  // Allowed one-cent rounding goes to the regular wage line so the document balances to zero.
  if (check !== 0) {
    const reg = lines.find((l) => l.kind === "regular");
    if (!reg) throw new Error("Paycheck has no regular wage line to absorb rounding");
    reg.amountCents -= check;
  }
  return lines;
}
