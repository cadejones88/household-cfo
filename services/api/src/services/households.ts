/**
 * Household settings: thresholds, quiet hours, the payday rule, goals, the budget names and the draft authority
 * matrix. Stored on `households.settings`, versioned through `household_setting_versions`; every change is an
 * approval by both spouses (approvals.ts).
 */
import type { Queryable } from "../db/index.js";
import { audit } from "../db/index.js";
import { notFound } from "../lib/errors.js";

export interface GoalSetting {
  id: string;
  name: string;
  fundGoal: string;
  targetCents: number;
  nextMilestone?: string;
  /** Sample targets until the Constitution's numbers are approved. */
  isSample?: boolean;
}

export interface HouseholdSettings {
  /** Any known Henry's Fork payday; paydays repeat every 14 days. */
  paydayAnchor: string;
  liquidityFloorCents: number;
  materialityCents: number;
  quietHours: { start: string; end: string };
  /** Alert kinds both spouses approved to break quiet hours. */
  criticalAlertKinds: string[];
  budget: { approvedName: string | null; revisionName: string; sampleName: string };
  goals: GoalSetting[];
  merchantWatchList: string[];
  /** Tithing on income received (0.10). Fast offerings are discretionary. */
  givingRate: number;
  /** Candidate rules need this many consistent approvals before the proposer suggests a merchant rule. */
  ruleProposalMinApprovals: number;
  /** Weekly pulse delivery: day (0=Sunday) and local time. */
  pulse: { weekday: number; time: string };
  /** I-09 unilateral budget-move threshold between flexible categories; null = TBD (every move needs the other spouse). */
  unilateralMoveThresholdCents: number | null;
  authorityMatrix: AuthorityRowSetting[];
}

export interface AuthorityRowSetting {
  action: string;
  who: string;
  stepUp: string;
  notes: string;
  settingKeys?: string[];
  tbd?: boolean;
}

export const DEFAULT_AUTHORITY_MATRIX: AuthorityRowSetting[] = [
  { action: "Approve a classification or split", who: "Either spouse", stepUp: "No", notes: "One tap" },
  { action: "Mark an item as business", who: "Either spouse", stepUp: "No", notes: "Shown to Cade in the CTJ list" },
  { action: "Post approved drafts in BC", who: "Cade", stepUp: "BC sign-in", notes: "Until auto-post rules are approved" },
  { action: "Auto-post under R1–R7", who: "System", stepUp: "None", notes: "Only after written approval of each rule and the AUTOPOST permission" },
  { action: "Approve or retire a rule", who: "The spouse who did not propose it", stepUp: "Yes", notes: "Auto-post flag on a rule needs Cade's written approval" },
  { action: "Budget move", who: "The other spouse", stepUp: "Yes (Face ID)", notes: "I-09 threshold for unilateral moves between flexible categories: TBD", settingKeys: ["unilateralMoveThresholdCents"], tbd: true },
  { action: "Correction after posting", who: "Cade", stepUp: "BC sign-in", notes: "Reverse and repost in BC with reason CORRECT" },
  { action: "Opening-balance or policy change", who: "Both, in writing", stepUp: "Yes", notes: "Per BC design §12" },
  { action: "Change thresholds, quiet hours, alert types", who: "Both", stepUp: "Yes", notes: "Settings are versioned", settingKeys: ["liquidityFloorCents", "materialityCents", "quietHours", "criticalAlertKinds"] },
  { action: "Connect or remove a bank login", who: "The login's owner", stepUp: "Yes", notes: "Never the other spouse" },
  { action: "Export all data", who: "Either spouse", stepUp: "Yes", notes: "Full human-readable export" },
];

export const DEFAULT_SETTINGS: HouseholdSettings = {
  paydayAnchor: "2026-10-23", // Cade, 10/21/2026: next HFH payday is Friday Oct 23; every other Friday from there
  liquidityFloorCents: 0,
  materialityCents: 2500,
  quietHours: { start: "21:00", end: "07:00" },
  criticalAlertKinds: ["bc_dead_letter", "cash_short"],
  budget: { approvedName: null, revisionName: "BUD26-REV", sampleName: "FCST-SAMPLE" },
  goals: [
    { id: "emergency-1m", name: "A one-month emergency fund", fundGoal: "EMERG-1M", targetCents: 1_560_000, nextMilestone: "$2,000 by Dec 1", isSample: true },
    { id: "christmas", name: "Christmas 2026", fundGoal: "SINK-GIFTS", targetCents: 150_000, isSample: true },
    { id: "car", name: "Car repairs fund", fundGoal: "SINK-VEHICLE", targetCents: 100_000, isSample: true },
  ],
  merchantWatchList: [],
  givingRate: 0.1,
  ruleProposalMinApprovals: 3,
  pulse: { weekday: 0, time: "19:00" },
  unilateralMoveThresholdCents: null,
  authorityMatrix: DEFAULT_AUTHORITY_MATRIX,
};

export interface HouseholdRow {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  settings: HouseholdSettings;
  settings_version: number;
}

export async function getHousehold(db: Queryable, householdId: string): Promise<HouseholdRow> {
  const r = await db.query<{ id: string; name: string; timezone: string; currency: string; settings: Partial<HouseholdSettings>; settings_version: number }>(
    "select id, name, timezone, currency, settings, settings_version from households where id = $1",
    [householdId],
  );
  const row = r.rows[0];
  if (!row) throw notFound("household");
  return { ...row, settings: { ...DEFAULT_SETTINGS, ...row.settings } };
}

export async function getSettings(db: Queryable, householdId: string): Promise<HouseholdSettings> {
  return (await getHousehold(db, householdId)).settings;
}

/** Writes the next settings version (called only from an approval decided by both spouses). */
export async function writeSettingsVersion(db: Queryable, householdId: string, settings: HouseholdSettings, approvedBy: string[], actor: string): Promise<number> {
  const current = await getHousehold(db, householdId);
  const next = current.settings_version + 1;
  await db.query("insert into household_setting_versions (household_id, version, settings, approved_by) values ($1,$2,$3,$4)", [householdId, next, JSON.stringify(settings), approvedBy]);
  await db.query("update households set settings = $2, settings_version = $3 where id = $1", [householdId, JSON.stringify(settings), next]);
  await audit(db, householdId, { actor, action: "settings.version", entity: "household", entityId: householdId, before: { version: current.settings_version }, after: { version: next, approvedBy } });
  return next;
}

export interface MemberRow {
  id: string;
  display_name: string;
  role: "member" | "adviser";
}

export async function listMembers(db: Queryable, householdId: string): Promise<MemberRow[]> {
  const r = await db.query<MemberRow>("select id, display_name, role from members where household_id = $1 order by created_at", [householdId]);
  return r.rows;
}

/** The spouse who is not `memberId` (the one who decides an approval). */
export async function otherSpouse(db: Queryable, householdId: string, memberId: string): Promise<MemberRow | undefined> {
  const members = await listMembers(db, householdId);
  return members.find((m) => m.id !== memberId && m.role === "member");
}

export async function ledgerConnection(db: Queryable, householdId: string): Promise<{
  id: string;
  bc_tenant_id: string;
  bc_environment: string;
  bc_company_id: string;
  journal_template: string;
  auto_post_enabled: boolean;
  last_poll_at: string | null;
  last_webhook_at: string | null;
  api_base_url: string;
} | undefined> {
  const r = await db.query("select id, bc_tenant_id, bc_environment, bc_company_id, journal_template, auto_post_enabled, last_poll_at, last_webhook_at, api_base_url from ledger_connections where household_id = $1", [householdId]);
  return r.rows[0];
}
