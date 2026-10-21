import { describe, expect, it } from "vitest";
import { PLAIN_STATUS_WORDS, TRANSACTION_STATES, plainStatus, type PlainStatus, type Transaction } from "@homestead/shared";
import { paceKey, rowIcon, safeStatusKey, statusKeyOf, statusLine, statusWord } from "@/model/status";
import { queuedReceiptWords, syncBarText } from "@/model/syncWords";
import { booksFixWords, businessSeenBy, familyAreaOf } from "@/model/people";
import { STATUS_LABEL } from "@/ui/theme";

type Row = Pick<Transaction, "kind" | "status" | "receiptStatus" | "businessFlag" | "categoryId" | "amountCents" | "merchantNorm" | "merchantRaw">;
const row = (over: Partial<Row> = {}): Row => ({ kind: "spend", status: "recorded", receiptStatus: "none", businessFlag: "none", categoryId: "groceries", amountCents: -6412, merchantNorm: "Broulim's", merchantRaw: "BROULIMS", ...over });

describe("plain status words", () => {
  it("every state in the machine reads as one of Vanessa's words, never an accounting term", () => {
    for (const state of TRANSACTION_STATES) {
      const word = statusWord(plainStatus(state));
      expect(Object.values(PLAIN_STATUS_WORDS)).toContain(word);
      expect(word).not.toMatch(/journal|ledger|posted|reconcil|BC|draft|exception/i);
    }
  });

  it("maps the main path to Recorded → In the books → Matched to the bank", () => {
    expect(statusLine(row({ status: plainStatus("approved") }))).toBe("Recorded");
    expect(statusLine(row({ status: plainStatus("bc_draft_created") }))).toBe("Recorded");
    expect(statusLine(row({ status: plainStatus("posted") }))).toBe("In the books");
    expect(statusLine(row({ status: plainStatus("reconciled") }))).toBe("Matched to the bank");
    expect(statusLine(row({ status: plainStatus("ready_for_review") }))).toBe("Needs a quick answer");
    expect(statusLine(row({ status: plainStatus("exception") }))).toBe("Being checked");
  });

  it("transfers, loans and paychecks say what they are instead of a status", () => {
    expect(statusLine(row({ kind: "transfer" }))).toBe("Transfer · not spending");
    expect(statusLine(row({ kind: "bc_native", categoryId: "mortgage" }))).toBe("Mortgage · in the books");
    expect(statusLine(row({ kind: "loan_payment", categoryId: "car-loan" }))).toBe("Loan payment · in the books");
    expect(statusLine(row({ kind: "paycheck" }))).toBe("Paycheck · in the books");
  });

  it("adds estimated split, business and fix-pending in plain words", () => {
    expect(statusLine(row({ receiptStatus: "estimated", status: "in_books" }))).toBe("Estimated split · In the books");
    expect(statusLine(row({ businessFlag: "ctj" }))).toBe("Business · CTJ · Recorded");
    expect(statusLine(row({ businessFlag: "lash" }))).toBe("Business · Lash · Recorded");
    expect(statusLine(row({ status: "in_books" }), { fixPending: true })).toBe("Fix pending");
  });

  it("colors questions as Watch (wheat) and recorded items as calm green; nothing is red", () => {
    const keys = (Object.keys(PLAIN_STATUS_WORDS) as PlainStatus[]).map(statusKeyOf);
    expect(keys).not.toContain("action");
    expect(statusKeyOf("needs_answer")).toBe("watch");
    expect(statusKeyOf("recorded")).toBe("good");
    expect(statusKeyOf("matched")).toBe("good");
    expect(statusKeyOf("being_checked")).toBe("neutral");
  });

  it("budget pace and safe-to-spend use the three calm words only", () => {
    expect([paceKey("on_track"), paceKey("watch"), paceKey("over")].map((k) => STATUS_LABEL[k])).toEqual(["On track", "Watch", "Action needed"]);
    expect([safeStatusKey("on_track"), safeStatusKey("watch"), safeStatusKey("short")].map((k) => STATUS_LABEL[k])).toEqual(["On track", "Watch", "Action needed"]);
  });

  it("draws the row icon like the prototype", () => {
    expect(rowIcon(row({ status: "needs_answer" })).tone).toBe("q");
    expect(rowIcon(row({ receiptStatus: "matched" }))).toEqual({ glyph: "▣", tone: "rc" });
    expect(rowIcon(row({ kind: "paycheck", amountCents: 313559 }))).toEqual({ glyph: "$", tone: "in" });
    expect(rowIcon(row({ kind: "transfer" })).glyph).toBe("⇄");
    expect(rowIcon(row()).glyph).toBe("B");
  });
});

describe("sync words", () => {
  it("says nothing when idle, uploading when online, and 'not synced yet' when offline", () => {
    expect(syncBarText(true, 0)).toBeUndefined();
    expect(syncBarText(true, 1)).toBe("Uploading 1 receipt…");
    expect(syncBarText(true, 3)).toBe("Uploading 3 receipts…");
    expect(syncBarText(false, 2)).toBe("You're offline. 2 receipts saved on your phone — not synced yet.");
    expect(syncBarText(false, 0)).toContain("sent when you're back online");
  });

  it("labels a queued receipt by where it is", () => {
    expect(queuedReceiptWords("queued")).toBe("Not synced yet");
    expect(queuedReceiptWords("uploading")).toBe("Not synced yet");
    expect(queuedReceiptWords("synced")).toBe("Reading your receipt…");
    expect(queuedReceiptWords("error")).toContain("Couldn't be read");
  });
});

describe("who does what", () => {
  it("sends fixes to the bookkeeper in the books, and tells Cade where to find his own", () => {
    expect(booksFixWords("Vanessa")).toBe("Cade will fix it in the books");
    expect(booksFixWords("Cade")).toBe("it's in your Console queue to fix in the books");
    expect(booksFixWords("Cade Jones")).toBe("it's in your Console queue to fix in the books");
    expect(booksFixWords(undefined)).toBe("Cade will fix it in the books");
    expect(businessSeenBy("Vanessa")).toBe("Cade will see it");
  });

  it("finds the FAMILY_AREA for the Mine filter", () => {
    expect(familyAreaOf("Vanessa")).toBe("VANESSA");
    expect(familyAreaOf("Cade Jones")).toBe("CADE");
    expect(familyAreaOf(undefined)).toBe("");
  });
});
