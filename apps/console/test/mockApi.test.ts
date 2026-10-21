// @vitest-environment node
/**
 * The mock API behind VITE_API_MODE=mock follows the same rules as the real one: the state machine, an audit row
 * per change, an outbox row for anything bound for BC, and no posting from the Console itself.
 */
import { describe, expect, it } from "vitest";
import { createMockApi } from "../src/api/mock/mockApi";

describe("mock ConsoleApi", () => {
  it("approving ready_for_review rows moves them to approved, writes audit and outbox rows, and skips the rest", async () => {
    const api = createMockApi();
    const ready = await api.transactions("ready_for_review");
    const outboxBefore = (await api.outbox()).total;
    const ids = ready.items.slice(0, 2).map((t) => t.id);
    const r = await api.approveTransactions([...ids, "tx-0014" /* an exception */, "nope"]);
    expect(r.approved).toBe(2);
    expect(r.skipped.map((s) => s.id).sort()).toEqual(["nope", "tx-0014"]);
    expect((await api.transactions("ready_for_review")).total).toBe(ready.total - 2);
    expect((await api.outbox()).total).toBe(outboxBefore + 2);
    const audit = await api.audit({ entity: "transaction", entityId: ids[0] });
    expect(audit.items[0]?.action).toBe("transaction.approve");
  });

  it("resolving an exception needs a note, and 'posted' needs entry numbers", async () => {
    const api = createMockApi();
    await expect(api.resolveException("tx-0014", { to: "ready_for_review", note: " " })).rejects.toMatchObject({ code: "note_required" });
    await expect(api.resolveException("tx-0014", { to: "posted", note: "x", bcEntryNos: [] })).rejects.toMatchObject({ code: "entry_nos_required" });
    const t = await api.resolveException("tx-0016", { to: "posted", note: "posted by hand", bcEntryNos: [4471, 4472], bcDocumentNo: "G01016" });
    expect(t.state).toBe("posted");
    expect(t.bc?.entryNos).toEqual([4471, 4472]);
    expect(t.bc?.syncStatus).toBe("in_sync");
    expect(t.exception).toBeUndefined();
    const back = await api.resolveException("tx-0014", { to: "ready_for_review", note: "re-approve" });
    expect(back.state).toBe("ready_for_review");
  });

  it("post batch only queues a request and refuses an empty batch", async () => {
    const api = createMockApi();
    const before = await api.syncStatus();
    const feeds = before.batches.find((b) => b.batch === "FEEDS")!;
    expect(feeds.appDraftCount).toBeGreaterThan(0);
    const r = await api.postBatch("FEEDS");
    expect(r.lineCount).toBe(feeds.appDraftCount);
    expect(r.outboxId).toMatch(/^ob-/);
    const after = await api.syncStatus();
    // Nothing posted: the Console never posts; the drafts are still drafts until BC says otherwise.
    expect(after.batches.find((b) => b.batch === "FEEDS")!.appDraftCount).toBe(feeds.appDraftCount);
    expect(after.batches.find((b) => b.batch === "FEEDS")!.lastPostRequestedAt).toBeDefined();
    await expect(api.postBatch("AUTOPOST")).rejects.toMatchObject({ code: "nothing_to_post" });
  });

  it("the other spouse decides a rule", async () => {
    const api = createMockApi();
    // "This is wrong" with "make a rule" proposes a merchant rule in Cade's name...
    const before = (await api.rules("proposed")).total;
    await api.correctTransaction("tx-0006", { categoryId: "eating-out", makeRule: true });
    const proposed = await api.rules("proposed");
    expect(proposed.total).toBe(before + 1);
    const byCade = proposed.items.find((r) => r.proposedByName === "Cade");
    const byVanessa = proposed.items.find((r) => r.proposedByName === "Vanessa");
    expect(byCade && byVanessa).toBeTruthy();
    expect(byCade!.mayAutoPost).toBe(false);
    // ...which Cade cannot approve himself; Vanessa's proposal he can.
    await expect(api.decideRule(byCade!.id, "approve")).rejects.toMatchObject({ code: "other_spouse_decides" });
    const ok = await api.decideRule(byVanessa!.id, "approve", "fine");
    expect(ok.state).toBe("approved");
  });

  it("retrying a dead letter requeues it with attempts reset", async () => {
    const api = createMockApi();
    const dead = await api.outbox({ deadLettered: true });
    expect(dead.total).toBeGreaterThan(0);
    const o = await api.retryOutbox(dead.items[0]!.id);
    expect(o.deadLettered).toBe(false);
    expect(o.attempts).toBe(0);
    await expect(api.retryOutbox(o.id)).rejects.toMatchObject({ code: "not_dead_lettered" });
  });

  it("every listing carries a data-through line", async () => {
    const api = createMockApi();
    for (const p of [await api.transactions("exception"), await api.receipts("unmatched"), await api.rules("approved"), await api.syncRuns(), await api.audit()]) {
      expect(p.dataThrough.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(p.dataThrough.quality).toBeTruthy();
    }
    expect((await api.reconciliation()).bankCards).toHaveLength(14);
    expect((await api.reconciliation()).loans.map((l) => l.lender).sort()).toEqual(["Frontier CU", "Frontier CU", "PennyMac"]);
  });
});
