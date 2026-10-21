/**
 * File import (spec: "File import"): CSV, OFX/QFX and statement PDFs dropped into the Console land in the same
 * staging path as Plaid rows, with the same states, duplicate checks and keys. Each institution has a parser
 * profile stored as data (import_profiles, seeded from profiles.ts). A row that matches an existing transaction by
 * account, date and amount within 3 days from another source is marked Possible Duplicate, never merged silently.
 *
 * Keys: `csv:<account_id>:sha256(date, amount, normalized description, sequence within the day)` and
 * `ofx:<account_id>:<FITID>` (shared idempotencyKey builders). A statement PDF needs Document Intelligence's
 * layout model; without that port the file is parked and the result says `needs: document_intelligence`.
 */
import { idempotencyKey, parseCents } from "@homestead/shared";
import { audit, type Queryable } from "../../db/index.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { detectPossibleDuplicate } from "../duplicates.js";
import type { DocumentIntelligencePort } from "../receipts/documentIntelligence.js";
import { importTransaction } from "../transactions.js";
import type { CsvProfileSpec, ImportFormat, ImportProfileSpec, OfxProfileSpec, PdfProfileSpec } from "./profiles.js";

export interface ParsedRow {
  date: string;
  postedDate?: string;
  amountCents: number;
  description: string;
  reference?: string;
  /** FITID for OFX, statement line number for PDF. */
  sourceId?: string;
}

export interface ImportProfileRow {
  id: string;
  name: string;
  institution: string;
  format: ImportFormat;
  spec: ImportProfileSpec;
}

export async function listImportProfiles(db: Queryable, householdId: string): Promise<ImportProfileRow[]> {
  const r = await db.query<ImportProfileRow>("select id, name, institution, format, spec from import_profiles where household_id = $1 order by name", [householdId]);
  return r.rows;
}

export async function loadImportProfile(db: Queryable, householdId: string, name: string): Promise<ImportProfileRow> {
  const r = await db.query<ImportProfileRow>("select id, name, institution, format, spec from import_profiles where household_id = $1 and name = $2", [householdId, name]);
  const row = r.rows[0];
  if (!row) throw notFound("import profile");
  return row;
}

// CSV ------------------------------------------------------------------------------------------------------

