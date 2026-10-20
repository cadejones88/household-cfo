/**
 * Business Central dimensions for the household company (records/bc-setup/Dimension Dictionary.csv).
 * Global 1 SPEND_CLASS, Global 2 FUND_GOAL, Shortcut 3 FAMILY_AREA, Shortcut 4 TAX_TREATMENT, Shortcut 5 PROJECT.
 * Lines must send the full set explicitly (BC test finding 1: only the two globals travel on the line itself).
 */

export const SPEND_CLASS = ["ESSENTIAL", "COMMITTED", "FLEXIBLE", "DISCRETIONARY", "GIVING", "TRANSFER", "NONCASH"] as const;
export type SpendClass = (typeof SPEND_CLASS)[number];

export const FUND_GOAL = [
  "OPERATING",
  "EMERG-1M",
  "EMERG-3-6M",
  "SINK-HOME",
  "SINK-VEHICLE",
  "SINK-INSUR",
  "SINK-SCHOOL",
  "SINK-GIFTS",
  "SINK-TRAVEL",
  "SINK-TAX",
  "SINK-MED",
  "DEBT-TARGET",
  "RETIRE",
  "EDUCATION",
  "MAJOR",
] as const;
export type FundGoal = (typeof FUND_GOAL)[number];

export const FAMILY_AREA = ["JOINT", "CADE", "VANESSA", "PAISLEY", "PEYTON", "STRYDER", "KIDS"] as const;
export type FamilyArea = (typeof FAMILY_AREA)[number];

export const TAX_TREATMENT = [
  "TAXABLE",
  "TAXFREE",
  "TAXDEFER",
  "DED-CHAR",
  "DED-MED",
  "DED-MORTINT",
  "DED-SALT",
  "DED-BUS",
  "DED-OTHER",
  "NONDEDUCT",
  "BASIS-ADJ",
  "REVIEW",
] as const;
export type TaxTreatment = (typeof TAX_TREATMENT)[number];

export const PROJECT = ["HOME-SHOP", "F350-BUILD", "XMAS-2026", "TRIP-2027"] as const;
export type Project = (typeof PROJECT)[number];

export const DIMENSION_CODES = {
  SPEND_CLASS: "SPEND_CLASS",
  FUND_GOAL: "FUND_GOAL",
  FAMILY_AREA: "FAMILY_AREA",
  TAX_TREATMENT: "TAX_TREATMENT",
  PROJECT: "PROJECT",
} as const;
export type DimensionCode = keyof typeof DIMENSION_CODES;

/** A full dimension set for one journal line. Blank means "not set" and is omitted when sent to BC. */
export interface DimensionSet {
  SPEND_CLASS?: SpendClass;
  FUND_GOAL?: FundGoal;
  FAMILY_AREA?: FamilyArea;
  TAX_TREATMENT?: TaxTreatment;
  PROJECT?: Project;
}

const VALUES: Record<DimensionCode, readonly string[]> = {
  SPEND_CLASS,
  FUND_GOAL,
  FAMILY_AREA,
  TAX_TREATMENT,
  PROJECT,
};

export function isDimensionValue(code: DimensionCode, value: string): boolean {
  return VALUES[code].includes(value);
}

export function assertDimensionSet(set: DimensionSet): void {
  for (const [code, value] of Object.entries(set) as [DimensionCode, string | undefined][]) {
    if (value === undefined) continue;
    if (!(code in VALUES)) throw new Error(`Unknown dimension ${code}`);
    if (!isDimensionValue(code, value)) throw new Error(`Unknown ${code} value "${value}"`);
  }
  // Dimension Combinations (BC design step 12): TRANSFER only with TAXFREE or blank; GIVING with FUND_GOAL blank.
  if (set.SPEND_CLASS === "TRANSFER" && set.TAX_TREATMENT && set.TAX_TREATMENT !== "TAXFREE") {
    throw new Error("SPEND_CLASS TRANSFER may only carry TAX_TREATMENT TAXFREE or blank");
  }
  if (set.SPEND_CLASS === "GIVING" && set.FUND_GOAL) {
    throw new Error("SPEND_CLASS GIVING may not carry a FUND_GOAL");
  }
}

/** Merge dimension sets left to right; later values win; undefined never overwrites. */
export function mergeDimensions(...sets: (DimensionSet | undefined)[]): DimensionSet {
  const out: DimensionSet = {};
  for (const s of sets) {
    if (!s) continue;
    for (const [k, v] of Object.entries(s) as [DimensionCode, string | undefined][]) {
      if (v !== undefined) (out as Record<string, string>)[k] = v;
    }
  }
  return out;
}

/** The shape BC's `dimensionSetLines` navigation property expects. */
export interface BcDimensionSetLine {
  code: string;
  valueCode: string;
}

export function toBcDimensionSetLines(set: DimensionSet): BcDimensionSetLine[] {
  assertDimensionSet(set);
  const out: BcDimensionSetLine[] = [];
  for (const code of Object.keys(DIMENSION_CODES) as DimensionCode[]) {
    const v = set[code];
    if (v) out.push({ code, valueCode: v });
  }
  return out;
}
