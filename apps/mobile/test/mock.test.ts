/**
 * MockApi (EXPO_PUBLIC_API_MODE=mock) serves the approved prototype's sample data and behaves like the API on
 * the rules that matter to the screens: the other spouse decides, deciding needs a fresh step-up, the same photo
 * is held once, a posted item's correction becomes a request for the bookkeeper.
 */
import { describe, expect, it } from "vitest";
import { MockApi, nextFriday } from "@/api/mock";
import { ApiError, StepUpRequiredError } from "@/api/types";

const NOW = new Date("2026-10-20T16:00:00.000Z"); // Tue Oct 20, 10 am in Boise

function api(member = "dev-vanessa", stepUp = true) {
  let who = member;
  let fresh = stepUp;
  const m = new MockApi(() => who, { now: NOW, fast: true, stepUpFresh: () => fresh });
  return { m, as: (id: string) => (who = id), stepUp: (v: boolean) => (fresh = v) };
}

describe("MockApi sample data", () => {
  it("pays on the next Friday at least three days out, like the prototype", () => {
    expect(nextFriday("2026-10-20", 3)).toBe("2026-10-23");
    expect(nextFriday("2026-10-21", 3)).toBe("2026-10-30");
  });

  it("shows the prototype's safe to spend: $1,012.02 − $300 set aside − the two bills before payday", async () => {
    const { m } = api();
    const s = await m.safeToSpend();
    expect(s.cashCents).toBe(101202);
    expect(s.setAsideCents).toBe(30000);
    expect(s.billsBeforePayday.map((b) => b.name)).toEqual(["Verizon · phones", "Rocky Mountain Power"]);
    expect(s.safeCents).toBe(101202 - 30000 - 15320 - 11840);
    expect(s.status).toBe("on_track");
    expect(s.nextPaydayIso).toBe("2026-10-23");
    expect(s.dataThrough.at.startsWith("2026-10-19")).toBe(true);
  });

  it("asks Vanessa the three prototype questions plus Cade's budget move", async () => {
    const { m } = api();
    const q = await m.questions();
    expect(q.questions.map((x) => x.kind).sort()).toEqual(["approve_budget_move", "confirm_category", "confirm_split", "pick_category"]);
    expect(q.questions.every((x) => x.why.startsWith("Why we're asking") || x.kind === "approve_budget_move")).toBe(true);
  });

  it("marks budget lines sample until the real budget is approved", async () => {
    const b = await api().m.budget();
    expect(b.isSample).toBe(true);
    expect(b.lines.find((l) => l.categoryId === "allowance-cade")?.isAllowance).toBe(true);
  });
});

describe("MockApi behaviour", () => {
  it("answers a question once and records the item", async () => {
    const { m } = api();
    const r = await m.answerQuestion("tx:t3", { optionId: "confirm" });
    expect(r.transaction?.status).toBe("recorded");
    await expect(m.answerQuestion("tx:t3", { optionId: "confirm" })).rejects.toBeInstanceOf(ApiError);
    expect((await m.questions()).questions.some((q) => q.id === "tx:t3")).toBe(false);
  });

  it("lets only the other spouse decide, and only with a fresh step-up (approve or decline)", async () => {
    const { m, as, stepUp } = api("dev-vanessa", false);
    const move = await m.proposeBudgetMove({ fromCategoryId: "fun-shopping", toCategoryId: "groceries-household", amountCents: 5000 });
    await expect(m.decideApproval(move.id, "approved")).rejects.toMatchObject({ code: "other_spouse_decides" });
    as("dev-cade");
    expect((await m.questions()).questions.some((q) => q.approvalId === move.id)).toBe(true);
    await expect(m.decideApproval(move.id, "declined")).rejects.toBeInstanceOf(StepUpRequiredError);
    stepUp(true);
    const decided = await m.decideApproval(move.id, "approved");
    expect(decided.decision).toBe("approved");
    const budget = await m.budget();
    expect(budget.lines.find((l) => l.categoryId === "groceries-household")?.budgetCents).toBe(190000 + 5000);
    expect(typeof decided.payload["revisionNo"]).toBe("number");
  });

  it("holds the same photo once (by hash) and reads it into the Broulim's split", async () => {
    const { m } = api();
    const sha = "d".repeat(64);
    const first = await m.uploadReceipt({ fileUri: "file:///x.jpg", sha256: sha, capturedAt: NOW.toISOString(), offlineId: "man:1111", bytes: 1 });
    const again = await m.uploadReceipt({ fileUri: "file:///y.jpg", sha256: sha, capturedAt: NOW.toISOString(), offlineId: "man:2222", bytes: 1 });
    expect(first.alreadyHeld).toBe(false);
    expect(again).toMatchObject({ alreadyHeld: true, receipt: { id: first.receipt.id } });
    expect((await m.receipt(first.receipt.id)).ocrStatus).toBe("queued");
    await new Promise((r) => setTimeout(r, 20));
    const read = await m.receipt(first.receipt.id);
    expect(read).toMatchObject({ ocrStatus: "read", merchant: "Broulim's", totalCents: 3186 });
    expect(read.split?.lines.map((l) => l.categoryId)).toEqual(["groceries", "household-supplies"]);
  });

  it("fixes an unposted item at once and turns a posted one into a request for the bookkeeper", async () => {
    const { m } = api();
    const before = await m.correctTransaction("t1", { categoryId: "treats" });
    expect(before.correctionRequestId).toBeUndefined();
    expect(before.transaction.categoryId).toBe("treats");
    const after = await m.correctTransaction("t6", { categoryId: "eating-out" });
    expect(after.correctionRequestId).toBeDefined();
    expect((await m.transaction("t6")).exceptionReason).toBe("fix_pending");
    expect((await m.transaction("t6")).categoryId).toBe("food-delivery");
  });

  it("drafts a move from Ask but never moves money itself", async () => {
    const { m } = api();
    const a = await m.ask("Move $40 to groceries");
    expect(a.draftAction).toMatchObject({ kind: "budget_move", toCategoryId: "groceries-household", amountCents: 4000 });
    expect((await m.approvals("open")).filter((x) => x.kind === "budget_move" && x.requestedBy === "dev-vanessa")).toEqual([]);
    expect(a.dataThrough.pendingCount).toBeGreaterThan(0);
  });

  it("tags lines with the family area for the Mine filter", async () => {
    const page = await api().m.transactions({ limit: 100 });
    expect(page.transactions.find((t) => t.id === "t3")?.dims.FAMILY_AREA).toBe("VANESSA");
    expect(page.transactions.find((t) => t.id === "t1")?.dims.FAMILY_AREA).toBe("CADE");
  });
});
