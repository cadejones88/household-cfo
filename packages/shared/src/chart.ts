/**
 * The posting accounts of the household chart (records/bc-setup/Account Dictionary.csv), with the
 * default dimensions each account carries. Headings and totals are not listed: the app never posts to them.
 * Bank-card accounts (101xxx, 103xxx, 201101-201401) are posted through their Bank Account card, never directly.
 */
import type { DimensionSet, FamilyArea, FundGoal, SpendClass, TaxTreatment } from "./dimensions.js";

export type AccountKind =
  | "cash" // posted via a bank account card
  | "receivable"
  | "clearing"
  | "prepaid"
  | "asset"
  | "liability_card" // posted via a bank account card
  | "liability"
  | "equity"
  | "income"
  | "giving"
  | "expense"
  | "tax"
  | "debt_cost"
  | "business_expense"
  | "suspense";

export interface ChartAccount {
  no: string;
  name: string;
  kind: AccountKind;
  /** Default dimensions from the dictionary (blank = none). */
  dims: DimensionSet;
  /** Posted through this bank account card instead of the G/L account. */
  bankCard?: BankCardCode;
}

export const BANK_CARDS = [
  "BEEHIVE-CHK",
  "BEEHIVE-CHK2",
  "BEEHIVE-SAV",
  "AFCU-CHK",
  "AFCU-SAV",
  "MACU-CHK",
  "MACU-SAV",
  "FRONTIER-SH",
  "CASH",
  "VENMO",
  "CAPONE-CC",
  "AFCU-VISA",
  "CARECREDIT",
  "AFCU-ODL",
] as const;
export type BankCardCode = (typeof BANK_CARDS)[number];

export interface BankCard {
  code: BankCardCode;
  glAccount: string;
  name: string;
  kind: "checking" | "savings" | "share" | "cash" | "wallet" | "card" | "line";
  institution: string;
  /** Last four or the suffix the family uses. Never a full number. */
  mask: string;
  /** Normal balance sign: +1 assets, -1 cards and lines (BC shows cards negative). */
  sign: 1 | -1;
}

export const BANK_CARD_LIST: readonly BankCard[] = [
  { code: "BEEHIVE-CHK", glAccount: "101101", name: "Beehive checking", kind: "checking", institution: "Beehive FCU", mask: "6289-010", sign: 1 },
  { code: "BEEHIVE-CHK2", glAccount: "101102", name: "Beehive checking 2", kind: "checking", institution: "Beehive FCU", mask: "6289-101", sign: 1 },
  { code: "BEEHIVE-SAV", glAccount: "102101", name: "Beehive savings", kind: "savings", institution: "Beehive FCU", mask: "6289-001", sign: 1 },
  { code: "AFCU-CHK", glAccount: "101201", name: "America First checking", kind: "checking", institution: "America First CU", mask: "1221", sign: 1 },
  { code: "AFCU-SAV", glAccount: "102201", name: "America First savings", kind: "savings", institution: "America First CU", mask: "1221", sign: 1 },
  { code: "MACU-CHK", glAccount: "101301", name: "Mountain America checking", kind: "checking", institution: "Mountain America CU", mask: "6068-50", sign: 1 },
  { code: "MACU-SAV", glAccount: "102301", name: "Mountain America savings", kind: "savings", institution: "Mountain America CU", mask: "6068-01", sign: 1 },
  { code: "FRONTIER-SH", glAccount: "102401", name: "Frontier share", kind: "share", institution: "Frontier CU", mask: "7003", sign: 1 },
  { code: "CASH", glAccount: "103101", name: "Cash", kind: "cash", institution: "Household", mask: "", sign: 1 },
  { code: "VENMO", glAccount: "103201", name: "Venmo", kind: "wallet", institution: "Venmo", mask: "", sign: 1 },
  { code: "CAPONE-CC", glAccount: "201101", name: "Capital One card", kind: "card", institution: "Capital One", mask: "6450", sign: -1 },
  { code: "AFCU-VISA", glAccount: "201201", name: "America First Visa", kind: "card", institution: "America First CU", mask: "1221", sign: -1 },
  { code: "CARECREDIT", glAccount: "201301", name: "CareCredit", kind: "card", institution: "Synchrony", mask: "", sign: -1 },
  { code: "AFCU-ODL", glAccount: "201401", name: "America First overdraft line", kind: "line", institution: "America First CU", mask: "1221", sign: -1 },
];

