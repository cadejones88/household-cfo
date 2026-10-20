/**
 * Paychecks (spec: "Paychecks"): a deposit from a known employer becomes a `paychecks` row in Needs Receipt; the
 * stub PDF is read with `prebuilt-payStub.us` and mapped to components with the employer template; unmapped
 * lines become one-tap questions; after 3 days without a stub the template proposes an estimated breakdown
 * that the next stub trues up with a correction. The components post as the lines of one BC document.
 */
import { PaycheckDoesNotTieError, employerForDescriptor, type EmployerCode, type PaycheckComponent, type PaycheckComponentKind, type PaycheckSummary } from "@homestead/shared";
import { audit, type Queryable } from "../../db/index.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { addDays } from "../../lib/dates.js";
import type { DocumentIntelligencePort, PayStubRead } from "../receipts/documentIntelligence.js";
import { approveTransaction, loadTx, setSplits, transition, type SplitInput, type TxRow } from "../transactions.js";
import { decideBatch, listRules } from "../rules.js";
import { ledgerConnection } from "../households.js";
import { categoryForPaycheckAccount } from "./categories.js";
import { applyTemplate, EMPTY_TEMPLATE, linesForPaycheck, netWithinFifteenPercent, normalizeLabel, templateFromComponents, type EmployerTemplate } from "./template.js";

export interface EmployerRow {
  id: string;
  member_id: string;
  code: EmployerCode;
  name: string;
  descriptor_pattern: string;
  bc_gross_account: string;
  bc_bonus_account: string;
  template: EmployerTemplate;
  last_stub_at: string | null;
}

export interface PaycheckRow {
  id: string;
  employer_id: string;
  member_id: string;
  pay_date: string;
  period_start: string | null;
  period_end: string | null;
  net_cents: number;
  source: "stub_pdf" | "stub_image" | "template";
  estimated: boolean;
  transaction_id: string | null;
  stub_receipt_id: string | null;
  created_at: string;
}

export interface ComponentRow {
  line_no: number;
  kind: PaycheckComponentKind;
  label: string;
  amount_cents: number;
  gl_account: string;
}

export async function listEmployers(db: Queryable, householdId: string): Promise<EmployerRow[]> {
  const r = await db.query<EmployerRow>("select id, member_id, code, name, descriptor_pattern, bc_gross_account, bc_bonus_account, template, last_stub_at from employers where household_id = $1", [householdId]);
  return r.rows.map((e) => ({ ...e, template: { ...EMPTY_TEMPLATE, ...e.template } }));
}

export async function loadPaycheck(db: Queryable, id: string): Promise<PaycheckRow> {
  const r = await db.query<PaycheckRow>("select id, employer_id, member_id, to_char(pay_date,'YYYY-MM-DD') as pay_date, to_char(period_start,'YYYY-MM-DD') as period_start, to_char(period_end,'YYYY-MM-DD') as period_end, net_cents::bigint::int as net_cents, source, estimated, transaction_id, stub_receipt_id, created_at from paychecks where id = $1", [id]);
  const row = r.rows[0];
  if (!row) throw notFound("paycheck");
  return row;
}

export async function loadComponents(db: Queryable, paycheckId: string): Promise<ComponentRow[]> {
  const r = await db.query<ComponentRow>("select line_no, kind, label, amount_cents::bigint::int as amount_cents, gl_account from paycheck_components where paycheck_id = $1 order by line_no", [paycheckId]);
  return r.rows;
}

export async function listPaychecks(db: Queryable, householdId: string, limit = 50): Promise<PaycheckRow[]> {
  const r = await db.query<PaycheckRow>("select id, employer_id, member_id, to_char(pay_date,'YYYY-MM-DD') as pay_date, to_char(period_start,'YYYY-MM-DD') as period_start, to_char(period_end,'YYYY-MM-DD') as period_end, net_cents::bigint::int as net_cents, source, estimated, transaction_id, stub_receipt_id, created_at from paychecks where household_id = $1 order by pay_date desc limit $2", [householdId, limit]);
  return r.rows;
}

