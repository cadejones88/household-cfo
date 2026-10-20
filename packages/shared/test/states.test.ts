import { describe, expect, it } from "vitest";
import { TRANSACTION_STATES, TRANSITIONS, assertTransition, canTransition, plainStatus } from "../src/states.js";

describe("state machine", () => {
  it("follows the main path", () => {
    const path = ["imported", "needs_classification", "approved", "sent_to_bc", "bc_draft_created", "posted", "reconciled"] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });
  it("refuses skips and backward moves", () => {
    expect(canTransition("imported", "posted")).toBe(false);
    expect(canTransition("posted", "approved")).toBe(false);
    expect(canTransition("approved", "bc_draft_created")).toBe(false);
    expect(() => assertTransition("reconciled", "posted")).toThrow(/Illegal transition/);
  });
  it("restricts who may move a transaction", () => {
    expect(canTransition("ready_for_review", "approved", "member")).toBe(true);
    expect(canTransition("ready_for_review", "approved", "rule_engine")).toBe(false);
    expect(canTransition("needs_classification", "approved", "rule_engine")).toBe(true);
    expect(canTransition("needs_classification", "approved", "member")).toBe(false);
    expect(canTransition("posted", "reversed", "cade")).toBe(true);
    expect(canTransition("posted", "reversed", "member")).toBe(false);
  });
  it("names every state in a transition and every transition's states exist", () => {
    const named = new Set<string>();
    for (const t of TRANSITIONS) {
      named.add(t.from);
      named.add(t.to);
      expect(TRANSACTION_STATES).toContain(t.from);
      expect(TRANSACTION_STATES).toContain(t.to);
    }
    for (const s of TRANSACTION_STATES) expect(named.has(s)).toBe(true);
  });
  it("maps states to Vanessa's five words", () => {
    expect(plainStatus("needs_receipt")).toBe("needs_answer");
    expect(plainStatus("sent_to_bc")).toBe("recorded");
    expect(plainStatus("posted")).toBe("in_books");
    expect(plainStatus("reconciled")).toBe("matched");
    expect(plainStatus("exception")).toBe("being_checked");
  });
});
