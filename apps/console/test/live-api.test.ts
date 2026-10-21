// @vitest-environment node
/**
 * The Console's HTTP client against a running API (AUTH_MODE=dev) with a seeded household. Skipped unless
 * CONSOLE_LIVE_API_URL, CONSOLE_LIVE_MEMBER_ID (Cade) and CONSOLE_LIVE_OTHER_MEMBER_ID (Vanessa) are set:
 *
 *   DATABASE_URL=… pnpm --filter @homestead/api db:migrate && DATABASE_URL=… pnpm --filter @homestead/api db:seed
 *   DATABASE_URL=… AUTH_MODE=dev PORT=18081 pnpm --filter @homestead/api dev
 *   CONSOLE_LIVE_API_URL=http://127.0.0.1:18081 CONSOLE_LIVE_MEMBER_ID=<cade> CONSOLE_LIVE_OTHER_MEMBER_ID=<vanessa> \
 *     pnpm --filter @homestead/console exec vitest run test/live-api.test.ts
 *
 * It writes to that database (manual transactions, approvals, a rule, a post request), so point it at a scratch one.
 */
import { describe, expect, it } from "vitest";
import { BANK_CARD_LIST, CATEGORIES } from "@homestead/shared";
import { createHttpApi } from "../src/api/http";
import { ApiError, type ConsoleApi } from "../src/api/types";

const baseUrl = process.env["CONSOLE_LIVE_API_URL"];
const cade = process.env["CONSOLE_LIVE_MEMBER_ID"];
const vanessa = process.env["CONSOLE_LIVE_OTHER_MEMBER_ID"];
const live = Boolean(baseUrl && cade && vanessa);

function client(memberId: string): ConsoleApi {
  return createHttpApi({
    baseUrl: baseUrl!,
    getAuthHeaders: async () => ({ "x-dev-member": memberId }),
    getStepUpHeaders: async () => ({ "x-dev-member": memberId, "x-step-up": "true" }),
    member: () => ({ id: memberId, displayName: memberId === cade ? "Cade" : "Vanessa" }),
    healthReportPath: `${baseUrl}/health`,
  });
}

