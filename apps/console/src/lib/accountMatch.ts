/**
 * Which household account each bank account from Plaid should feed. A suggestion only: the person confirms every
 * row before anything is saved. A suggestion needs the kind to fit and the mask to agree, and it must be the only
 * such account (narrowed by institution name when several fit); otherwise the row starts at "choose". Credit-union
 * member numbers make masks ambiguous (America First's accounts all end 1221), so ties are left to the person.
 */
import type { AccountSummary } from "@homestead/shared";
import type { BankLoginAccount } from "../api/types";

type Kind = AccountSummary["kind"];

/** The household kinds a Plaid type/subtype can feed. */
export function kindsFor(a: Pick<BankLoginAccount, "type" | "subtype">): readonly Kind[] {
  const sub = (a.subtype ?? "").toLowerCase();
  switch ((a.type ?? "").toLowerCase()) {
    case "depository":
      if (sub === "checking") return ["checking"];
      if (["savings", "money market", "cd", "hsa"].includes(sub)) return ["savings", "share"];
      if (["paypal", "prepaid", "cash management"].includes(sub)) return ["wallet", "checking"];
      return ["checking", "savings", "share", "wallet"];
    case "credit":
      return sub === "line of credit" ? ["line", "card"] : ["card", "line"];
    case "loan":
      if (sub === "mortgage" || sub === "home equity") return ["mortgage", "line"];
      if (sub === "line of credit") return ["line"];
      return ["loan"];
    default:
      return [];
  }
}

const digits = (s: string | null | undefined): string => (s ?? "").replace(/\D/g, "");

/** Plaid's mask (2-4 characters) agrees with the household mask (which may carry a suffix, as Beehive's 6289-010). */
export function maskAgrees(plaidMask: string | null, householdMask: string): boolean {
  const p = digits(plaidMask);
  const h = digits(householdMask);
  if (p.length < 2 || h.length < 2) return false;
  return h.endsWith(p) || p.endsWith(h) || h.slice(0, 4) === p.slice(-4);
}

const STOP = new Set(["credit", "union", "cu", "fcu", "federal", "bank", "the", "of", "na", "n.a."]);
/** First significant word of an institution name: "America First Credit Union" and "America First CU" → "america". */
export function institutionKey(name: string | null | undefined): string {
  const words = (name ?? "").toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w && !STOP.has(w));
  return words[0] ?? "";
}

export interface MatchOptions {
  institutionName?: string | null;
  /** The login being edited: its own accounts count as free. */
  feedConnectionId?: string;
  /** Household account id -> the login that feeds it now (from the connections list), for accounts on other logins. */
  connectedVia?: ReadonlyMap<string, { feedId: string; institutionName: string }>;
}

/** Household accounts this bank account could feed, best first: kind fits and mask agrees, then kind fits, then the rest. */
export function rankCandidates(plaid: BankLoginAccount, household: readonly AccountSummary[], opts: MatchOptions = {}): AccountSummary[] {
  const kinds = kindsFor(plaid);
  const inst = institutionKey(opts.institutionName);
  const score = (h: AccountSummary) => (kinds.includes(h.kind) ? 4 : 0) + (maskAgrees(plaid.mask, h.mask) ? 2 : 0) + (inst && institutionKey(h.institution) === inst ? 1 : 0);
  return [...household].sort((a, b) => score(b) - score(a) || a.displayName.localeCompare(b.displayName));
}

export function isTakenElsewhere(h: AccountSummary, opts: MatchOptions): boolean {
  const via = opts.connectedVia?.get(h.id);
  return via !== undefined && via.feedId !== opts.feedConnectionId;
}

/** Plaid account id -> suggested household account id ("" = the person chooses). No household account is suggested twice. */
export function suggestMatches(plaidAccounts: readonly BankLoginAccount[], household: readonly AccountSummary[], opts: MatchOptions = {}): Record<string, string> {
  const inst = institutionKey(opts.institutionName);
  const out: Record<string, string> = {};
  for (const p of plaidAccounts) {
    const kinds = kindsFor(p);
    // With the bank's name known, never suggest another bank's account (Plaid's test HSA ••9001 once matched
    // Beehive savings 6289-001 on the digits alone).
    const fits = household.filter((h) => kinds.includes(h.kind) && maskAgrees(p.mask, h.mask) && !isTakenElsewhere(h, opts) && (!inst || institutionKey(h.institution) === inst));
    out[p.plaidAccountId] = fits.length === 1 ? fits[0]!.id : "";
  }
  const seen = new Map<string, number>();
  for (const id of Object.values(out)) if (id) seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const [k, id] of Object.entries(out)) if (id && (seen.get(id) ?? 0) > 1) out[k] = "";
  return out;
}

/** Problems that block saving: a household account chosen twice, or one another login already feeds. */
export function mappingProblems(choice: Readonly<Record<string, string>>, household: readonly AccountSummary[], opts: MatchOptions = {}): string[] {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const id of Object.values(choice)) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, n] of counts) {
    const h = household.find((x) => x.id === id);
    if (!h) continue;
    if (n > 1) problems.push(`${h.displayName} is chosen for ${n} bank accounts; pick one.`);
    if (isTakenElsewhere(h, opts)) problems.push(`${h.displayName} is already connected through ${opts.connectedVia?.get(id)?.institutionName ?? "another login"}. Remove that login first.`);
  }
  return problems;
}