export async function paycheckSummary(db: Queryable, householdId: string, p: PaycheckRow): Promise<PaycheckSummary & { needsStub: boolean; periodStart?: string; periodEnd?: string; stubReceiptId?: string }> {
  const employers = await listEmployers(db, householdId);
  const emp = employers.find((e) => e.id === p.employer_id);
  const comps = await loadComponents(db, p.id);
  const out: PaycheckSummary & { needsStub: boolean; periodStart?: string; periodEnd?: string; stubReceiptId?: string } = {
    id: p.id,
    employer: emp?.code ?? "HFH",
    payDate: p.pay_date,
    netCents: p.net_cents,
    source: p.source,
    estimated: p.estimated,
    needsStub: !p.stub_receipt_id,
    components: comps.map((c) => ({ kind: c.kind, label: c.label, amountCents: c.amount_cents, glAccount: c.gl_account })),
  };
  if (p.transaction_id) out.transactionId = p.transaction_id;
  if (p.period_start) out.periodStart = p.period_start;
  if (p.period_end) out.periodEnd = p.period_end;
  if (p.stub_receipt_id) out.stubReceiptId = p.stub_receipt_id;
  return out;
}

// Detect ------------------------------------------------------------------------------------------------

/** A deposit from a known employer descriptor: create the paycheck row and park the deposit in Needs Receipt. */
export async function detectPaycheck(db: Queryable, householdId: string, tx: TxRow, actor = "jobs"): Promise<{ paycheckId: string; employer: EmployerCode } | undefined> {
  if (tx.amount_cents <= 0 || tx.state !== "imported" || tx.pending) return undefined;
  const employers = await listEmployers(db, householdId);
  let emp = employers.find((e) => new RegExp(e.descriptor_pattern, "i").test(tx.merchant_raw) || new RegExp(e.descriptor_pattern, "i").test(tx.merchant_norm));
  if (!emp) {
    const code = employerForDescriptor(tx.merchant_raw);
    emp = employers.find((e) => e.code === code);
  }
  if (!emp) return undefined;
  const ins = await db.query<{ id: string }>(
    `insert into paychecks (household_id, employer_id, member_id, pay_date, net_cents, source, estimated, transaction_id)
     values ($1,$2,$3,$4,$5,'template',false,$6)
     on conflict (household_id, employer_id, pay_date, net_cents) do update set transaction_id = coalesce(paychecks.transaction_id, excluded.transaction_id)
     returning id`,
    [householdId, emp.id, emp.member_id, tx.posted_date, tx.amount_cents, tx.id],
  );
  const paycheckId = ins.rows[0]!.id;
  await transition(db, householdId, tx.id, "needs_receipt", "jobs", {
    actorId: actor,
    reason: `${emp.name} payroll deposit; waiting for the stub`,
    patch: { kind: "paycheck", receipt_status: "needed", category_id: emp.code === "HFH" ? "income-hfh-wages" : "income-ctj-wages" },
  });
  await audit(db, householdId, { actor, action: "paycheck.detected", entity: "paycheck", entityId: paycheckId, after: { employer: emp.code, transactionId: tx.id } });
  return { paycheckId, employer: emp.code };
}

// Stub intake -----------------------------------------------------------------------------------------

export interface UnmappedLine {
  section: "earnings" | "taxes" | "deductions";
  label: string;
  amountCents: number;
}

const DEFAULT_LABEL_RULES: { re: RegExp; kind: PaycheckComponentKind; glAccountOverride?: string }[] = [
  { re: /bonus|commission/, kind: "bonus" },
  { re: /overtime|\bot\b/, kind: "overtime" },
  { re: /regular|salary|hourly|wages|gross pay/, kind: "regular" },
  { re: /federal|fed\b|fit\b|fwt/, kind: "fit" },
  { re: /idaho|\bid\b|state|sit\b|swt/, kind: "state_tax" },
  { re: /social security|oasdi|ss\b|fica ss/, kind: "social_security" },
  { re: /medicare|fica med/, kind: "medicare" },
  { re: /medical|health|dental|vision|hsa|health share/, kind: "benefit", glAccountOverride: "605301" },
  { re: /life ins/, kind: "benefit", glAccountOverride: "605101" },
];

