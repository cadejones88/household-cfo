/**
 * Seeds one household for dev and tests: "Cade & Vanessa Jones Family", two members, the 14 accounts from
 * BANK_CARD_LIST, the categories from CATEGORIES, employers HFH and CTJ, the bills from the Phase 2 prototype
 * (PennyMac and both Frontier loans marked BC-native), the seven candidate auto-post rules R1–R7 in state
 * `proposed`, the import profiles, a sandbox ledger connection and a sample budget marked `isSample`.
 *
 * Synthetic data only: no real balances, no account numbers beyond the masks the family already uses.
 * Idempotent by household name. Run: DATABASE_URL=... pnpm --filter @homestead/api db:seed
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { BANK_CARD_LIST, CATEGORIES, CATEGORY_CATALOG_VERSION } from "@homestead/shared";
import type { Queryable } from "./index.js";
import { DEFAULT_SETTINGS, type HouseholdSettings } from "../services/households.js";
import { nextDueDate, todayIso } from "../lib/dates.js";
import { RULE_SEEDS } from "../services/ruleSeeds.js";
import { IMPORT_PROFILE_SEEDS } from "../services/bankData/profiles.js";

export interface SeedOptions {
  name?: string;
  /** Prefix for the members' Entra object ids (unique per seeded household). */
  entraPrefix?: string;
  today?: string;
  settings?: Partial<HouseholdSettings>;
}

export interface SeedResult {
  householdId: string;
  members: { cade: string; vanessa: string };
  /** Bank card code -> account id. */
  accounts: Record<string, string>;
  employers: { HFH: string; CTJ: string };
  bills: Record<string, string>;
  rules: Record<string, string>;
  ledgerConnectionId: string;
  created: boolean;
}

export const BILL_SEEDS: readonly { name: string; amountCents: number; dueDay: number; categoryId: string | null; account: string; isMinimum?: boolean; isBcNative?: boolean; autopay?: boolean }[] = [
  { name: "Verizon · phones", amountCents: 15320, dueDay: 13, categoryId: "phones", account: "AFCU-CHK", autopay: true },
  { name: "Rocky Mountain Power", amountCents: 11840, dueDay: 15, categoryId: "electricity", account: "BEEHIVE-CHK", autopay: true },
  { name: "Capital One · minimum", amountCents: 36300, dueDay: 17, categoryId: "card-payment", account: "CAPONE-CC", isMinimum: true },
  { name: "Frontier CU · Suburban", amountCents: 104711, dueDay: 16, categoryId: null, account: "AFCU-CHK", isBcNative: true, autopay: true },
  { name: "America First Visa · minimum", amountCents: 22200, dueDay: 22, categoryId: "card-payment", account: "AFCU-VISA", isMinimum: true },
  { name: "PennyMac · mortgage", amountCents: 567039, dueDay: 1, categoryId: null, account: "AFCU-CHK", isBcNative: true, autopay: true },
  { name: "Internet", amountCents: 7999, dueDay: 26, categoryId: "internet", account: "BEEHIVE-CHK", autopay: true },
  { name: "Clear Management · trash", amountCents: 15000, dueDay: 28, categoryId: "water-sewer-trash", account: "BEEHIVE-CHK" },
  { name: "Frontier CU · F-350", amountCents: 149609, dueDay: 19, categoryId: null, account: "AFCU-CHK", isBcNative: true, autopay: true },
];

/** The Phase 2 prototype's sample budget, mapped to categories (dollars), applied to every month. */
export const SAMPLE_BUDGET: readonly { categoryId: string; amountCents: number }[] = [
  { categoryId: "tithing", amountCents: 170000 },
  { categoryId: "electricity", amountCents: 15000 },
  { categoryId: "phones", amountCents: 16000 },
  { categoryId: "water-sewer-trash", amountCents: 15000 },
  { categoryId: "internet", amountCents: 8000 },
  { categoryId: "gas-propane", amountCents: 11000 },
  { categoryId: "groceries", amountCents: 150000 },
  { categoryId: "household-supplies", amountCents: 40000 },
  { categoryId: "eating-out", amountCents: 30000 },
  { categoryId: "treats", amountCents: 15000 },
  { categoryId: "fuel", amountCents: 45000 },
  { categoryId: "car-repairs", amountCents: 15000 },
  { categoryId: "school", amountCents: 15000 },
  { categoryId: "kids-activities", amountCents: 20000 },
  { categoryId: "general-merchandise", amountCents: 25000 },
  { categoryId: "entertainment", amountCents: 15000 },
  { categoryId: "streaming", amountCents: 6000 },
  { categoryId: "software", amountCents: 6000 },
  { categoryId: "memberships", amountCents: 6000 },
  { categoryId: "allowance-cade", amountCents: 15000 },
  { categoryId: "allowance-vanessa", amountCents: 15000 },
  { categoryId: "lash-supplies", amountCents: 10000 },
];

