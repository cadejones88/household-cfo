/**
 * Ask Homestead orchestration (spec: "Ask Homestead"). A question box over the six read-only functions:
 *  1. a planner picks which functions to run (keywords in code; the model may add one from the same list);
 *  2. the functions run with the household filter applied in code;
 *  3. the model receives ONLY the function results, the household's category names and the question, and
 *     returns one plain sentence or two;
 *  4. the answer carries the rows it used and the earliest data-through date, so the app renders every number
 *     from the rows, never from the text;
 *  5. no write function exists: "move $50 to groceries" returns a drafted budget move that opens the approval
 *     screen; Ask never executes it.
 * Conversations are kept 90 days and never used to train anything.
 *
 * Model assumptions (docs): Claude in Microsoft Foundry exposes the Anthropic Messages API at
 * {FOUNDRY_ENDPOINT}/anthropic/v1/messages with an `api-key` header and the deployed model name
 * (https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry.md); data stays in the US
 * Data Zone (https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/claude-models/data-privacy).
 */
import { formatUsd, parseCents, type AskAnswer, type BudgetStatus, type DataThrough, type Goal } from "@homestead/shared";
import { audit, type Queryable } from "../../db/index.js";
import { loadCategories } from "../categories.js";
import { ASK_FUNCTIONS, runFunction, type AskContext, type AskFunctionName, type FunctionResult } from "./functions.js";
import type { SafeToSpendView } from "../safeToSpend.js";

export interface PlannedCall {
  fn: AskFunctionName;
  args?: Record<string, unknown>;
}