/** Map stub lines to components with the template's learned labels first, then the default label rules. */
export function mapStubLines(read: PayStubRead, template: EmployerTemplate): { components: PaycheckComponent[]; unmapped: UnmappedLine[] } {
  const components: PaycheckComponent[] = [];
  const unmapped: UnmappedLine[] = [];
  const sections: { section: UnmappedLine["section"]; lines: PayStubRead["earnings"] }[] = [
    { section: "earnings", lines: read.earnings },
    { section: "taxes", lines: read.taxes },
    { section: "deductions", lines: read.deductions },
  ];
  for (const { section, lines } of sections) {
    for (const l of lines) {
      if (!l.label || l.amountCents === 0) continue;
      const norm = normalizeLabel(l.label);
      let kind: PaycheckComponentKind | undefined = template.labelMap[norm];
      let override: string | undefined;
      if (!kind) {
        const rule = DEFAULT_LABEL_RULES.find((r) => r.re.test(norm) && sectionAllows(section, r.kind));
        if (rule) {
          kind = rule.kind;
          override = rule.glAccountOverride;
        }
      }
      if (!kind) {
        unmapped.push({ section, label: l.label, amountCents: Math.abs(l.amountCents) });
        continue;
      }
      const comp: PaycheckComponent = { kind, label: l.label.slice(0, 100), amountCents: Math.abs(l.amountCents) };
      if (override) comp.glAccountOverride = override;
      components.push(comp);
    }
  }
  return { components, unmapped };
}

function sectionAllows(section: UnmappedLine["section"], kind: PaycheckComponentKind): boolean {
  if (section === "earnings") return kind === "regular" || kind === "bonus" || kind === "overtime";
  if (section === "taxes") return kind === "fit" || kind === "state_tax" || kind === "social_security" || kind === "medicare";
  return kind === "benefit" || kind === "other_deduction";
}

export interface IntakeResult {
  paycheck: PaycheckRow;
  components: PaycheckComponent[];
  unmapped: UnmappedLine[];
  tiesToNet: boolean;
  outcome: "approved" | "ready_for_review" | "needs_answers" | "does_not_tie" | "correction_requested";
}

export interface IntakePorts {
  docIntel: DocumentIntelligencePort;
}

/** Read a stub for a paycheck, map it, and either post the components or ask about the unmapped lines. */
export async function intakeStub(db: Queryable, householdId: string, paycheckId: string, stub: { bytes: Uint8Array; contentType: string; receiptId: string }, ports: IntakePorts, actor: string): Promise<IntakeResult> {
  const p = await loadPaycheck(db, paycheckId);
  const employers = await listEmployers(db, householdId);
  const emp = employers.find((e) => e.id === p.employer_id);
  if (!emp) throw notFound("employer");
  const read = await ports.docIntel.analyzePayStub(stub.bytes, stub.contentType);
  await db.query("update receipts set kind = 'pay_stub', ocr_status = 'read', ocr_result = $2 where id = $1", [stub.receiptId, JSON.stringify(read)]);
  await db.query("update paychecks set stub_receipt_id = $2, source = $3, period_start = coalesce($4, period_start), period_end = coalesce($5, period_end) where id = $1", [
    paycheckId,
    stub.receiptId,
    stub.contentType === "application/pdf" ? "stub_pdf" : "stub_image",
    read.periodStart ?? null,
    read.periodEnd ?? null,
  ]);
  if (read.netCents !== undefined && Math.abs(read.netCents - p.net_cents) > 1) {
    await audit(db, householdId, { actor, action: "paycheck.stub_net_differs", entity: "paycheck", entityId: paycheckId, after: { stubNet: read.netCents, deposit: p.net_cents } });
  }
  return applyStubRead(db, householdId, paycheckId, read, emp, actor);
}

