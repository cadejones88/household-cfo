/**
 * The exception dialog shows the keys on both sides, requires a note, and only lets Cade record "posted" when BC
 * entry numbers are given (BC wins; the app stores the entry numbers it was told).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExceptionResolveDialog, parseEntryNos } from "../src/components/ExceptionResolveDialog";
import { transactions } from "../src/api/mock/data";

const missingDraft = transactions.find((t) => t.id === "tx-0014")!; // draft gone from BC; BC reported nothing to post against
const unknownEntry = transactions.find((t) => t.id === "tx-0016")!; // BC entries 4471, 4472 the app did not know

describe("parseEntryNos", () => {
  it("accepts comma, space and semicolon separated positive integers and drops the rest", () => {
    expect(parseEntryNos("4471, 4472")).toEqual([4471, 4472]);
    expect(parseEntryNos("4471;4472 4473")).toEqual([4471, 4472, 4473]);
    expect(parseEntryNos("")).toEqual([]);
    expect(parseEntryNos("abc, -1, 0, 4.5, 12")).toEqual([12]);
  });
});

describe("ExceptionResolveDialog", () => {
  it("renders nothing when closed", () => {
    render(<ExceptionResolveDialog row={null} onClose={vi.fn()} onResolve={vi.fn()} />);
    expect(screen.getByTestId("exception-dialog")).not.toHaveAttribute("open");
    expect(screen.queryByTestId("exception-keys")).toBeNull();
  });

  it("shows the reason and the keys on both sides", () => {
    render(<ExceptionResolveDialog row={missingDraft} onClose={vi.fn()} onResolve={vi.fn()} />);
    expect(screen.getByTestId("exception-dialog")).toHaveAttribute("open");
    expect(screen.getByText(/draft line not found in HHAPP\/FEEDS/)).toBeInTheDocument();
    const keys = screen.getByTestId("exception-keys");
    expect(keys).toHaveTextContent(missingDraft.idempotencyKey);
    expect(keys).toHaveTextContent(missingDraft.bc!.externalDocumentNo);
    expect(keys).toHaveTextContent("line-14-1");
    expect(keys).toHaveTextContent("No journal line or G/L entry carries this External Document No.");
    expect(keys).toHaveTextContent("0 / $0.00"); // BC side: zero lines, zero sum
  });

  it("defaults to 'send back to review' when BC reported no entries, and needs a note", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ExceptionResolveDialog row={missingDraft} onClose={onClose} onResolve={onResolve} />);
    const submit = screen.getByTestId("resolve-submit");
    expect(submit).toHaveTextContent("Send back to review");
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Resolution note"), "Draft was deleted in BC by mistake; re-approve.");
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onResolve).toHaveBeenCalledWith("tx-0014", { to: "ready_for_review", note: "Draft was deleted in BC by mistake; re-approve." });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("defaults to 'posted' with the entry numbers pre-filled when BC reported them", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ExceptionResolveDialog row={unknownEntry} onClose={vi.fn()} onResolve={onResolve} />);
    expect(screen.getByTestId("resolve-submit")).toHaveTextContent("Record as posted");
    expect(screen.getByLabelText("BC entry numbers")).toHaveValue("4471, 4472");
    await user.type(screen.getByLabelText("Resolution note"), "Loan payment posted by hand in BC on the statement date.");
    await user.type(screen.getByLabelText("BC document number"), "G01016");
    await user.click(screen.getByTestId("resolve-submit"));
    expect(onResolve).toHaveBeenCalledWith("tx-0016", expect.objectContaining({ to: "posted", bcEntryNos: [4471, 4472], bcDocumentNo: "G01016", note: "Loan payment posted by hand in BC on the statement date." }));
  });

  it("will not record 'posted' without BC entry numbers", async () => {
    const user = userEvent.setup();
    render(<ExceptionResolveDialog row={missingDraft} onClose={vi.fn()} onResolve={vi.fn()} />);
    await user.type(screen.getByLabelText("Resolution note"), "note");
    await user.click(within(screen.getByRole("radiogroup", { name: "Resolution" }).parentElement!).getByLabelText(/Mark Posted/));
    const submit = screen.getByTestId("resolve-submit");
    expect(submit).toHaveTextContent("Record as posted");
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("BC entry numbers"), "4490");
    expect(submit).toBeEnabled();
  });

  it("shows the API's error instead of closing", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onResolve = vi.fn().mockRejectedValue(new Error("A resolution needs a note; it is recorded with the keys on both sides."));
    render(<ExceptionResolveDialog row={missingDraft} onClose={onClose} onResolve={onResolve} />);
    await user.type(screen.getByLabelText("Resolution note"), "x");
    await user.click(screen.getByTestId("resolve-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("A resolution needs a note");
    expect(onClose).not.toHaveBeenCalled();
  });
});