/** RFC 4180-ish: quoted fields, doubled quotes, any line ending. */
export function parseCsvText(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export function parseDate(s: string, format: CsvProfileSpec["dateFormat"]): string {
  const t = s.trim();
  if (format === "YYYY-MM-DD") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw badRequest("date", `Not a ${format} date: "${t}"`);
    return t;
  }
  const sep = format.includes("/") ? "/" : "-";
  const parts = t.split(sep);
  if (parts.length !== 3) throw badRequest("date", `Not a ${format} date: "${t}"`);
  const [m, d, y] = parts as [string, string, string];
  const yyyy = y.length === 2 ? `20${y}` : y;
  return `${yyyy}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

export function parseCsv(text: string, spec: CsvProfileSpec): ParsedRow[] {
  const rows = parseCsvText(text, spec.delimiter ?? ",");
  if (rows.length === 0) return [];
  let header: string[] | undefined;
  let body = rows;
  if (spec.hasHeader) {
    header = rows[0]!.map((h) => h.trim().toLowerCase());
    body = rows.slice(1);
  }
  const col = (name: string | undefined): number | undefined => {
    if (name === undefined) return undefined;
    if (header) {
      const i = header.indexOf(name.trim().toLowerCase());
      return i >= 0 ? i : undefined;
    }
    const n = Number(name);
    return Number.isInteger(n) ? n : undefined;
  };
  const iDate = col(spec.columns.date);
  const iAmount = col(spec.columns.amount);
  const iDebit = col(spec.columns.debit);
  const iCredit = col(spec.columns.credit);
  const iDesc = col(spec.columns.description);
  const iMemo = col(spec.columns.memo);
  const iRef = col(spec.columns.reference);
  const iPosted = col(spec.columns.postedDate);
  if (iDate === undefined || iDesc === undefined) throw badRequest("profile", "The file does not have the date and description columns the profile expects");
  if (spec.sign === "debit_credit" ? iDebit === undefined && iCredit === undefined : iAmount === undefined) throw badRequest("profile", "The file does not have the amount column(s) the profile expects");
  const skip = (spec.skipPatterns ?? []).map((p) => new RegExp(p, "i"));
  const out: ParsedRow[] = [];
  for (const r of body) {
    const description = [r[iDesc] ?? "", iMemo !== undefined ? (r[iMemo] ?? "") : ""].filter(Boolean).join(" ").trim();
    if (!r[iDate]?.trim() || skip.some((re) => re.test(description))) continue;
    let amountCents: number;
    if (spec.sign === "debit_credit") {
      const debit = iDebit !== undefined && r[iDebit]?.trim() ? parseCents(r[iDebit]!) : 0;
      const credit = iCredit !== undefined && r[iCredit]?.trim() ? parseCents(r[iCredit]!) : 0;
      amountCents = credit - debit;
    } else {
      const raw = parseCents(r[iAmount!] ?? "0");
      amountCents = spec.sign === "inverted" ? -raw : raw;
    }
    const row: ParsedRow = { date: parseDate(r[iDate]!, spec.dateFormat), amountCents, description };
    if (iPosted !== undefined && r[iPosted]?.trim()) row.postedDate = parseDate(r[iPosted]!, spec.dateFormat);
    if (iRef !== undefined && r[iRef]?.trim()) row.reference = r[iRef]!.trim();
    out.push(row);
  }
  return out;
}

// OFX / QFX ------------------------------------------------------------------------------------------------

/** SGML-style OFX 1.x and XML OFX 2.x both yield <STMTTRN> blocks with TRNTYPE, DTPOSTED, TRNAMT, FITID, NAME, MEMO. */
export function parseOfx(text: string, spec: OfxProfileSpec): ParsedRow[] {
  const out: ParsedRow[] = [];
  const blocks = text.match(/<STMTTRN>[\s\S]*?(?:<\/STMTTRN>|(?=<STMTTRN>)|$)/gi) ?? [];
  const tag = (block: string, name: string): string | undefined => {
    const m = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block);
    return m?.[1]?.trim();
  };
  for (const b of blocks) {
    const fitid = tag(b, "FITID");
    const dt = tag(b, "DTPOSTED");
    const amt = tag(b, "TRNAMT");
    if (!fitid || !dt || !amt) continue;
    const date = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
    const raw = parseCents(amt.replace(/^\+/, ""));
    const amountCents = spec.sign === "inverted" ? -raw : raw;
    const description = [tag(b, "NAME"), tag(b, "MEMO")].filter(Boolean).join(" ").trim() || tag(b, "TRNTYPE") || "OFX";
    out.push({ date, amountCents, description, sourceId: fitid });
  }
  return out;
}

// PDF ------------------------------------------------------------------------------------------------------

export interface PdfParseResult {
  rows: ParsedRow[];
  statementNo?: string;
  needs?: "document_intelligence";
}

/** Statement PDFs run through the layout model, then the profile's table columns. Without the port: parked. */
export async function parsePdfStatement(bytes: Uint8Array, spec: PdfProfileSpec, docIntel?: DocumentIntelligencePort): Promise<PdfParseResult> {
  if (!docIntel) return { rows: [], needs: "document_intelligence" };
  const layout = await docIntel.analyzeLayout(bytes, "application/pdf");
  const stmt = new RegExp(spec.statementNoPattern, "i").exec(layout.text)?.[1];
  const rows: ParsedRow[] = [];
  let lineNo = 0;
  for (const t of layout.tables) {
    const headers = t.headers.map((h) => h.trim().toLowerCase());
    const iDate = headers.indexOf(spec.table.date.toLowerCase());
    const iDesc = headers.indexOf(spec.table.description.toLowerCase());
    const iAmt = headers.indexOf(spec.table.amount.toLowerCase());
    if (iDate < 0 || iDesc < 0 || iAmt < 0) continue;
    for (const r of t.rows) {
      const d = r[iDate]?.trim();
      const a = r[iAmt]?.trim();
      if (!d || !a) continue;
      let amountCents: number;
      try {
        amountCents = parseCents(a);
      } catch {
        continue;
      }
      lineNo += 1;
      rows.push({ date: parseDate(d, spec.dateFormat), amountCents: spec.sign === "inverted" ? -amountCents : amountCents, description: (r[iDesc] ?? "").trim(), sourceId: String(lineNo) });
    }
  }
  const out: PdfParseResult = { rows };
  if (stmt) out.statementNo = stmt.replace(/\//g, "");
  return out;
}

// Import ---------------------------------------------------------------------------------------------------

export interface ImportCounts {
  parsed: number;
  imported: number;
  alreadyHeld: number;
  possibleDuplicates: number;
  skipped: number;
  needs?: "document_intelligence";
}

/** Keys and inserts for parsed rows; CSV rows get a sequence within the day so two identical charges stay distinct. */
export async function importRows(db: Queryable, householdId: string, accountId: string, rows: readonly ParsedRow[], source: "csv" | "ofx" | "pdf", opts: { statementNo?: string; actor?: string } = {}): Promise<ImportCounts> {
  const actor = opts.actor ?? "file_import";
  const counts: ImportCounts = { parsed: rows.length, imported: 0, alreadyHeld: 0, possibleDuplicates: 0, skipped: 0 };
  const seqByDay = new Map<string, number>();
  for (const r of rows) {
    if (!r.description && r.amountCents === 0) {
      counts.skipped += 1;
      continue;
    }
    let key: string;
    if (source === "ofx") {
      if (!r.sourceId) {
        counts.skipped += 1;
        continue;
      }
      key = idempotencyKey.ofx(accountId, r.sourceId);
    } else if (source === "pdf") {
      if (!opts.statementNo || !r.sourceId) {
        counts.skipped += 1;
        continue;
      }
      key = idempotencyKey.pdf(accountId, opts.statementNo, Number(r.sourceId));
    } else {
      const seqKey = `${r.date}|${r.amountCents}|${r.description.toLowerCase()}`;
      const seq = (seqByDay.get(seqKey) ?? 0) + 1;
      seqByDay.set(seqKey, seq);
      key = idempotencyKey.csv(accountId, r.date, r.amountCents, r.description, seq);
    }
    const res = await importTransaction(db, householdId, { accountId, source, sourceRef: r.reference ?? r.sourceId ?? key, idempotencyKey: key, postedDate: r.postedDate ?? r.date, ...(r.postedDate && r.postedDate !== r.date ? { authorizedDate: r.date } : {}), amountCents: r.amountCents, merchantRaw: r.description }, actor);
    if (!res.created) {
      counts.alreadyHeld += 1;
      continue;
    }
    counts.imported += 1;
    const d = await detectPossibleDuplicate(db, householdId, res.transaction, actor);
    if (d.duplicateOf) counts.possibleDuplicates += 1;
  }
  return counts;
}

export interface ImportFileInput {
  accountId: string;
  profileName: string;
  bytes: Uint8Array;
  fileName?: string;
}

export async function importFile(db: Queryable, householdId: string, input: ImportFileInput, actor: string, docIntel?: DocumentIntelligencePort): Promise<ImportCounts & { syncRunId: string }> {
  const profile = await loadImportProfile(db, householdId, input.profileName);
  const acct = await db.query<{ id: string }>("select id from accounts where id = $1 and household_id = $2", [input.accountId, householdId]);
  if (!acct.rows[0]) throw notFound("account");
  const run = await db.query<{ id: string }>("insert into sync_runs (household_id, kind, status, counts) values ($1,'file_import','running','{}') returning id", [householdId]);
  const runId = run.rows[0]!.id;
  let counts: ImportCounts;
  try {
    if (profile.spec.format === "csv") {
      counts = await importRows(db, householdId, input.accountId, parseCsv(new TextDecoder().decode(input.bytes), profile.spec), "csv", { actor });
    } else if (profile.spec.format === "ofx" || profile.spec.format === "qfx") {
      counts = await importRows(db, householdId, input.accountId, parseOfx(new TextDecoder().decode(input.bytes), profile.spec), "ofx", { actor });
    } else if (profile.spec.format === "pdf") {
      const parsed = await parsePdfStatement(input.bytes, profile.spec, docIntel);
      if (parsed.needs) {
        counts = { parsed: 0, imported: 0, alreadyHeld: 0, possibleDuplicates: 0, skipped: 0, needs: parsed.needs };
      } else {
        const o: { statementNo?: string; actor: string } = { actor };
        if (parsed.statementNo) o.statementNo = parsed.statementNo;
        counts = await importRows(db, householdId, input.accountId, parsed.rows, "pdf", o);
      }
    } else {
      throw badRequest("profile", "Unknown import profile format");
    }
    await db.query("update sync_runs set status = 'ok', finished_at = now(), counts = $2 where id = $1", [runId, JSON.stringify(counts)]);
  } catch (e) {
    await db.query("update sync_runs set status = 'failed', finished_at = now(), error = $2 where id = $1", [runId, (e as Error).name]);
    throw e;
  }
  await audit(db, householdId, { actor, action: "file.imported", entity: "account", entityId: input.accountId, after: { profile: profile.name, ...counts } });
  return { ...counts, syncRunId: runId };
}
