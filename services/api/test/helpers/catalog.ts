/** The shared category catalog as the CategoryMap the services read from the database (for pure unit tests). */
import { CATEGORIES } from "@homestead/shared";
import type { CategoryMap, CategoryRow } from "../../src/services/categories.js";
import { PAYCHECK_CATEGORY_SEEDS } from "../../src/services/paychecks/categories.js";

export function catalogMap(): CategoryMap {
  const m: CategoryMap = new Map();
  for (const c of CATEGORIES) {
    const row: CategoryRow = { id: c.id, name: c.name, group: c.group, gl_account: c.glAccount, dimension_defaults: c.dims, spend_class: c.dims.SPEND_CLASS ?? null, is_allowance: c.isAllowance, is_transfer: c.isTransfer, household_visible: c.householdVisible, examples: [...c.examples], version: 1, retired_at: null };
    m.set(c.id, row);
  }
  for (const c of PAYCHECK_CATEGORY_SEEDS) m.set(c.id, { id: c.id, name: c.name, group: c.group, gl_account: c.glAccount, dimension_defaults: {}, spend_class: null, is_allowance: false, is_transfer: false, household_visible: false, examples: [], version: 1, retired_at: null });
  return m;
}
