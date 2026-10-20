/**
 * The household's categories as stored (seeded from @homestead/shared CATEGORIES, versioned per household).
 */
import type { DimensionSet } from "@homestead/shared";
import type { Queryable } from "../db/index.js";

export interface CategoryRow {
  id: string;
  name: string;
  group: string;
  gl_account: string;
  dimension_defaults: DimensionSet;
  spend_class: string | null;
  is_allowance: boolean;
  is_transfer: boolean;
  household_visible: boolean;
  examples: string[];
  version: number;
  retired_at: string | null;
}

export type CategoryMap = Map<string, CategoryRow>;

export async function loadCategories(db: Queryable, householdId: string): Promise<CategoryMap> {
  const r = await db.query<CategoryRow>(
    `select id, name, "group", gl_account, dimension_defaults, spend_class, is_allowance, is_transfer, household_visible, examples, version, retired_at
       from categories where household_id = $1 and retired_at is null order by "group", name`,
    [householdId],
  );
  return new Map(r.rows.map((c) => [c.id, c]));
}

export function requireCategory(cats: CategoryMap, id: string): CategoryRow {
  const c = cats.get(id);
  if (!c) throw new Error(`Unknown category ${id}`);
  return c;
}

/** Income group categories count as money in; transfers never count as spending. */
export function categoryKind(c: CategoryRow): "spend" | "income" | "transfer" {
  if (c.is_transfer) return "transfer";
  if (c.group === "Income") return "income";
  return "spend";
}