/** Keyword planner: deterministic, in code, so the model never chooses a function outside the list. */
export function planCalls(question: string, todayIso: string, categoryIds: readonly { id: string; name: string }[]): PlannedCall[] {
  const q = question.toLowerCase();
  const calls: PlannedCall[] = [];
  const has = (...words: string[]) => words.some((w) => q.includes(w));
  if (has("safe to spend", "safe-to-spend", "can we spend", "can i spend", "how much can", "left to spend", "spend before", "afford")) calls.push({ fn: "get_safe_to_spend" });
  if (has("budget", "on track", "over on", "left in", "how are we doing", "left for", "spent on", "spent in")) calls.push({ fn: "get_budget_status", args: { month: monthMentioned(q, todayIso) } });
  if (has("bill", "due", "minimum", "payment coming", "owe", "upcoming")) calls.push({ fn: "get_bills" });
  if (has("goal", "emergency", "fund", "saving", "christmas", "sinking", "milestone", "debt")) calls.push({ fn: "get_goals" });
  if (has("paycheck", "pay stub", "paystub", "withholding", "take-home", "take home", "net pay", "gross")) calls.push({ fn: "get_paycheck" });
  const cat = categoryIds.find((c) => q.includes(c.name.toLowerCase()) || q.includes(c.id.replace(/-/g, " ")));
  if (has("transactions", "charges", "what did we", "what did i", "how much did we", "how much did i", "last week", "yesterday", "find", "search", "receipt", "at ") || (cat && !calls.some((c) => c.fn === "get_budget_status"))) {
    const args: Record<string, unknown> = {};
    if (cat) args["categoryId"] = cat.id;
    const m = /\bat ([a-z0-9' ]{3,30})/.exec(q);
    if (m?.[1] && !cat) args["query"] = m[1].trim().replace(/\b(last|this|yesterday|today|week|month).*$/, "").trim();
    const range = rangeMentioned(q, todayIso);
    if (range) {
      args["from"] = range.from;
      args["to"] = range.to;
    }
    calls.push({ fn: "search_transactions", args });
  }
  if (calls.length === 0) calls.push({ fn: "get_safe_to_spend" }, { fn: "get_budget_status", args: { month: todayIso.slice(0, 7) } });
  return calls;
}

function monthMentioned(q: string, todayIso: string): string {
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const year = Number(todayIso.slice(0, 4));
  for (let i = 0; i < 12; i += 1) {
    if (q.includes(months[i]!)) return `${year}-${String(i + 1).padStart(2, "0")}`;
  }
  if (q.includes("last month")) {
    const m = Number(todayIso.slice(5, 7));
    return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, "0")}`;
  }
  return todayIso.slice(0, 7);
}

function rangeMentioned(q: string, todayIso: string): { from: string; to: string } | undefined {
  const d = new Date(`${todayIso}T00:00:00Z`);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const back = (n: number) => iso(new Date(d.getTime() - n * 86_400_000));
  if (q.includes("yesterday")) return { from: back(1), to: back(1) };
  if (q.includes("today")) return { from: todayIso, to: todayIso };
  if (q.includes("last week") || q.includes("past week") || q.includes("this week")) return { from: back(7), to: todayIso };
  if (q.includes("last month")) {
    const m = monthMentioned(q, todayIso);
    return { from: `${m}-01`, to: `${m}-31` };
  }
  if (q.includes("this month")) return { from: `${todayIso.slice(0, 7)}-01`, to: todayIso };
  return undefined;
}

/** "move $50 to groceries" / "move 50 from eating out to groceries": a drafted budget move, never executed. */
export function draftActionFor(question: string, categories: readonly { id: string; name: string }[]): AskAnswer["draftAction"] | undefined {
  const q = question.toLowerCase();
  if (!/\b(move|shift|transfer)\b/.test(q)) return undefined;
  const amt = /\$?\s?(\d{1,6}(?:\.\d{1,2})?)/.exec(q);
  if (!amt?.[1]) return undefined;
  const amountCents = parseCents(amt[1]);
  const find = (text: string | undefined) => (text ? categories.find((c) => text.includes(c.name.toLowerCase()) || text.includes(c.id.replace(/-/g, " "))) : undefined);
  const toM = /\bto ([a-z' ]+?)(?:\s+from\b|$|[.?!])/.exec(q);
  const fromM = /\bfrom ([a-z' ]+?)(?:\s+to\b|$|[.?!])/.exec(q);
  const to = find(toM?.[1]);
  const from = find(fromM?.[1]);
  if (!to) return undefined;
  return { kind: "budget_move", fromCategoryId: from?.id ?? "", toCategoryId: to.id, amountCents };
}

// Model port ----------------------------------------------------------------------------------------

export interface AskModelInput {
  question: string;
  categoryNames: readonly string[];
  results: readonly { fn: AskFunctionName; dataThrough: DataThrough; rows: unknown }[];
}

export interface AskModelPort {
  answer(input: AskModelInput): Promise<string>;
}

export const ASK_SYSTEM_PROMPT = `You are Homestead, a calm household finance helper for one family.
You are given the question, the family's category names, and the results of read-only functions already run.
Answer in one or two plain sentences using ONLY numbers that appear in the function results (dollars, dates).
Never invent a number. Never suggest you changed anything: you cannot move money or change the budget.
If the results do not cover the question, say so in one sentence.`;

export class FoundryAskModel implements AskModelPort {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async answer(input: AskModelInput): Promise<string> {
    const r = await this.fetchImpl(`${this.endpoint.replace(/\/$/, "")}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "api-key": this.apiKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 400,
        system: ASK_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Question: ${input.question}\n\nCategories: ${input.categoryNames.join(", ")}\n\nFunction results (JSON):\n${JSON.stringify(input.results)}` }],
      }),
    });
    if (!r.ok) throw new Error(`Foundry messages call failed with ${r.status}`);
    const j = (await r.json()) as { content?: { type: string; text?: string }[] };
    return j.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
  }
}

/** Deterministic sentences from the rows, for tests and for a model outage. */
export class TemplateAskModel implements AskModelPort {
  readonly calls: AskModelInput[] = [];
  async answer(input: AskModelInput): Promise<string> {
    this.calls.push(input);
    return renderTemplate(input);
  }
}

export function renderTemplate(input: AskModelInput): string {
  const parts: string[] = [];
  for (const r of input.results) {
    switch (r.fn) {
      case "get_safe_to_spend": {
        const s = r.rows as SafeToSpendView;
        parts.push(`${formatUsd(s.safeCents)} is safe to spend before ${s.nextPaydayIso} (about ${formatUsd(s.perDayCents)} a day), after ${formatUsd(s.billsBeforePaydayCents)} of bills and ${formatUsd(s.setAsideCents)} set aside.`);
        break;
      }
      case "get_budget_status": {
        const b = r.rows as BudgetStatus;
        const over = b.lines.filter((l) => l.pace !== "on_track").slice(0, 3);
        parts.push(over.length ? `For ${b.month}, ${over.map((l) => `${l.name} has ${formatUsd(l.leftCents)} left of ${formatUsd(l.budgetCents)}`).join("; ")}.` : `For ${b.month}, every category is on track.`);
        if (b.isSample) parts.push("This is the sample budget until yours is approved.");
        break;
      }
      case "search_transactions": {
        const rows = r.rows as { amountCents: number; merchant: string; date: string }[];
        const total = rows.reduce((s, x) => s + Math.min(0, x.amountCents), 0);
        parts.push(rows.length ? `${rows.length} item${rows.length === 1 ? "" : "s"} totaling ${formatUsd(-total)}; the latest is ${formatUsd(Math.abs(rows[0]!.amountCents))} at ${rows[0]!.merchant} on ${rows[0]!.date}.` : "No matching items.");
        break;
      }
      case "get_bills": {
        const b = r.rows as { bills: { name: string; amountCents: number; dueDate: string; beforePayday: boolean; paid: boolean }[]; nextPayday: string };
        const before = b.bills.filter((x) => x.beforePayday && !x.paid);
        parts.push(before.length ? `${before.length} bill${before.length === 1 ? "" : "s"} before payday on ${b.nextPayday}: ${before.map((x) => `${x.name} ${formatUsd(x.amountCents)} on ${x.dueDate}`).join(", ")}.` : `Nothing is due before payday on ${b.nextPayday}.`);
        break;
      }
      case "get_goals": {
        const g = r.rows as Goal[];
        parts.push(g.length ? g.map((x) => `${x.name}: ${formatUsd(x.currentCents)} of ${formatUsd(x.targetCents)}`).join("; ") + "." : "No goals are set yet.");
        break;
      }
      case "get_paycheck": {
        const p = r.rows as { payDate: string; netCents: number; estimated: boolean; components: { label: string; amountCents: number }[] } | undefined;
        parts.push(p ? `The ${p.payDate} paycheck netted ${formatUsd(p.netCents)}${p.estimated ? " (estimated from the last stub)" : ""}: ${p.components.map((c) => `${c.label} ${formatUsd(c.amountCents)}`).join(", ")}.` : "No paycheck is on file yet.");
        break;
      }
    }
  }
  return parts.join(" ");
}

// Orchestration ---------------------------------------------------------------------------------------

export async function ask(ctx: AskContext, model: AskModelPort, question: string): Promise<AskAnswer> {
  const q = question.trim();
  if (!q) throw new Error("Empty question");
  const cats = await loadCategories(ctx.db, ctx.householdId);
  const catList = [...cats.values()].filter((c) => c.household_visible).map((c) => ({ id: c.id, name: c.name }));
  const draftAction = draftActionFor(q, catList);
  const calls = draftAction ? [{ fn: "get_budget_status" as const, args: { month: ctx.todayIso.slice(0, 7) } }] : planCalls(q, ctx.todayIso, catList);
  const results: FunctionResult[] = [];
  for (const c of calls) {
    if (!ASK_FUNCTIONS.includes(c.fn)) continue;
    results.push(await runFunction(ctx, c.fn, c.args ?? {}));
  }
  let text: string;
  try {
    text = await model.answer({ question: q, categoryNames: catList.map((c) => c.name), results: results.map((r) => ({ fn: r.fn, dataThrough: r.dataThrough, rows: r.rows })) });
  } catch {
    text = renderTemplate({ question: q, categoryNames: [], results });
  }
  if (!text) text = renderTemplate({ question: q, categoryNames: [], results });
  if (draftAction) {
    const to = catList.find((c) => c.id === draftAction.toCategoryId)?.name ?? draftAction.toCategoryId;
    text = `${text} I can draft a move of ${formatUsd(draftAction.amountCents)} to ${to} for ${draftAction.fromCategoryId ? "" : "a category you pick, "}your spouse to approve; nothing changes until then.`.replace(/\s+/g, " ").trim();
  }
  const dataThrough = earliest(results.map((r) => r.dataThrough), ctx.now);
  const used = results.map((r) => ({ fn: r.fn, rows: r.rows }));
  const conv = await ctx.db.query<{ id: string }>(
    "insert into ask_conversations (household_id, member_id, question, answer, used, data_through) values ($1,$2,$3,$4,$5,$6) returning id",
    [ctx.householdId, ctx.memberId, q.slice(0, 1000), text.slice(0, 4000), JSON.stringify(used.map((u) => ({ fn: u.fn }))), dataThrough.at],
  );
  await audit(ctx.db, ctx.householdId, { actor: ctx.memberId, action: "ask.answered", entity: "ask_conversation", entityId: conv.rows[0]!.id, after: { functions: results.map((r) => r.fn), draftAction: draftAction?.kind } });
  const out: AskAnswer = { answer: text, dataThrough, used, conversationId: conv.rows[0]!.id };
  if (draftAction) out.draftAction = draftAction;
  return out;
}

export function earliest(list: readonly DataThrough[], now: Date): DataThrough {
  if (list.length === 0) return { at: now.toISOString(), quality: "missing", pendingCount: 0 };
  const order: DataThrough["quality"][] = ["missing", "stale", "estimated", "imported_pending", "posted_unreconciled", "posted_reconciled"];
  let out = list[0]!;
  for (const d of list) {
    if (d.at < out.at) out = { ...out, at: d.at };
    if (order.indexOf(d.quality) < order.indexOf(out.quality)) out = { ...out, quality: d.quality };
    out = { ...out, pendingCount: Math.max(out.pendingCount, d.pendingCount) };
  }
  return out;
}

export async function askHistory(db: Queryable, householdId: string, memberId: string, limit = 50): Promise<{ id: string; question: string; answer: string; dataThrough?: string; createdAt: string }[]> {
  const r = await db.query<{ id: string; question: string; answer: string | null; data_through: string | null; created_at: string }>(
    "select id, question, answer, data_through, created_at from ask_conversations where household_id = $1 and member_id = $2 and expires_at > now() order by created_at desc limit $3",
    [householdId, memberId, limit],
  );
  return r.rows.map((x) => {
    const o: { id: string; question: string; answer: string; dataThrough?: string; createdAt: string } = { id: x.id, question: x.question, answer: x.answer ?? "", createdAt: new Date(x.created_at).toISOString() };
    if (x.data_through) o.dataThrough = new Date(x.data_through).toISOString();
    return o;
  });
}

/** Conversations are kept 90 days (spec: "Audit and export", retention). */
export async function purgeExpiredConversations(db: Queryable, householdId: string): Promise<number> {
  const r = await db.query("delete from ask_conversations where household_id = $1 and expires_at <= now()", [householdId]);
  return r.rowCount ?? 0;
}
