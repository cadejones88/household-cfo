/**
 * Console function 1: the queue table. Rows render with the account, amount, category and state; selection and
 * bulk approval work with the mouse and the keyboard; each state offers its own action; the business flag is a
 * one-step toggle.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConsoleTransactionRow } from "@homestead/shared";
import { QueueTable } from "../src/components/QueueTable";
import { transactions } from "../src/api/mock/data";

const byState = (state: ConsoleTransactionRow["state"]) => transactions.filter((t) => t.state === state);
const ready = byState("ready_for_review");
const exceptions = byState("exception");
const duplicates = byState("possible_duplicate");

describe("QueueTable", () => {
  it("shows an empty state instead of an empty table", () => {
    render(<QueueTable rows={[]} />);
    expect(screen.getByTestId("queue-empty")).toHaveTextContent("Nothing waiting here");
    expect(screen.queryByTestId("queue-table")).toBeNull();
  });

  it("renders one row per transaction with account, masked number, amount, category and state", () => {
    render(<QueueTable rows={ready} />);
    const table = screen.getByTestId("queue-table");
    expect(within(table).getAllByRole("row")).toHaveLength(ready.length + 1); // + header
    const row = within(table).getByTestId("row-tx-0011"); // Verizon, Beehive checking
    expect(row).toHaveTextContent("VERIZON WIRELESS");
    expect(row).toHaveTextContent("−$98.00");
    expect(row).toHaveTextContent("Phones");
    expect(row).toHaveTextContent("Ready for review");
    expect(row).toHaveTextContent(/x\d{4}/); // last four only
    expect(row).not.toHaveTextContent(/\d{8,}/); // never a full account number
  });

  it("tells Cade what Vanessa sees for the same state", () => {
    render(<QueueTable rows={ready.slice(0, 1)} />);
    const tag = screen.getByText("Ready for review");
    expect(tag).toHaveAttribute("title", "Vanessa sees: Needs a quick answer");
  });

  it("selects rows with checkboxes and select-all when selectable", async () => {
    const user = userEvent.setup();
    const onSelectedChange = vi.fn();
    const { rerender } = render(<QueueTable rows={ready} selectable selected={new Set()} onSelectedChange={onSelectedChange} />);
    await user.click(screen.getByLabelText(`Select ${ready[0]!.merchantRaw}`));
    expect(onSelectedChange).toHaveBeenLastCalledWith(new Set([ready[0]!.id]));

    rerender(<QueueTable rows={ready} selectable selected={new Set([ready[0]!.id])} onSelectedChange={onSelectedChange} />);
    await user.click(screen.getByLabelText("Select all"));
    expect(onSelectedChange).toHaveBeenLastCalledWith(new Set(ready.map((r) => r.id)));

    rerender(<QueueTable rows={ready} selectable selected={new Set(ready.map((r) => r.id))} onSelectedChange={onSelectedChange} />);
    expect(screen.getByLabelText("Select all")).toBeChecked();
    await user.click(screen.getByLabelText("Select all"));
    expect(onSelectedChange).toHaveBeenLastCalledWith(new Set());
  });

  it("hides the selection column when the queue is not bulk-approvable", () => {
    render(<QueueTable rows={exceptions} />);
    expect(screen.queryByLabelText("Select all")).toBeNull();
  });

  it("is keyboard-friendly: arrows move focus, Space selects, A approves the selection, Enter opens the action", () => {
    const onSelectedChange = vi.fn();
    const onApproveSelected = vi.fn();
    const onWrong = vi.fn();
    const { rerender } = render(<QueueTable rows={ready} selectable selected={new Set()} onSelectedChange={onSelectedChange} onApproveSelected={onApproveSelected} onWrong={onWrong} />);
    const first = screen.getByTestId(`row-${ready[0]!.id}`);
    const second = screen.getByTestId(`row-${ready[1]!.id}`);
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "-1");

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(second, { key: " " });
    expect(onSelectedChange).toHaveBeenLastCalledWith(new Set([ready[1]!.id]));

    // "a" only approves when something is selected
    fireEvent.keyDown(second, { key: "a" });
    expect(onApproveSelected).not.toHaveBeenCalled();
    rerender(<QueueTable rows={ready} selectable selected={new Set([ready[1]!.id])} onSelectedChange={onSelectedChange} onApproveSelected={onApproveSelected} onWrong={onWrong} />);
    fireEvent.keyDown(screen.getByTestId(`row-${ready[1]!.id}`), { key: "a" });
    expect(onApproveSelected).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByTestId(`row-${ready[1]!.id}`), { key: "Enter" });
    expect(onWrong).toHaveBeenCalledWith(expect.objectContaining({ id: ready[1]!.id }));
  });

  it("offers Resolve for exceptions and shows the reason", async () => {
    const user = userEvent.setup();
    const onResolveException = vi.fn();
    render(<QueueTable rows={exceptions} onResolveException={onResolveException} />);
    const row = screen.getByTestId("row-tx-0014");
    expect(row).toHaveTextContent("Exception");
    expect(row).toHaveTextContent("draft line not found in HHAPP/FEEDS");
    await user.click(within(row).getByRole("button", { name: "Resolve" }));
    expect(onResolveException).toHaveBeenCalledWith(expect.objectContaining({ id: "tx-0014" }));
    expect(within(row).queryByRole("button", { name: "This is wrong" })).toBeNull();
  });

  it("offers Not a repeat / Same thing for possible duplicates and names the twin", async () => {
    const user = userEvent.setup();
    const onDuplicate = vi.fn();
    render(<QueueTable rows={duplicates} onDuplicate={onDuplicate} />);
    const row = screen.getByTestId("row-tx-0001");
    expect(row).toHaveTextContent("may repeat tx-0021");
    await user.click(within(row).getByRole("button", { name: "Same thing" }));
    expect(onDuplicate).toHaveBeenCalledWith(expect.objectContaining({ id: "tx-0001" }), "same_thing");
    await user.click(within(row).getByRole("button", { name: "Not a repeat" }));
    expect(onDuplicate).toHaveBeenCalledWith(expect.objectContaining({ id: "tx-0001" }), "not_a_repeat");
  });

  it("toggles the business flag in one step", async () => {
    const user = userEvent.setup();
    const onBusinessFlag = vi.fn();
    render(<QueueTable rows={ready} onBusinessFlag={onBusinessFlag} />);
    const select = screen.getByLabelText(`Business flag for ${ready[0]!.merchantRaw}`);
    expect(select).toHaveValue("none");
    await user.selectOptions(select, "ctj");
    expect(onBusinessFlag).toHaveBeenCalledWith(expect.objectContaining({ id: ready[0]!.id }), "ctj");
    // tx-0026 is already flagged CTJ in the fixtures
    expect(screen.getByLabelText("Business flag for AMZN MKTP US*7H1Q")).toHaveValue("ctj");
  });

  it("disables actions while busy", () => {
    render(<QueueTable rows={ready} busy onWrong={vi.fn()} onBusinessFlag={vi.fn()} />);
    for (const b of screen.getAllByRole("button", { name: "This is wrong" })) expect(b).toBeDisabled();
    expect(screen.getByLabelText(`Business flag for ${ready[0]!.merchantRaw}`)).toBeDisabled();
  });

  it("shows the BC keys for lines that reached BC and 'not sent' for the rest", () => {
    render(<QueueTable rows={[...exceptions, ...ready.slice(0, 1)]} />);
    const ex = screen.getByTestId("row-tx-0014");
    expect(within(ex).getByTitle("External Document No.")).toHaveTextContent(/^HHAPP-/);
    expect(ex).toHaveTextContent("HHAPP/FEEDS");
    expect(ex).toHaveTextContent("difference");
    expect(screen.getByTestId(`row-${ready[0]!.id}`)).toHaveTextContent("not sent");
  });
});
