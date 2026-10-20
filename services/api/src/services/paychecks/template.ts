/**
 * Employer templates (spec: "Paychecks", step 3): the last stub's component ratios propose a breakdown when no
 * stub arrives within 3 days; the next stub trues it up. `labelMap` remembers how each stub line maps to a
 * component kind, learned from one-tap answers.
 */
import { buildPaycheckLines, type Cents, type EmployerCode, type PaycheckComponent, type PaycheckComponentKind, type PaycheckLine } from "@homestead/shared";

export interface TemplateComponent {
  kind: PaycheckComponentKind;
  label: string;
  /** Fraction of net pay. */
  ratio: number;
  glAccountOverride?: string;
}

export interface EmployerTemplate {
  components: TemplateComponent[];
  /** normalized stub label -> component kind */
  labelMap: Record<string, PaycheckComponentKind>;
  /** Newest first. */
  lastSixNetCents: number[];
}

export const EMPTY_TEMPLATE: EmployerTemplate = { components: [], labelMap: {}, lastSixNetCents: [] };

export function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Propose components from ratios so that earnings − deductions = net exactly (rounding goes to the regular line). */
export function applyTemplate(t: EmployerTemplate, netCents: Cents): PaycheckComponent[] {
  if (t.components.length === 0) return [{ kind: "regular", label: "Regular (estimated)", amountCents: netCents }];
  const comps: PaycheckComponent[] = t.components.map((c) => {
    const comp: PaycheckComponent = { kind: c.kind, label: c.label, amountCents: Math.max(0, Math.round(c.ratio * netCents)) };
    if (c.glAccountOverride) comp.glAccountOverride = c.glAccountOverride;
    return comp;
  });
  const earningsKinds = new Set<PaycheckComponentKind>(["regular", "bonus", "overtime"]);
  let net = 0;
  for (const c of comps) net += earningsKinds.has(c.kind) ? c.amountCents : -c.amountCents;
  const regular = comps.find((c) => c.kind === "regular") ?? comps[0]!;
  regular.amountCents += netCents - net;
  return comps;
}

/** A new template from a read stub: ratios of net, the label map kept, the net history rolled. */
export function templateFromComponents(prev: EmployerTemplate, components: readonly PaycheckComponent[], netCents: Cents, labelMap: Record<string, PaycheckComponentKind> = {}): EmployerTemplate {
  const comps: TemplateComponent[] = components.map((c) => {
    const t: TemplateComponent = { kind: c.kind, label: c.label, ratio: netCents === 0 ? 0 : c.amountCents / netCents };
    if (c.glAccountOverride) t.glAccountOverride = c.glAccountOverride;
    return t;
  });
  return { components: comps, labelMap: { ...prev.labelMap, ...labelMap }, lastSixNetCents: [netCents, ...prev.lastSixNetCents].slice(0, 6) };
}

/** R1 threshold: net within 15% of the last six stubs' nets (no history: not within). */
export function netWithinFifteenPercent(netCents: Cents, lastSix: readonly Cents[]): boolean {
  if (lastSix.length === 0) return false;
  const avg = lastSix.reduce((s, x) => s + x, 0) / lastSix.length;
  return Math.abs(netCents - avg) <= Math.abs(avg) * 0.15;
}

/** Build the document lines; throws PaycheckDoesNotTieError when earnings − deductions ≠ net within $0.01. */
export function linesForPaycheck(employer: EmployerCode, components: readonly PaycheckComponent[], netCents: Cents, payDateIso: string, existingAccounts?: ReadonlySet<string>): PaycheckLine[] {
  const opts: Parameters<typeof buildPaycheckLines>[0] = { employer, components, netCents, payDateIso };
  if (existingAccounts) opts.existingAccounts = existingAccounts;
  return buildPaycheckLines(opts);
}
