/**
 * Household words for categories. The shared catalog (`@homestead/shared` CATEGORIES) is the source; a few
 * budget-group names the API may use at a coarser grain (and the mock uses) are listed as well, so a row
 * never shows a raw id. BC account numbers never appear on a household screen.
 */
import { CATEGORIES, householdCategories, type Category } from "@homestead/shared";

const byId = new Map(CATEGORIES.map((c) => [c.id, c]));

/** Coarser budget groups the budget screen may show (one line per group) and loan/mortgage kinds. */
const GROUP_NAMES: Record<string, string> = {
  giving: "Giving",
  housing: "Housing",
  utilities: "Utilities",
  "groceries-household": "Groceries & household",
  "eating-out-treats": "Eating out & treats",
  "gas-car": "Gas & car",
  "kids-school": "Kids & school",
  "fun-shopping": "Fun & shopping",
  subscriptions: "Subscriptions",
  health: "Health",
  clothes: "Clothes",
  "gifts-group": "Gifts",
  "car-loan": "Car loan",
  mortgage: "Mortgage",
  "money-in": "Money in",
  paycheck: "Paycheck",
};

export function categoryName(id: string | undefined): string {
  if (!id) return "Needs a category";
  const c = byId.get(id);
  if (c) return c.name;
  const g = GROUP_NAMES[id];
  if (g) return g;
  return id.replace(/[-_]+/g, " ").replace(/^\w/, (m) => m.toUpperCase());
}

export interface CategoryOption {
  id: string;
  name: string;
  group: string;
}

/** The categories a person may pick from in "This is wrong" and the question cards (household-visible only). */
export function pickableCategories(): CategoryOption[] {
  return householdCategories()
    .filter((c) => !c.isTransfer && c.group !== "Income" && c.group !== "Debt costs" && c.group !== "Suspense" && c.group !== "Unsplit")
    .map((c) => ({ id: c.id, name: c.name, group: c.group }));
}

/** Five suggestions for a wrong item: common everyday categories, minus the current one. */
export function suggestedCategories(currentId: string | undefined, merchant?: string): CategoryOption[] {
  const base = ["groceries", "eating-out", "fuel", "school", "general-merchandise", "household-supplies", "treats", "gifts"];
  const m = (merchant ?? "").toLowerCase();
  const byMerchant = CATEGORIES.filter((c) => c.householdVisible && c.examples.some((e) => m && m.includes(e.toLowerCase().split(" ")[0] ?? ""))).map((c) => c.id);
  const ordered = [...new Set([...byMerchant, ...base])].filter((id) => id !== currentId);
  return ordered.slice(0, 5).map((id) => {
    const c = byId.get(id) as Category;
    return { id: c.id, name: c.name, group: c.group };
  });
}

export function isAllowanceCategory(id: string | undefined): boolean {
  return id !== undefined && (byId.get(id)?.isAllowance ?? false);
}