async function raw<T>(method: string, path: string, memberId: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { "x-dev-member": memberId, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

describe.skipIf(!live)("Console HTTP client against a running API", () => {
  it("reads every MVP screen and runs the Console's writes through the real routes", async () => {
    const api = client(cade!);
    const other = client(vanessa!);

    // Header
    const me = await api.me();
    expect(me.member.id).toBe(cade);
    expect(me.household.id).not.toBe("");
    expect(me.household.settingsVersion).toBeGreaterThanOrEqual(1);

    // Three manual lines on the checking account, with a category, so the queue has something to approve.
    const accounts = await raw<{ accounts: { id: string; bcBankAccountCode?: string }[] }>("GET", "/v1/accounts", cade!);
    const checking = accounts.accounts.find((a) => a.bcBankAccountCode === "BEEHIVE-CHK") ?? accounts.accounts[0]!;
    const groceries = CATEGORIES.find((c) => c.group !== "Income" && !c.isTransfer && !c.isAllowance)!;
    for (const [i, merchant] of ["CONSOLE LIVE A", "CONSOLE LIVE B", "CONSOLE LIVE C"].entries()) {
      await raw("POST", "/v1/transactions", cade!, { clientId: crypto.randomUUID(), accountId: checking.id, postedDate: "2026-10-1" + i, amountCents: -(1234 + i), merchant, categoryId: groceries.id });
    }

    // 1. Work queues
    const states = ["ready_for_review", "needs_classification", "needs_receipt", "possible_duplicate", "exception"] as const;
    const pages = Object.fromEntries(await Promise.all(states.map(async (s) => [s, await api.transactions(s)] as const)));
    for (const s of states) expect(pages[s]!.dataThrough.at).toBeTruthy();
    const ready = pages["ready_for_review"]!.items;
    const mine = ready.filter((t) => t.merchantRaw.startsWith("CONSOLE LIVE"));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]!.accountMask).toMatch(/^[\d-]{3,}$/);

    // "This is wrong" with a rule proposal on one line, approve the rest
    const [fix, ...rest] = mine;
    const other2 = CATEGORIES.find((c) => c.group === groceries.group && c.id !== groceries.id) ?? CATEGORIES.find((c) => c.id !== groceries.id && !c.isTransfer)!;
    const fixed = await api.correctTransaction(fix!.id, { categoryId: other2.id, note: "live test", makeRule: true });
    expect(fixed.categoryId).toBe(other2.id);
    if (rest.length) {
      const r = await api.approveTransactions(rest.map((t) => t.id));
      expect(r.approved + r.skipped.length).toBe(rest.length);
      expect(r.approved).toBeGreaterThan(0);
    }
    const flagged = await api.setBusinessFlag(fix!.id, "ctj");
    expect(flagged.businessFlag).toBe("ctj");

    // Rules: Cade proposed the rule, so Cade cannot approve it; Vanessa can (step-up)
    const proposed = await api.rules("proposed");
    const rule = proposed.items.find((r) => r.name.startsWith("CONSOLE LIVE A") || r.name.includes(other2.name));
    expect(rule).toBeDefined();
    const refused = await api.decideRule(rule!.id, "approve").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    const approved = await other.decideRule(rule!.id, "approve", "live test");
    expect(approved.state).toBe("approved");
    const retired = await other.decideRule(rule!.id, "retire", "live test cleanup");
    expect(retired.state).toBe("retired");

    // Receipts tabs read without error
    await api.receipts("unmatched");
    await api.receipts("needs_review");

    // 2. BC sync and posting: a post request is recorded, never posted by the API
    const sync = await api.syncStatus();
    expect(sync.batches.map((b) => b.batch)).toEqual(["FEEDS", "RECEIPTS", "AUTOPOST"]);
    const post = await api.postBatch("FEEDS");
    expect(post.enqueued).toBe(false);
    expect(post.outboxId).not.toBe("");
    expect(post.message).toMatch(/sign-in/);
    const after = await api.syncStatus();
    expect(after.batches.find((b) => b.batch === "FEEDS")?.lastPostRequestedAt).toBeTruthy();

    // 3. Reconciliation
    const recon = await api.reconciliation();
    expect(recon.bankCards).toHaveLength(BANK_CARD_LIST.length);
    expect(recon.missing).toContain("loans");

    // 4. Mappings (employer templates come from the API now); proposals are refused in the client
    const maps = await api.mappings();
    expect(maps.categories.length).toBeGreaterThan(10);
    expect(maps.dimensions.map((d) => d.code)).toEqual(expect.arrayContaining(["SPEND_CLASS", "FUND_GOAL", "FAMILY_AREA", "TAX_TREATMENT", "PROJECT"]));
    expect(maps.employers.map((e) => e.code).sort()).toEqual(["CTJ", "HFH"]);
    await expect(api.proposeMapping({ categoryId: groceries.id, glAccount: groceries.glAccount, dims: {}, reason: "x" })).rejects.toMatchObject({ code: "not_in_api" });

    // 11. Authority matrix
    const auth = await api.authority();
    expect(auth.rows.length).toBeGreaterThan(5);
    expect(auth.rows.some((r) => r.tbd)).toBe(true);

    // 12. Connections, runs, outbox, audit
    const conn = await api.connections();
    expect(Array.isArray(conn.feeds)).toBe(true);
    await api.syncRuns({ kind: "bc_poll" });
    const outbox = await api.outbox();
    expect(outbox.items.some((o) => o.operation === "post_batch")).toBe(true);
    const audit = await api.audit({ entity: "batch" });
    expect(audit.items.some((a) => a.action === "post.requested" && a.entityId === "FEEDS")).toBe(true);
    const txAudit = await api.audit({ entity: "transaction", entityId: fix!.id });
    expect(txAudit.items.length).toBeGreaterThan(0);
  }, 60_000);
});