/** Map and apply a stub read (also used after a paycheck_component answer updates the template). */
export async function applyStubRead(db: Queryable, householdId: string, paycheckId: string, read: PayStubRead, emp: EmployerRow, actor: string): Promise<IntakeResult> {
  const p = await loadPaycheck(db, paycheckId);
  const { components, unmapped } = mapStubLines(read, emp.template);
  if (unmapped.length > 0) {
    await db.query("update receipts set ocr_status = 'needs_review', ocr_result = $2 where id = $1", [p.stub_receipt_id, JSON.stringify({ ...read, unmapped })]);
    return { paycheck: p, components, unmapped, tiesToNet: false, outcome: "needs_answers" };
  }
  try {
    linesForPaycheck(emp.code, components, p.net_cents, p.pay_date);
  } catch (e) {
    if (e instanceof PaycheckDoesNotTieError) {
      await db.query("update receipts set ocr_status = 'needs_review' where id = $1", [p.stub_receipt_id]);
      await audit(db, householdId, { actor, action: "paycheck.does_not_tie", entity: "paycheck", entityId: paycheckId, after: { expected: e.expectedNet, computed: e.computedNet } });
      return { paycheck: p, components, unmapped, tiesToNet: false, outcome: "does_not_tie" };
    }
    throw e;
  }
  const outcome = await applyComponents(db, householdId, paycheckId, components, { source: p.source === "template" ? "stub_pdf" : p.source, estimated: false, stubRead: true }, actor);
  // Learn the template from a stub that tied.
  const labelMap: Record<string, PaycheckComponentKind> = {};
  for (const c of components) labelMap[normalizeLabel(c.label)] = c.kind;
  const next = templateFromComponents(emp.template, components, p.net_cents, labelMap);
  await db.query("update employers set template = $2, last_stub_at = now() where id = $1", [emp.id, JSON.stringify(next)]);
  return { paycheck: await loadPaycheck(db, paycheckId), components, unmapped, tiesToNet: true, outcome };
}

/** A one-tap answer for an unmapped stub line: remember it in the employer template and re-apply the stub. */
export async function answerComponent(db: Queryable, householdId: string, paycheckId: string, label: string, kind: PaycheckComponentKind, actor: string): Promise<IntakeResult> {
  const p = await loadPaycheck(db, paycheckId);
  const employers = await listEmployers(db, householdId);
  const emp = employers.find((e) => e.id === p.employer_id);
  if (!emp) throw notFound("employer");
  if (!p.stub_receipt_id) throw conflict("no_stub", "This paycheck has no stub to map");
  const r = await db.query<{ ocr_result: PayStubRead & { unmapped?: UnmappedLine[] } }>("select ocr_result from receipts where id = $1", [p.stub_receipt_id]);
  const read = r.rows[0]?.ocr_result;
  if (!read) throw conflict("no_read", "The stub has not been read yet");
  emp.template.labelMap[normalizeLabel(label)] = kind;
  await db.query("update employers set template = $2 where id = $1", [emp.id, JSON.stringify(emp.template)]);
  await audit(db, householdId, { actor, action: "paycheck.component_mapped", entity: "paycheck", entityId: paycheckId, after: { label, kind } });
  return applyStubRead(db, householdId, paycheckId, read, emp, actor);
}

/**
 * Write components, the deposit's splits (one per non-net line, bank sign), and move the deposit on:
 * needs_receipt -> needs_classification -> approved under R1 (when approved and the net is within 15% of the
 * last six) or ready_for_review for one tap. An already-posted estimate gets a correction request instead.
 */
