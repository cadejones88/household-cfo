/**
 * The household's words for the chart. Vanessa sees these names; BC sees the accounts.
 * Each category maps to exactly one posting account and inherits that account's default dimensions.
 * Versioned in the database (`categories` table, seeded from this list); the code copy is the v1 seed.
 */
import { account, type ChartAccount } from "./chart.js";
import type { DimensionSet } from "./dimensions.js";
import { mergeDimensions } from "./dimensions.js";

export type CategoryGroup =
  | "Food"
  | "Home"
  | "Utilities"
  | "Transportation"
  | "Insurance"
  | "Health"
  | "Kids"
  | "Personal"
  | "Shopping"
  | "Subscriptions"
  | "Fun"
  | "Allowance"
  | "Giving"
  | "Fees and other"
  | "Debt costs"
  | "Lash business"
  | "Income"
  | "Transfers"
  | "Unsplit"
  | "Suspense";

export interface Category {
  /** Stable slug used in rules, splits and the app. */
  id: string;
  name: string;
  group: CategoryGroup;
  glAccount: string;
  /** Default dimensions: the account's, overlaid with any category-specific values. */
  dims: DimensionSet;
  /** Rule learning never targets an allowance; allowances never alert (I-10). */
  isAllowance: boolean;
  /** Things that are never "spending": transfers, card payments, principal. */
  isTransfer: boolean;
  /** Shown to the household by default (false = CFO only). */
  householdVisible: boolean;
  /** A few merchant words to help the model and the rule proposer. */
  examples: readonly string[];
}

type Seed = [id: string, name: string, group: CategoryGroup, gl: string, examples?: string[], opts?: Partial<Pick<Category, "isAllowance" | "isTransfer" | "householdVisible" | "dims">>];

