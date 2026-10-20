/**
 * A small OData $filter evaluator for the mock: `field op literal [and …]` with eq/ne/gt/ge/lt/le, string, number,
 * boolean and date literals, and BC's `'v2.0*'` wildcard on eq. Enough for every filter the adapter sends.
 */

export interface FilterTerm {
  field: string;
  op: "eq" | "ne" | "gt" | "ge" | "lt" | "le";
  value: string | number | boolean;
  wildcard: boolean;
}

export class FilterError extends Error {}

const TERM_RE = /^\s*([A-Za-z_][\w./]*)\s+(eq|ne|gt|ge|lt|le)\s+(.+?)\s*$/;

export function parseFilter(filter: string | null | undefined): FilterTerm[] {
  if (!filter || !filter.trim()) return [];
  // Split on " and " outside quotes.
  const parts: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < filter.length; i += 1) {
    const ch = filter[i] ?? "";
    if (ch === "'") inQuote = !inQuote;
    if (!inQuote && filter.slice(i, i + 5).toLowerCase() === " and ") {
      parts.push(cur);
      cur = "";
      i += 4;
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => {
    const m = TERM_RE.exec(p);
    if (!m) throw new FilterError(`Unsupported $filter term: ${p}`);
    const field = m[1] ?? "";
    const op = m[2] as FilterTerm["op"];
    const raw = m[3] ?? "";
    if (raw.startsWith("'") && raw.endsWith("'")) {
      const s = raw.slice(1, -1).replace(/''/g, "'");
      return { field, op, value: s.endsWith("*") ? s.slice(0, -1) : s, wildcard: s.endsWith("*") };
    }
    if (raw === "true" || raw === "false") return { field, op, value: raw === "true", wildcard: false };
    if (/^-?\d+(\.\d+)?$/.test(raw)) return { field, op, value: Number(raw), wildcard: false };
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { field, op, value: raw, wildcard: false };
    throw new FilterError(`Unsupported $filter literal: ${raw}`);
  });
}

function compare(a: unknown, b: string | number | boolean): number {
  if (typeof b === "number") return Number(a) - b;
  if (typeof b === "boolean") return Number(Boolean(a)) - Number(b);
  return String(a ?? "").localeCompare(b);
}

/** Throws FilterError for a field the entity does not expose, as Business Central does (even on an empty set). */
export function assertFilterFields(terms: readonly FilterTerm[], exposedFields: readonly string[]): void {
  for (const t of terms) {
    if (!exposedFields.includes(t.field)) throw new FilterError(`Could not find a property named '${t.field}' on type 'Microsoft.NAV.${exposedFields[0] ?? "entity"}'.`);
  }
}

/** Throws FilterError for a field the entity does not expose, as Business Central does. */
export function matchesFilter(row: Record<string, unknown>, terms: readonly FilterTerm[], exposedFields: readonly string[]): boolean {
  for (const t of terms) {
    if (!exposedFields.includes(t.field)) throw new FilterError(`Could not find a property named '${t.field}' on type 'Microsoft.NAV.${exposedFields[0] ?? "entity"}'.`);
    const v = row[t.field];
    if (t.wildcard) {
      const hit = String(v ?? "").startsWith(String(t.value));
      if (t.op === "eq" ? !hit : hit) return false;
      continue;
    }
    const c = compare(v, t.value);
    const ok = t.op === "eq" ? c === 0 : t.op === "ne" ? c !== 0 : t.op === "gt" ? c > 0 : t.op === "ge" ? c >= 0 : t.op === "lt" ? c < 0 : c <= 0;
    if (!ok) return false;
  }
  return true;
}