export function bankCard(code: string): BankCard {
  const c = BANK_CARD_LIST.find((b) => b.code === code);
  if (!c) throw new Error(`Unknown bank card ${code}`);
  return c;
}

type Row = [no: string, name: string, kind: AccountKind, sc?: SpendClass | "", fg?: FundGoal | "", fa?: FamilyArea | "", tt?: TaxTreatment | ""];

const ROWS: Row[] = [
  // Cash (through bank cards)
  ["101101", "Checking - Beehive FCU (x6289-010)", "cash", "", "OPERATING", "JOINT", "TAXABLE"],
  ["101102", "Checking - Beehive FCU (x6289-101)", "cash", "", "OPERATING", "JOINT", "TAXABLE"],
  ["101201", "Checking - America First CU (x1221)", "cash", "", "OPERATING", "JOINT", "TAXABLE"],
  ["101301", "Checking - Mountain America CU (x6068-50)", "cash", "", "OPERATING", "JOINT", "TAXABLE"],
  ["102101", "Savings - Beehive FCU (x6289-001)", "cash", "", "OPERATING", "JOINT", "TAXABLE"],
  ["102201", "Savings - America First CU (x1221)", "cash", "", "OPERATING", "JOINT", "TAXABLE"],
  ["102301", "Savings - Mountain America CU (x6068-01)", "cash", "", "OPERATING", "JOINT", "TAXABLE"],
  ["102401", "Share - Frontier CU (x7003)", "cash", "", "OPERATING", "JOINT", "TAXABLE"],
  ["103101", "Cash on Hand", "cash", "", "OPERATING", "JOINT", "TAXABLE"],
  ["103201", "Venmo Balance", "cash", "", "OPERATING", "JOINT", "TAXABLE"],
  // Receivables and clearing
  ["111101", "Income Tax Refund Receivable - Federal", "receivable", "", "", "JOINT", "TAXFREE"],
  ["111102", "Income Tax Refund Receivable - Idaho", "receivable", "", "", "JOINT", "TAXFREE"],
  ["112101", "Due from (to) CTJ", "receivable", "", "", "JOINT", "BASIS-ADJ"],
  ["113101", "Due from Others", "receivable", "", "", "JOINT", ""],
  ["115101", "Transfer Clearing - Own Accounts", "clearing", "TRANSFER", "", "JOINT", "TAXFREE"],
  ["115201", "Card Payment Clearing", "clearing", "TRANSFER", "", "JOINT", "TAXFREE"],
  ["115301", "Deposits in Transit", "clearing", "TRANSFER", "", "JOINT", "TAXFREE"],
  // Escrow, prepaid, other assets
  ["121101", "Mortgage Escrow Balance - PennyMac (x9114)", "prepaid", "", "", "JOINT", ""],
  ["122101", "Prepaid Insurance", "prepaid", "", "", "JOINT", ""],
  ["122901", "Other Prepaid Expenses", "prepaid", "", "", "JOINT", ""],
  ["131101", "Cash Surrender Value - NM Whole Life (Cade)", "asset", "", "", "JOINT", "TAXDEFER"],
  ["141101", "Taxable Investment Accounts", "asset", "", "", "JOINT", "TAXABLE"],
  ["142101", "Retirement Accounts", "asset", "", "", "JOINT", "TAXDEFER"],
  ["143101", "Health Savings Account", "asset", "", "", "JOINT", "TAXFREE"],
  ["151101", "Investment in Cade T. Jones CPA, P.C. (stock basis)", "asset", "", "", "CADE", "BASIS-ADJ"],
  ["151201", "Investment in CV Holdings LLC (basis)", "asset", "", "", "JOINT", "BASIS-ADJ"],
  ["151301", "Investment in 208 Armory LLC (exited)", "asset", "", "", "JOINT", "BASIS-ADJ"],
  ["161101", "2021 Chevrolet Suburban High Country", "asset", "", "", "JOINT", "NONDEDUCT"],
  ["161201", "2026 Ford F-350 Lariat FX4", "asset", "", "", "CADE", "REVIEW"],
  ["161901", "Other Vehicles and Recreational Vehicles", "asset", "", "", "JOINT", ""],
  ["171101", "Residence - Purchase Price", "asset", "", "", "JOINT", "BASIS-ADJ"],
  ["171102", "Residence - Capitalized Closing Costs", "asset", "", "", "JOINT", "BASIS-ADJ"],
  ["171201", "Residence - Capitalized Improvements", "asset", "", "", "JOINT", "BASIS-ADJ"],
  ["181101", "Firearms, Optics and Safe", "asset", "", "", "CADE", ""],
  ["181201", "Collectibles (Personal)", "asset", "", "", "JOINT", ""],
  ["181301", "Household Furnishings and Equipment (Capitalized)", "asset", "", "", "JOINT", ""],
  // Liabilities
  ["201101", "Capital One VentureOne (x6450)", "liability_card", "", "", "JOINT", ""],
  ["201201", "America First Visa Platinum (x1221)", "liability_card", "", "", "JOINT", ""],
  ["201301", "CareCredit (Synchrony)", "liability_card", "", "", "JOINT", ""],
  ["201401", "America First Overdraft Line (x1221)", "liability_card", "", "", "JOINT", ""],
  ["211101", "Accrued Property Taxes - Madison County", "liability", "", "", "JOINT", ""],
  ["211201", "Accounts Payable - Household Bills", "liability", "", "", "JOINT", ""],
  ["211301", "Due to Others", "liability", "", "", "JOINT", ""],
  ["221101", "Federal Income Tax Payable (Receivable) - Current Year", "liability", "", "", "JOINT", "REVIEW"],
  ["221201", "Idaho Income Tax Payable (Receivable) - Current Year", "liability", "", "", "JOINT", "REVIEW"],
  ["251101", "Auto Loan - Frontier CU - Suburban (x7003-0001)", "liability", "", "", "JOINT", ""],
  ["251201", "Auto Loan - Frontier CU - F-350 (x7003-0002)", "liability", "", "", "CADE", ""],
  ["271101", "Mortgage - PennyMac (x9114) - Principal", "liability", "", "", "JOINT", ""],
  ["291101", "Other Notes Payable", "liability", "", "", "JOINT", ""],
  // Equity
  ["301101", "Opening Net Worth (9/30/2026, Historical Cost)", "equity", "", "", "JOINT", ""],
  ["301201", "Accumulated Net Worth (Retained Earnings)", "equity", "", "", "JOINT", ""],
  ["301301", "Net Worth Adjustments - Prior-Period Corrections", "equity", "", "", "JOINT", ""],
  // Income
  ["401101", "Gross Wages - Henry's Fork Homes (Cade)", "income", "", "", "CADE", "TAXABLE"],
  ["401102", "Bonus Compensation - Henry's Fork Homes (Cade)", "income", "", "", "CADE", "TAXABLE"],
  ["401201", "Gross Wages - Cade T. Jones CPA, P.C. (Cade)", "income", "", "", "CADE", "TAXABLE"],
  ["401202", "Bonus Compensation - Cade T. Jones CPA, P.C. (Cade)", "income", "", "", "CADE", "TAXABLE"],
  ["401301", "Gross Wages - Vanessa", "income", "", "", "VANESSA", "TAXABLE"],
  ["402101", "Lash Services Income - Vanessa (Gross Receipts)", "income", "", "", "VANESSA", "TAXABLE"],
  ["402201", "Other Side Income (Resale, eBay, Marketplace)", "income", "", "", "JOINT", "TAXABLE"],
  ["404101", "Owner Distributions - CTJ - Cash Received", "income", "", "", "CADE", "BASIS-ADJ"],
  ["404102", "Owner Distributions - CTJ - Business-Paid Personal Items", "income", "", "", "CADE", "BASIS-ADJ"],
  ["404201", "Distributions - CV Holdings LLC", "income", "", "", "JOINT", "BASIS-ADJ"],
  ["404901", "Undistributed Pass-Through Income - CTJ (Basis Adjustment)", "income", "NONCASH", "", "CADE", "TAXABLE"],
  ["404902", "Pass-Through Income (Loss) - CV Holdings (Basis Adjustment)", "income", "NONCASH", "", "JOINT", "REVIEW"],
  ["411101", "Interest Income - Deposit Accounts", "income", "", "", "JOINT", "TAXABLE"],
  ["411201", "Dividend and Investment Income", "income", "", "", "JOINT", "TAXABLE"],
  ["411301", "Realized Gains (Losses) on Investments", "income", "", "", "JOINT", "REVIEW"],
  ["421101", "Gifts Received", "income", "", "", "JOINT", "TAXFREE"],
  ["421201", "Gain (Loss) on Sale of Vehicles and Personal Property", "income", "", "", "JOINT", "REVIEW"],
  ["421301", "Insurance Proceeds and Reimbursements", "income", "", "", "JOINT", "TAXFREE"],
  ["421901", "Miscellaneous Income", "income", "", "", "JOINT", "REVIEW"],
  // Giving
  ["501101", "Tithing", "giving", "GIVING", "", "JOINT", "DED-CHAR"],
  ["501201", "Fast Offerings", "giving", "GIVING", "", "JOINT", "DED-CHAR"],
  ["501301", "Other Church Donations (Humanitarian, Missionary, Education)", "giving", "GIVING", "", "JOINT", "DED-CHAR"],
  ["501401", "Other Charitable Contributions (501(c)(3))", "giving", "GIVING", "", "JOINT", "DED-CHAR"],
  ["501501", "Noncash Donations", "giving", "GIVING", "", "JOINT", "DED-CHAR"],
  ["501601", "Gifts to Individuals in Need (Non-Deductible)", "giving", "GIVING", "", "JOINT", "NONDEDUCT"],
  // Housing
  ["601101", "Mortgage Interest - PennyMac", "expense", "COMMITTED", "", "JOINT", "DED-MORTINT"],
  ["601102", "Mortgage Insurance (PMI)", "expense", "COMMITTED", "", "JOINT", "REVIEW"],
  ["601201", "Property Taxes - Residence", "expense", "COMMITTED", "", "JOINT", "DED-SALT"],
  ["601301", "Homeowners Insurance", "expense", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  ["601401", "Home Repairs and Maintenance", "expense", "ESSENTIAL", "SINK-HOME", "JOINT", "NONDEDUCT"],
  ["601501", "Yard, Landscaping and Snow", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  ["601601", "Home Furnishings, Décor and Small Improvements", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  ["601701", "HOA, Irrigation and Assessments", "expense", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  ["601901", "Mortgage Late Charges and Fees", "expense", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  // Utilities
  ["602101", "Electricity", "expense", "ESSENTIAL", "", "JOINT", "NONDEDUCT"],
  ["602201", "Natural Gas and Propane", "expense", "ESSENTIAL", "", "JOINT", "NONDEDUCT"],
  ["602301", "Water, Sewer and Trash", "expense", "ESSENTIAL", "", "JOINT", "NONDEDUCT"],
  ["602401", "Internet", "expense", "ESSENTIAL", "", "JOINT", "NONDEDUCT"],
  ["602501", "Mobile Phones", "expense", "ESSENTIAL", "", "JOINT", "NONDEDUCT"],
  // Food and household goods
  ["603101", "Groceries", "expense", "ESSENTIAL", "", "JOINT", "NONDEDUCT"],
  ["603201", "Walmart - Unallocated", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  ["603301", "Household Supplies and Consumables", "expense", "ESSENTIAL", "", "JOINT", "NONDEDUCT"],
  ["603401", "Warehouse Clubs - Unallocated (Sam's, Costco)", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  ["603501", "Dining Out and Restaurants", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  ["603601", "Food Delivery (DoorDash, etc.)", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  ["603701", "Coffee, Snacks and Treats", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  ["603801", "Amazon - Unallocated", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  // Transportation
  ["604101", "Fuel", "expense", "ESSENTIAL", "", "JOINT", "REVIEW"],
  ["604201", "Vehicle Repairs and Maintenance", "expense", "ESSENTIAL", "SINK-VEHICLE", "JOINT", "REVIEW"],
  ["604301", "Tires", "expense", "ESSENTIAL", "SINK-VEHICLE", "JOINT", "REVIEW"],
  ["604401", "Auto Insurance", "expense", "COMMITTED", "", "JOINT", "REVIEW"],
  ["604501", "Registration, Licenses and Vehicle Taxes", "expense", "COMMITTED", "", "JOINT", "REVIEW"],
  ["604601", "Car Washes and Detailing", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  ["604701", "Parking, Tolls, Rideshare and Transit", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  ["604801", "Vehicle Accessories and Aftermarket", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  ["604901", "Vehicle Reimbursement from CTJ (Contra)", "expense", "COMMITTED", "", "CADE", "DED-BUS"],
  // Insurance and protection
  ["605101", "Life Insurance Premiums - Cade (NM Term + Whole Life)", "expense", "COMMITTED", "", "CADE", "NONDEDUCT"],
  ["605201", "Life Insurance Premiums - Vanessa (Term)", "expense", "COMMITTED", "", "VANESSA", "NONDEDUCT"],
  ["605301", "Health Insurance / Health-Share Premiums", "expense", "ESSENTIAL", "", "JOINT", "DED-MED"],
  ["605401", "Identity Protection and Security", "expense", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  ["605501", "Disability and Umbrella Insurance", "expense", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  // Health and medical
  ["606101", "Doctor and Clinic Visits", "expense", "ESSENTIAL", "SINK-MED", "JOINT", "DED-MED"],
  ["606201", "Prescriptions and Pharmacy", "expense", "ESSENTIAL", "SINK-MED", "JOINT", "DED-MED"],
  ["606301", "Dental and Orthodontics", "expense", "ESSENTIAL", "SINK-MED", "JOINT", "DED-MED"],
  ["606401", "Vision", "expense", "ESSENTIAL", "SINK-MED", "JOINT", "DED-MED"],
  ["606501", "Hospital, Urgent Care and Labs", "expense", "ESSENTIAL", "SINK-MED", "JOINT", "DED-MED"],
  ["606601", "Counseling and Therapy", "expense", "ESSENTIAL", "", "JOINT", "DED-MED"],
  ["606701", "Vitamins, Supplements and OTC", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  ["606801", "Medical Equipment and Other", "expense", "ESSENTIAL", "", "JOINT", "DED-MED"],
  // Children and education
  ["607101", "School Fees, Lunches and Supplies", "expense", "COMMITTED", "SINK-SCHOOL", "KIDS", "NONDEDUCT"],
  ["607201", "Childcare and Babysitting", "expense", "ESSENTIAL", "", "KIDS", "NONDEDUCT"],
  ["607301", "Children's Activities, Sports and Lessons", "expense", "FLEXIBLE", "SINK-SCHOOL", "KIDS", "NONDEDUCT"],
  ["607401", "Children's Allowances and Spending", "expense", "DISCRETIONARY", "", "KIDS", "NONDEDUCT"],
  ["607501", "Tuition and Education Savings Spending", "expense", "COMMITTED", "EDUCATION", "KIDS", "NONDEDUCT"],
  // Clothing and personal care
  ["608101", "Clothing and Shoes", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  ["608201", "Haircuts, Salon and Personal Care", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  ["608301", "Beauty and Cosmetics", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  // Shopping
  ["609101", "Electronics and Computers", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  ["609201", "Tools, Shop and Hardware", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  ["609301", "Appliances and Housewares", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  ["609401", "General Merchandise (Wants)", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  ["609501", "Gifts Given and Celebrations", "expense", "DISCRETIONARY", "SINK-GIFTS", "JOINT", "NONDEDUCT"],
  // Subscriptions
  ["610101", "Streaming Services", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  ["610201", "Software, Apps and Cloud", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  ["610301", "Memberships (Clubs, Gym)", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  ["610401", "Other Subscriptions", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  // Hobbies, recreation, travel
  ["611101", "Trading Cards and Collectibles (Hobby)", "expense", "DISCRETIONARY", "", "CADE", "NONDEDUCT"],
  ["611201", "Hunting, Shooting and Outdoors", "expense", "DISCRETIONARY", "", "CADE", "NONDEDUCT"],
  ["611301", "Sports, Fitness and Recreation", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  ["611401", "Entertainment and Events", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  ["611501", "Travel - Lodging and Transportation", "expense", "DISCRETIONARY", "SINK-TRAVEL", "JOINT", "NONDEDUCT"],
  ["611601", "Travel - Meals and Activities", "expense", "DISCRETIONARY", "SINK-TRAVEL", "JOINT", "NONDEDUCT"],
  ["611701", "Camping and Recreation Equipment", "expense", "DISCRETIONARY", "", "JOINT", "NONDEDUCT"],
  // Allowances
  ["612101", "Allowance - Cade", "expense", "DISCRETIONARY", "", "CADE", "NONDEDUCT"],
  ["612201", "Allowance - Vanessa", "expense", "DISCRETIONARY", "", "VANESSA", "NONDEDUCT"],
  // Professional, fees, misc
  ["613101", "Tax Preparation, Accounting and Legal", "expense", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  ["613201", "Bank Fees and Service Charges", "expense", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  ["613301", "Postage, Shipping and Office", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  ["613401", "Payments to Individuals (Venmo/Zelle/Cash) - to Classify", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  ["613501", "Cash Spending - Unitemized", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  ["613901", "Other Living Expenses", "expense", "FLEXIBLE", "", "JOINT", "NONDEDUCT"],
  // Income and payroll taxes
  ["701101", "Federal Income Tax Withheld - HFH", "tax", "COMMITTED", "", "CADE", ""],
  ["701102", "Federal Income Tax Withheld - CTJ", "tax", "COMMITTED", "", "CADE", ""],
  ["701201", "Idaho Income Tax Withheld - HFH", "tax", "COMMITTED", "", "CADE", "DED-SALT"],
  ["701202", "Idaho Income Tax Withheld - CTJ", "tax", "COMMITTED", "", "CADE", "DED-SALT"],
  ["701301", "Social Security Tax Withheld - HFH", "tax", "COMMITTED", "", "CADE", "NONDEDUCT"],
  ["701302", "Social Security Tax Withheld - CTJ", "tax", "COMMITTED", "", "CADE", "NONDEDUCT"],
  ["701401", "Medicare Tax Withheld - HFH", "tax", "COMMITTED", "", "CADE", "NONDEDUCT"],
  ["701402", "Medicare Tax Withheld - CTJ", "tax", "COMMITTED", "", "CADE", "NONDEDUCT"],
  ["701501", "Prior-Year Income Tax True-Up (Refunds / Balances Due)", "tax", "COMMITTED", "", "JOINT", ""],
  ["701601", "Estimated Tax Payments", "tax", "COMMITTED", "", "JOINT", ""],
  ["701701", "Self-Employment Tax - Lash (Year-End)", "tax", "COMMITTED", "", "VANESSA", "REVIEW"],
  ["701801", "Other Payroll Deductions", "tax", "COMMITTED", "", "JOINT", "REVIEW"],
  // Consumer debt interest and fees
  ["711101", "Interest - Capital One", "debt_cost", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  ["711201", "Interest - America First Visa", "debt_cost", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  ["711301", "Interest - CareCredit (incl. Deferred-Interest Charges)", "debt_cost", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  ["711401", "Interest - Overdraft Line", "debt_cost", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  ["711501", "Interest - Auto Loan Suburban (Frontier)", "debt_cost", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  ["711601", "Interest - Auto Loan F-350 (Frontier)", "debt_cost", "COMMITTED", "", "CADE", "REVIEW"],
  ["711701", "Late, NSF and Overdraft Fees", "debt_cost", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  ["711801", "Cash Advance Fees", "debt_cost", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  ["711901", "Card Annual Fees", "debt_cost", "COMMITTED", "", "JOINT", "NONDEDUCT"],
  // Lash business (Schedule C)
  ["731101", "Lash Supplies and Products", "business_expense", "COMMITTED", "", "VANESSA", "DED-BUS"],
  ["731201", "Lash Licensing, Training and Fees", "business_expense", "COMMITTED", "", "VANESSA", "DED-BUS"],
  ["731301", "Lash - Other Business Expenses", "business_expense", "COMMITTED", "", "VANESSA", "DED-BUS"],
  // Suspense
  ["901101", "Uncategorized Transactions - Suspense", "suspense", "FLEXIBLE", "", "JOINT", "REVIEW"],
  ["901201", "Reconciliation Differences - Suspense", "suspense", "FLEXIBLE", "", "JOINT", "REVIEW"],
];

const cardByGl = new Map<string, BankCardCode>(BANK_CARD_LIST.map((b) => [b.glAccount, b.code]));

export const CHART: readonly ChartAccount[] = ROWS.map(([no, name, kind, sc, fg, fa, tt]) => {
  const dims: DimensionSet = {};
  if (sc) dims.SPEND_CLASS = sc;
  if (fg) dims.FUND_GOAL = fg;
  if (fa) dims.FAMILY_AREA = fa;
  if (tt) dims.TAX_TREATMENT = tt;
  const acct: ChartAccount = { no, name, kind, dims };
  const card = cardByGl.get(no);
  if (card) acct.bankCard = card;
  return acct;
});

const byNo = new Map(CHART.map((a) => [a.no, a]));

export function account(no: string): ChartAccount {
  const a = byNo.get(no);
  if (!a) throw new Error(`Unknown posting account ${no}`);
  return a;
}

export function isPostingAccount(no: string): boolean {
  return byNo.has(no);
}

/** Accounts the app may never post to directly (through a bank card only). */
export function mustPostThroughBankCard(no: string): boolean {
  return cardByGl.has(no);
}

/** Accounts that are excluded from "spending" (transfers, principal, clearing, noncash). */
export function isSpendingAccount(no: string): boolean {
  const a = account(no);
  return (a.kind === "expense" || a.kind === "giving" || a.kind === "debt_cost" || a.kind === "tax" || a.kind === "business_expense") && a.dims.SPEND_CLASS !== "NONCASH";
}

/** The "unallocated" accounts whose balance BC's monthly allocation clears. */
export const UNALLOCATED_ACCOUNTS = { walmart: "603201", club: "603401", amazon: "603801" } as const;

/**
 * The household's installment debts and the accounts BC's recurring journals (MORTGAGE, LOANS) split each payment
 * into (records/bc-setup/Account Dictionary.csv; sandbox test T08 for the mortgage split). Used for the Console's
 * loan rollforward: principal is the liability account, the rest are the period's postings to the other accounts.
 */
export interface LoanDefinition {
  id: "pennymac" | "frontier-suburban" | "frontier-f350";
  name: string;
  lender: string;
  mask: string;
  /** The liability (principal) account. */
  glAccount: string;
  interestAccount: string;
  /** Mortgage insurance and late charges, reported together as fees. */
  feeAccounts: readonly string[];
  escrowAccount?: string;
  /** The seeded bill this payment matches (bills.name starts with this). */
  billNamePrefix: string;
}

export const LOANS: readonly LoanDefinition[] = [
  { id: "pennymac", name: "Mortgage", lender: "PennyMac", mask: "9114", glAccount: "271101", interestAccount: "601101", feeAccounts: ["601102", "601901"], escrowAccount: "121101", billNamePrefix: "PennyMac" },
  { id: "frontier-suburban", name: "Suburban loan", lender: "Frontier CU", mask: "7003-0001", glAccount: "251101", interestAccount: "711501", feeAccounts: [], billNamePrefix: "Frontier CU · Suburban" },
  { id: "frontier-f350", name: "F-350 loan", lender: "Frontier CU", mask: "7003-0002", glAccount: "251201", interestAccount: "711601", feeAccounts: [], billNamePrefix: "Frontier CU · F-350" },
];

/**
 * Accounts approved for BC that may not exist in a company yet; a bonus to one of them posts to gross wages with a
 * BONUS comment instead. Empty since October 21, 2026: 401102 and 401202 (BC change 5) exist in the sandbox, read back
 * by the acceptance run. Where the chart has been read from BC, the paycheck builder checks that list instead.
 */
export const PENDING_SANDBOX_ACCOUNTS: readonly string[] = [];