const SEEDS: Seed[] = [
  // Food
  ["groceries", "Groceries", "Food", "603101", ["Broulim's", "Albertsons", "WinCo", "Smith's"]],
  ["household-supplies", "Household supplies", "Food", "603301", ["paper towels", "cleaning", "toiletries"]],
  ["eating-out", "Eating out", "Food", "603501", ["restaurant", "Chick-fil-A", "Cafe Rio", "takeout"]],
  ["food-delivery", "Food delivery", "Food", "603601", ["DoorDash", "Uber Eats"]],
  ["treats", "Coffee and treats", "Food", "603701", ["Maverik snacks", "Sodalicious", "Swig", "coffee"]],
  // Unsplit (receipt-required merchants before the split)
  ["walmart-unsplit", "Walmart (not split yet)", "Unsplit", "603201", ["Walmart"], { householdVisible: false }],
  ["club-unsplit", "Club store (not split yet)", "Unsplit", "603401", ["Sam's Club", "Costco"], { householdVisible: false }],
  ["amazon-unsplit", "Amazon (not split yet)", "Unsplit", "603801", ["Amazon", "AMZN"], { householdVisible: false }],
  // Home
  ["home-repairs", "Home repairs", "Home", "601401", ["Home Depot", "Lowe's", "plumber", "furnace filter"]],
  ["yard-snow", "Yard and snow", "Home", "601501", ["lawn", "sprinklers", "snow removal"]],
  ["home-decor", "Home decor and small improvements", "Home", "601601", ["Hobby Lobby", "decor", "rug"]],
  ["hoa", "HOA and irrigation", "Home", "601701", ["HOA", "canal company"]],
  ["mortgage-fees", "Mortgage fees", "Home", "601901", ["late charge"], { householdVisible: false }],
  // Utilities
  ["electricity", "Electricity", "Utilities", "602101", ["Rocky Mountain Power", "Fall River Electric"]],
  ["gas-propane", "Gas and propane", "Utilities", "602201", ["Intermountain Gas", "propane"]],
  ["water-sewer-trash", "Water, sewer and trash", "Utilities", "602301", ["City of Rexburg", "Clear Management"]],
  ["internet", "Internet", "Utilities", "602401", ["internet"]],
  ["phones", "Phones", "Utilities", "602501", ["Verizon"]],
  // Transportation
  ["fuel", "Fuel", "Transportation", "604101", ["Maverik", "Valley Wide", "Chevron", "Sinclair", "diesel"]],
  ["car-repairs", "Car repairs and maintenance", "Transportation", "604201", ["oil change", "Jiffy Lube", "mechanic"]],
  ["tires", "Tires", "Transportation", "604301", ["Les Schwab", "tires"]],
  ["car-insurance", "Car insurance", "Transportation", "604401", ["auto insurance"]],
  ["registration", "Registration and licenses", "Transportation", "604501", ["DMV", "registration"]],
  ["car-wash", "Car wash", "Transportation", "604601", ["car wash"]],
  ["parking-rides", "Parking, tolls and rides", "Transportation", "604701", ["parking", "Uber", "Lyft"]],
  ["car-accessories", "Car accessories", "Transportation", "604801", ["floor mats", "accessories"]],
  // Insurance
  ["life-insurance-cade", "Life insurance (Cade)", "Insurance", "605101", ["Northwestern Mutual"]],
  ["life-insurance-vanessa", "Life insurance (Vanessa)", "Insurance", "605201", ["term life"]],
  ["health-insurance", "Health insurance", "Insurance", "605301", ["health share", "premium"]],
  ["identity-protection", "Identity protection", "Insurance", "605401", ["Norton", "LifeLock"]],
  ["other-insurance", "Disability and umbrella insurance", "Insurance", "605501", []],
  // Health
  ["doctor", "Doctor visits", "Health", "606101", ["clinic", "copay", "pediatrics"]],
  ["pharmacy", "Pharmacy", "Health", "606201", ["Walgreens pharmacy", "prescription"]],
  ["dental", "Dental and orthodontics", "Health", "606301", ["dentist", "orthodontist", "CareCredit charge"]],
  ["vision", "Vision", "Health", "606401", ["eye exam", "glasses", "contacts"]],
  ["hospital-urgent-care", "Hospital and urgent care", "Health", "606501", ["Madison Memorial", "urgent care", "labs"]],
  ["counseling", "Counseling", "Health", "606601", ["counseling", "therapy"]],
  ["vitamins-otc", "Vitamins and over-the-counter", "Health", "606701", ["vitamins", "Tylenol"]],
  ["medical-equipment", "Medical equipment and other", "Health", "606801", []],
  // Kids
  ["school", "School fees, lunches and supplies", "Kids", "607101", ["Madison School District", "school lunch"]],
  ["childcare", "Childcare and babysitting", "Kids", "607201", ["babysitter", "daycare"]],
  ["kids-activities", "Kids activities and sports", "Kids", "607301", ["softball", "lessons", "camp"]],
  ["kids-spending", "Kids allowances and spending", "Kids", "607401", []],
  ["tuition", "Tuition and education", "Kids", "607501", ["tuition"]],
  // Personal
  ["clothing", "Clothing and shoes", "Personal", "608101", ["Old Navy", "Target clothing", "shoes"]],
  ["haircuts", "Haircuts and personal care", "Personal", "608201", ["haircut", "salon", "barber"]],
  ["beauty", "Beauty and cosmetics", "Personal", "608301", ["Ulta", "Sephora", "makeup"]],
  // Shopping
  ["electronics", "Electronics", "Shopping", "609101", ["Best Buy", "Apple", "charger"]],
  ["tools", "Tools and hardware", "Shopping", "609201", ["Harbor Freight", "tools"]],
  ["appliances", "Appliances and housewares", "Shopping", "609301", ["blender", "housewares"]],
  ["general-merchandise", "General merchandise", "Shopping", "609401", ["Target", "toys", "misc"]],
  ["gifts", "Gifts and celebrations", "Shopping", "609501", ["birthday gift", "Christmas", "party"]],
  // Subscriptions
  ["streaming", "Streaming", "Subscriptions", "610101", ["Netflix", "Disney+", "Spotify", "YouTube"]],
  ["software", "Software and cloud", "Subscriptions", "610201", ["iCloud", "Google One", "Microsoft 365"]],
  ["memberships", "Memberships", "Subscriptions", "610301", ["Costco membership", "Sam's Club membership", "gym"]],
  ["other-subscriptions", "Other subscriptions", "Subscriptions", "610401", ["subscription box"]],
  // Fun
  ["cards-hobby", "Trading cards (hobby)", "Fun", "611101", ["card shop", "eBay cards", "Topps"]],
  ["outdoors", "Hunting, shooting and outdoors", "Fun", "611201", ["Sportsman's Warehouse", "ammo", "hunting license"]],
  ["sports-rec", "Sports and recreation", "Fun", "611301", ["rec center", "fitness"]],
  ["entertainment", "Entertainment and events", "Fun", "611401", ["movies", "tickets", "Fat Cats"]],
  ["travel-lodging", "Travel: lodging and transportation", "Fun", "611501", ["hotel", "Airbnb", "flights"]],
  ["travel-meals", "Travel: meals and activities", "Fun", "611601", ["vacation meals", "excursion"]],
  ["camping-gear", "Camping and recreation gear", "Fun", "611701", ["camping", "REI"]],
  // Allowance
  ["allowance-cade", "Cade's allowance", "Allowance", "612101", [], { isAllowance: true }],
  ["allowance-vanessa", "Vanessa's allowance", "Allowance", "612201", [], { isAllowance: true }],
  // Fees and other
  ["tax-prep-legal", "Tax prep, accounting and legal", "Fees and other", "613101", ["attorney", "accounting"]],
  ["bank-fees", "Bank fees", "Fees and other", "613201", ["service charge", "monthly fee"]],
  ["postage-office", "Postage, shipping and office", "Fees and other", "613301", ["USPS", "UPS", "office supplies"]],
  ["payments-to-people", "Payments to people (to classify)", "Fees and other", "613401", ["Venmo payment", "Zelle"]],
  ["cash-spending", "Cash spending", "Fees and other", "613501", ["cash"]],
  ["other", "Other", "Fees and other", "613901", []],
  // Giving
  ["tithing", "Tithing", "Giving", "501101", ["Church of Jesus Christ", "LDS donation", "tithing"]],
  ["fast-offerings", "Fast offerings", "Giving", "501201", ["fast offering"]],
  ["church-donations", "Other church donations", "Giving", "501301", ["humanitarian", "missionary fund"]],
  ["charity", "Charity", "Giving", "501401", ["donation"]],
  ["noncash-donations", "Donated goods", "Giving", "501501", ["DI donation", "Goodwill"]],
  ["gifts-to-people-in-need", "Help for someone in need", "Giving", "501601", []],
  // Debt costs (CFO classifies; household sees them read-only)
  ["interest-capital-one", "Interest: Capital One", "Debt costs", "711101", ["interest charge"], { householdVisible: false }],
  ["interest-afcu-visa", "Interest: America First Visa", "Debt costs", "711201", ["interest charge"], { householdVisible: false }],
  ["interest-carecredit", "Interest: CareCredit", "Debt costs", "711301", ["interest charge"], { householdVisible: false }],
  ["interest-overdraft", "Interest: overdraft line", "Debt costs", "711401", ["interest"], { householdVisible: false }],
  ["interest-suburban", "Interest: Suburban loan", "Debt costs", "711501", [], { householdVisible: false }],
  ["interest-f350", "Interest: F-350 loan", "Debt costs", "711601", [], { householdVisible: false }],
  ["late-nsf-fees", "Late, NSF and overdraft fees", "Debt costs", "711701", ["late fee", "NSF", "overdraft fee"], { householdVisible: false }],
  ["cash-advance-fees", "Cash advance fees", "Debt costs", "711801", ["cash advance fee"], { householdVisible: false }],
  ["card-annual-fees", "Card annual fees", "Debt costs", "711901", ["annual fee"], { householdVisible: false }],
  // Lash business (Vanessa)
  ["lash-supplies", "Lash supplies", "Lash business", "731101", ["lash supplies", "adhesive"]],
  ["lash-licensing", "Lash licensing and training", "Lash business", "731201", ["cosmetology license", "training"]],
  ["lash-other", "Lash: other business costs", "Lash business", "731301", []],
  // Income
  ["income-hfh-wages", "Paycheck: Henry's Fork Homes", "Income", "401101", ["HENRYS FORK", "PAYCHEX"]],
  ["income-hfh-bonus", "Bonus: Henry's Fork Homes", "Income", "401102", []],
  ["income-ctj-wages", "Paycheck: CTJ", "Income", "401201", ["GUSTO", "CADE T JONES CPA"]],
  ["income-ctj-bonus", "Bonus: CTJ", "Income", "401202", []],
  ["income-vanessa-wages", "Paycheck: Vanessa", "Income", "401301", []],
  ["income-lash", "Lash income", "Income", "402101", ["Venmo lash"]],
  ["income-side", "Side income (resale)", "Income", "402201", ["eBay", "Facebook Marketplace"]],
  ["income-ctj-draw", "CTJ draw", "Income", "404101", ["CADE T JONES CPA draw"]],
  ["income-ctj-paid-personal", "Paid by CTJ (personal item)", "Income", "404102", [], { householdVisible: false }],
  ["income-interest", "Interest earned", "Income", "411101", ["dividend", "interest"]],
  ["income-gifts", "Gifts received", "Income", "421101", []],
  ["income-insurance-proceeds", "Insurance proceeds and reimbursements", "Income", "421301", []],
  ["income-misc", "Other income", "Income", "421901", ["cash back", "rewards"]],
  // Transfers (never spending)
  ["transfer-own", "Transfer between our accounts", "Transfers", "115101", ["transfer"], { isTransfer: true }],
  ["card-payment", "Credit card payment", "Transfers", "115201", ["payment thank you", "AUTOPAY"], { isTransfer: true }],
  ["deposit-in-transit", "Deposit in transit", "Transfers", "115301", [], { isTransfer: true, householdVisible: false }],
  ["cash-withdrawal", "Cash withdrawal", "Transfers", "103101", ["ATM"], { isTransfer: true }],
  ["venmo-cashout", "Venmo to bank", "Transfers", "103201", ["Venmo cashout"], { isTransfer: true }],
  ["due-from-ctj", "Business expense on our card (CTJ owes us)", "Transfers", "112101", [], { isTransfer: true, householdVisible: false }],
  // Suspense
  ["uncategorized", "Not categorized yet", "Suspense", "901101", [], { householdVisible: false }],
];