/** The HFH template from the prototype's sample paycheck (ratios of net). */
export const HFH_TEMPLATE = {
  components: [
    { kind: "regular", label: "Regular", ratio: 365000 / 313559 },
    { kind: "bonus", label: "Bonus", ratio: 23077 / 313559 },
    { kind: "fit", label: "Federal income tax", ratio: 29830 / 313559 },
    { kind: "state_tax", label: "Idaho income tax", ratio: 15000 / 313559 },
    { kind: "social_security", label: "Social Security", ratio: 24061 / 313559 },
    { kind: "medicare", label: "Medicare", ratio: 5627 / 313559 },
  ],
  labelMap: { "regular": "regular", "salary": "regular", "hourly": "regular", "bonus": "bonus", "federal income tax": "fit", "fed income tax": "fit", "idaho income tax": "state_tax", "id state tax": "state_tax", "social security": "social_security", "oasdi": "social_security", "medicare": "medicare" },
  lastSixNetCents: [313559, 313559, 312988, 314102, 313559, 313559],
};

export async function seedHousehold(db: Queryable, opts: SeedOptions = {}): Promise<SeedResult> {
  const name = opts.name ?? "Cade & Vanessa Jones Family";
  const prefix = opts.entraPrefix ?? "dev";
  const today = opts.today ?? todayIso();
  const existing = await db.query<{ id: string }>("select id from households where name = $1", [name]);
  if (existing.rows[0]) return { ...(await describe(db, existing.rows[0].id)), created: false };

  const settings: HouseholdSettings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const hh = (await db.query<{ id: string }>("insert into households (name, settings, settings_version) values ($1, $2, 1) returning id", [name, JSON.stringify(settings)])).rows[0]!.id;
  await db.query("select set_config('app.household_id', $1, true)", [hh]);
  const cade = (await db.query<{ id: string }>("insert into members (household_id, entra_object_id, display_name) values ($1, $2, 'Cade') returning id", [hh, `${prefix}-cade`])).rows[0]!.id;
  const vanessa = (await db.query<{ id: string }>("insert into members (household_id, entra_object_id, display_name) values ($1, $2, 'Vanessa') returning id", [hh, `${prefix}-vanessa`])).rows[0]!.id;
  await db.query("insert into household_setting_versions (household_id, version, settings, approved_by) values ($1, 1, $2, $3)", [hh, JSON.stringify(settings), [cade, vanessa]]);

  const ledgerConnectionId = (
    await db.query<{ id: string }>(
      `insert into ledger_connections (household_id, bc_tenant_id, bc_environment, bc_company_id, api_base_url, cert_secret_ref)
       values ($1, 'TBD', 'CADE_Sandbox_vs25', 'TBD', 'https://api.businesscentral.dynamics.com/v2.0/TBD/CADE_Sandbox_vs25/api/v2.0', 'bc-sandbox-cert') returning id`,
      [hh],
    )
  ).rows[0]!.id;

  for (const c of CATEGORIES) {
    await db.query(
      `insert into categories (id, household_id, name, "group", gl_account, dimension_defaults, spend_class, is_allowance, is_transfer, household_visible, examples, version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [c.id, hh, c.name, c.group, c.glAccount, JSON.stringify(c.dims), c.dims.SPEND_CLASS ?? null, c.isAllowance, c.isTransfer, c.householdVisible, [...c.examples], CATEGORY_CATALOG_VERSION],
    );
  }

  const accounts: Record<string, string> = {};
  for (const b of BANK_CARD_LIST) {
    const kind = b.kind === "line" ? "line" : b.kind;
    accounts[b.code] = (
      await db.query<{ id: string }>(
        "insert into accounts (household_id, kind, institution, display_name, mask, bc_bank_account_code, bc_gl_account) values ($1,$2,$3,$4,$5,$6,$7) returning id",
        [hh, kind, b.institution, b.name, b.mask, b.code, b.glAccount],
      )
    ).rows[0]!.id;
  }

  const HFH = (
    await db.query<{ id: string }>(
      "insert into employers (household_id, member_id, code, name, descriptor_pattern, bc_gross_account, bc_bonus_account, template) values ($1,$2,'HFH','Henry''s Fork Homes',$3,'401101','401102',$4) returning id",
      [hh, cade, "henry'?s?\\s*fork|paychex", JSON.stringify(HFH_TEMPLATE)],
    )
  ).rows[0]!.id;
  const CTJ = (
    await db.query<{ id: string }>(
      "insert into employers (household_id, member_id, code, name, descriptor_pattern, bc_gross_account, bc_bonus_account, template) values ($1,$2,'CTJ','Cade T. Jones CPA, P.C.',$3,'401201','401202',$4) returning id",
      [hh, cade, "cade\\s*t\\.?\\s*jones|gusto", JSON.stringify({ components: [], labelMap: {}, lastSixNetCents: [] })],
    )
  ).rows[0]!.id;

  const bills: Record<string, string> = {};
  for (const b of BILL_SEEDS) {
    bills[b.name] = (
      await db.query<{ id: string }>(
        "insert into bills (household_id, name, account_id, category_id, amount_cents, due_day, next_due_date, cadence, is_minimum, autopay, is_bc_native) values ($1,$2,$3,$4,$5,$6,$7,'monthly',$8,$9,$10) returning id",
        [hh, b.name, accounts[b.account], b.categoryId, b.amountCents, b.dueDay, nextDueDate(b.dueDay, today), b.isMinimum ?? false, b.autopay ?? false, b.isBcNative ?? false],
      )
    ).rows[0]!.id;
  }

  const rules: Record<string, string> = {};
  for (const r of RULE_SEEDS) {
    rules[r.ruleNo] = (
      await db.query<{ id: string }>(
        "insert into rules (household_id, rule_no, kind, name, match, action, may_auto_post, state, proposed_by) values ($1,$2,$3,$4,$5,$6,true,'proposed','system') returning id",
        [hh, r.ruleNo, r.kind, r.name, JSON.stringify(r.match), JSON.stringify(r.action)],
      )
    ).rows[0]!.id;
  }

  for (const p of IMPORT_PROFILE_SEEDS) {
    await db.query("insert into import_profiles (household_id, name, institution, format, spec) values ($1,$2,$3,$4,$5)", [hh, p.name, p.institution, p.format, JSON.stringify(p.spec)]);
  }

  const budgetLines = SAMPLE_BUDGET.map((l) => {
    const cat = CATEGORIES.find((c) => c.id === l.categoryId)!;
    return { account: cat.glAccount, categoryId: l.categoryId, dimensions: cat.dims, period: "monthly", amount_cents: l.amountCents, isSample: true };
  });
  await db.query("insert into budget_revisions (household_id, bc_budget_name, revision_no, lines) values ($1, $2, 1, $3)", [hh, settings.budget.sampleName, JSON.stringify(budgetLines)]);

  await db.query("insert into audit_log (household_id, actor, action, entity, entity_id, after) values ($1, 'seed', 'household.seeded', 'household', $1, $2)", [hh, JSON.stringify({ name, today })]);
  return { householdId: hh, members: { cade, vanessa }, accounts, employers: { HFH, CTJ }, bills, rules, ledgerConnectionId, created: true };
}

async function describe(db: Queryable, hh: string): Promise<Omit<SeedResult, "created">> {
  await db.query("select set_config('app.household_id', $1, true)", [hh]);
  const members = (await db.query<{ id: string; display_name: string }>("select id, display_name from members where household_id = $1", [hh])).rows;
  const accounts: Record<string, string> = {};
  for (const a of (await db.query<{ id: string; bc_bank_account_code: string }>("select id, bc_bank_account_code from accounts where household_id = $1", [hh])).rows) accounts[a.bc_bank_account_code] = a.id;
  const employers = (await db.query<{ id: string; code: string }>("select id, code from employers where household_id = $1", [hh])).rows;
  const bills: Record<string, string> = {};
  for (const b of (await db.query<{ id: string; name: string }>("select id, name from bills where household_id = $1", [hh])).rows) bills[b.name] = b.id;
  const rules: Record<string, string> = {};
  for (const r of (await db.query<{ id: string; rule_no: string }>("select id, rule_no from rules where household_id = $1 and rule_no is not null and state <> 'retired'", [hh])).rows) rules[r.rule_no] = r.id;
  const lc = (await db.query<{ id: string }>("select id from ledger_connections where household_id = $1", [hh])).rows[0];
  return {
    householdId: hh,
    members: { cade: members.find((m) => m.display_name === "Cade")!.id, vanessa: members.find((m) => m.display_name === "Vanessa")!.id },
    accounts,
    employers: { HFH: employers.find((e) => e.code === "HFH")!.id, CTJ: employers.find((e) => e.code === "CTJ")!.id },
    bills,
    rules,
    ledgerConnectionId: lc?.id ?? "",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new pg.Client({ connectionString: url, ssl: process.env["PGSSLMODE"] === "disable" ? false : { rejectUnauthorized: true } });
  await client.connect();
  try {
    await client.query("begin");
    const r = await seedHousehold(client);
    await client.query("commit");
    console.log(`${r.created ? "Seeded" : "Already seeded"}: household ${r.householdId}, members cade=${r.members.cade} vanessa=${r.members.vanessa}`);
  } catch (e) {
    await client.query("rollback");
    console.error(e);
    process.exit(1);
  } finally {
    await client.end();
  }
}
