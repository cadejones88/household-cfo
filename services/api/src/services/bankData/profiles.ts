/**
 * Import profiles: one parser profile per institution (column map, date format, sign convention), stored as
 * data in `import_profiles`, mirroring BC's Data Exchange Definitions. These are plausible shapes for the
 * exports each institution offers; the first real file from each confirms or adjusts the profile.
 *
 * Sign convention: Homestead stores bank sign (negative = money out). A card export that lists charges as
 * positive numbers is `inverted`; an export with separate Debit/Credit columns is `debit_credit`.
 */
export type ImportFormat = "csv" | "ofx" | "qfx" | "pdf";

export interface CsvProfileSpec {
  format: "csv";
  delimiter?: string;
  hasHeader: boolean;
  columns: {
    date: string;
    /** Signed amount column, or use debit/credit. */
    amount?: string;
    debit?: string;
    credit?: string;
    description: string;
    memo?: string;
    reference?: string;
    postedDate?: string;
  };
  dateFormat: "MM/DD/YYYY" | "M/D/YYYY" | "YYYY-MM-DD" | "MM-DD-YYYY";
  sign: "bank" | "inverted" | "debit_credit";
  /** Rows whose description matches are not transactions (running balance lines, headers repeated). */
  skipPatterns?: string[];
}

export interface OfxProfileSpec {
  format: "ofx" | "qfx";
  sign: "bank" | "inverted";
}

export interface PdfProfileSpec {
  format: "pdf";
  /** Column headings Document Intelligence's layout model should find on the statement table. */
  table: { date: string; description: string; amount: string };
  dateFormat: CsvProfileSpec["dateFormat"];
  sign: "bank" | "inverted";
  /** How the statement number is found for the `pdf:` key. */
  statementNoPattern: string;
}

export type ImportProfileSpec = CsvProfileSpec | OfxProfileSpec | PdfProfileSpec;

export interface ImportProfileSeed {
  name: string;
  institution: string;
  format: ImportFormat;
  spec: ImportProfileSpec;
}

export const IMPORT_PROFILE_SEEDS: readonly ImportProfileSeed[] = [
  {
    name: "Beehive FCU CSV",
    institution: "Beehive FCU",
    format: "csv",
    spec: {
      format: "csv",
      hasHeader: true,
      columns: { date: "Date", amount: "Amount", description: "Description", memo: "Memo", reference: "Transaction ID" },
      dateFormat: "MM/DD/YYYY",
      sign: "bank",
      skipPatterns: ["^Beginning Balance", "^Ending Balance"],
    },
  },
  {
    name: "America First CSV",
    institution: "America First CU",
    format: "csv",
    spec: {
      format: "csv",
      hasHeader: true,
      columns: { date: "Posting Date", debit: "Debit", credit: "Credit", description: "Description", postedDate: "Posting Date" },
      dateFormat: "MM/DD/YYYY",
      sign: "debit_credit",
    },
  },
  {
    name: "Capital One CSV",
    institution: "Capital One",
    format: "csv",
    spec: {
      format: "csv",
      hasHeader: true,
      columns: { date: "Transaction Date", postedDate: "Posted Date", debit: "Debit", credit: "Credit", description: "Description" },
      dateFormat: "YYYY-MM-DD",
      sign: "debit_credit",
    },
  },
  {
    name: "Synchrony CareCredit statement PDF",
    institution: "Synchrony",
    format: "pdf",
    spec: {
      format: "pdf",
      table: { date: "Date", description: "Description", amount: "Amount" },
      dateFormat: "MM/DD/YYYY",
      sign: "inverted",
      statementNoPattern: "Statement\\s+(?:Closing\\s+)?Date[:\\s]+(\\d{2}/\\d{2}/\\d{4})",
    },
  },
  { name: "OFX/QFX (any bank)", institution: "Any", format: "ofx", spec: { format: "ofx", sign: "bank" } },
  { name: "OFX/QFX (card, charges positive)", institution: "Any card", format: "qfx", spec: { format: "qfx", sign: "inverted" } },
];