export const CATEGORIES: readonly Category[] = SEEDS.map(([id, name, group, gl, examples, opts]) => {
  const acct: ChartAccount = account(gl);
  return {
    id,
    name,
    group,
    glAccount: gl,
    dims: mergeDimensions(acct.dims, opts?.dims),
    isAllowance: opts?.isAllowance ?? false,
    isTransfer: opts?.isTransfer ?? false,
    householdVisible: opts?.householdVisible ?? true,
    examples: examples ?? [],
  };
});

const byId = new Map(CATEGORIES.map((c) => [c.id, c]));
const byGl = new Map<string, Category[]>();
for (const c of CATEGORIES) {
  const list = byGl.get(c.glAccount) ?? [];
  list.push(c);
  byGl.set(c.glAccount, list);
}

export function category(id: string): Category {
  const c = byId.get(id);
  if (!c) throw new Error(`Unknown category ${id}`);
  return c;
}

export function categoriesForAccount(glAccount: string): readonly Category[] {
  return byGl.get(glAccount) ?? [];
}

export function householdCategories(): readonly Category[] {
  return CATEGORIES.filter((c) => c.householdVisible);
}

export const CATEGORY_CATALOG_VERSION = 1;

/** Merchants whose lines need a receipt before classification (state Needs receipt) when $25 or more. */
export const RECEIPT_REQUIRED_MERCHANTS: readonly { pattern: RegExp; unsplitCategory: string }[] = [
  { pattern: /\bwal-?mart\b|\bwm supercenter\b/i, unsplitCategory: "walmart-unsplit" },
  { pattern: /\bsam'?s club\b|\bcostco\b/i, unsplitCategory: "club-unsplit" },
  { pattern: /\bamazon\b|\bamzn\b/i, unsplitCategory: "amazon-unsplit" },
];

/** The receipt threshold and the materiality line used by rules R6 and the duplicate alert. */
export const RECEIPT_THRESHOLD_CENTS = 2500;
export const MATERIALITY_CENTS = 2500;