export async function applyComponents(
  db: Queryable,
  householdId: string,
  paycheckId: string,
  components: readonly PaycheckComponent[],
  opts: { source: PaycheckRow["source"]; estimated: boolean; stubRead: boolean },
  actor: string,
): Promise<IntakeResult["outcome"]> {
  const p = await loadPaycheck(db, paycheckId);
  const employers = await listEmployers(db, householdId);
  const emp = employers.find((e) => e.id === p.employer_id)!;
  const lines = linesForPaycheck(emp.code, components, p.net_cents, p.pay_date);
  await db.query("delete from paycheck_components where paycheck_id = $1", [paycheckId]);
  let n = 1;
  for (const l of lines) {
    if (l.kind === "net") continue;
    await db.query("insert into paycheck_components (household_id, paycheck_id, line_no, kind, label, amount_cents, gl_account, dimension_set) values ($1,$2,$3,$4,$5,$6,$7,$8)", [
      householdId,
      paycheckId,
      n++,
      l.kind,
      l.description.slice(0, 100),
      Math.abs(l.amountCents),
      l.glAccount,
      JSON.stringify(l.dims),
    ]);
  }
  await db.query("update paychecks set source = $2, estimated = $3 where id = $1", [paycheckId, opts.source, opts.estimated]);
  if (!p.transaction_id) return "ready_for_review";
  const tx = await loadTx(db, p.transaction_id);
  const splits: SplitInput[] = lines
    .filter((l) => l.kind !== "net")
    .map((l) => ({ amountCents: -l.amountCents, categoryId: categoryForPaycheckAccount(l.glAccount, l.kind), description: l.description, dims: l.dims }));
  if (["sent_to_bc", "bc_draft_created", "posted", "reconciled"].includes(tx.state)) {
    // True-up of an estimated paycheck already with BC: a correction document for Cade.
    const r = await db.query<{ id: string }>("insert into approvals (household_id, kind, payload, requested_by) values ($1, 'correction', $2, $3) returning id", [
      householdId,
      JSON.stringify({ transactionId: tx.id, paycheckId, reason: "stub arrived after the estimated paycheck posted", splits }),
      emp.member_id,
    ]);
    await audit(db, householdId, { actor, action: "paycheck.true_up_requested", entity: "approval", entityId: r.rows[0]!.id, after: { paycheckId, transactionId: tx.id } });
    return "correction_requested";
  }
  await setSplits(db, householdId, tx.id, splits, actor);
  let current = tx;
  if (current.state === "needs_receipt") current = await transition(db, householdId, tx.id, "needs_classification", "jobs", { actorId: actor, reason: opts.stubRead ? "stub read" : "template applied after 3 days", patch: { receipt_status: opts.stubRead ? "matched" : "estimated" } });
  if (current.state === "ready_for_review" || current.state === "approved") {
    // Replace an estimate before posting: nothing else to move.
    await audit(db, householdId, { actor, action: "paycheck.components_replaced", entity: "paycheck", entityId: paycheckId });
    return current.state === "approved" ? "approved" : "ready_for_review";
  }
  if (current.state !== "needs_classification") return "ready_for_review";
  // R1
  const rules = await listRules(db, householdId);
  const r1 = rules.find((r) => r.kind === "paycheck" && r.state !== "retired");
  const conn = await ledgerConnection(db, householdId);
  const autoPostOn = conn?.auto_post_enabled ?? false;
  const within = netWithinFifteenPercent(p.net_cents, emp.template.lastSixNetCents);
  if (r1?.state === "approved" && opts.stubRead && !opts.estimated && within) {
    const batch = decideBatch({ mayAutoPost: Boolean(r1.may_auto_post) && autoPostOn, ruleApproved: true }, r1, autoPostOn, "FEEDS");
    await approveTransaction(db, householdId, tx.id, "rule_engine", { ruleId: r1.id, confidence: 0.99, batch, actorId: actor, reason: "R1: stub read, components tie to net, net within 15% of the last six" });
    return "approved";
  }
  await transition(db, householdId, tx.id, "ready_for_review", "rule_engine", {
    actorId: actor,
    reason: opts.estimated ? "estimated from the last stub" : within ? "R1 not approved yet" : "net outside 15% of the last six",
    patch: { confidence: opts.estimated ? 0.8 : within ? 0.95 : 0.6, ...(r1 ? { rule_id: r1.id } : {}) },
  });
  return "ready_for_review";
}

/** Paychecks still waiting for a stub after 3 days: apply the template with "estimated" shown. */
export async function applyTemplateFallbacks(db: Queryable, householdId: string, todayIso: string, actor = "paycheck_fallback"): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `select p.id from paychecks p join transactions t on t.id = p.transaction_id
      where p.household_id = $1 and p.stub_receipt_id is null and t.state = 'needs_receipt' and p.pay_date <= $2::date
        and not exists (select 1 from paycheck_components c where c.paycheck_id = p.id)`,
    [householdId, addDays(todayIso, -3)],
  );
  const done: string[] = [];
  for (const { id } of r.rows) {
    const p = await loadPaycheck(db, id);
    const employers = await listEmployers(db, householdId);
    const emp = employers.find((e) => e.id === p.employer_id);
    if (!emp) continue;
    const comps = applyTemplate(emp.template, p.net_cents);
    try {
      await applyComponents(db, householdId, id, comps, { source: "template", estimated: true, stubRead: false }, actor);
      done.push(id);
    } catch (e) {
      if (!(e instanceof PaycheckDoesNotTieError)) throw e;
    }
  }
  return done;
}

export function assertComponentKind(k: string): PaycheckComponentKind {
  const kinds: PaycheckComponentKind[] = ["regular", "bonus", "overtime", "fit", "state_tax", "social_security", "medicare", "benefit", "other_deduction"];
  if (!kinds.includes(k as PaycheckComponentKind)) throw badRequest("component_kind", `Unknown component kind ${k}`);
  return k as PaycheckComponentKind;
}
