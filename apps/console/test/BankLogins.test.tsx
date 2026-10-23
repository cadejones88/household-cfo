/**
 * Connecting a bank from the Console (mock API, fake Link): the sign-in check runs before Link opens; the mapping
 * dialog starts from the suggestions and saves only what the person confirms; leaving the dialog saves nothing;
 * the owner reconnects through update mode and the other spouse only sees the login.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../src/api/ApiProvider";
import { createMockApi, mockLinkAccounts } from "../src/api/mock/mockApi";
import type { ConsoleApi } from "../src/api/types";
import { AuthProvider } from "../src/auth/AuthProvider";
import { ConnectBank, FeedActions } from "../src/components/BankLogins";
import type { OpenLink } from "../src/lib/plaidLink";
import * as data from "../src/api/mock/data";

function wrap(api: ConsoleApi, node: React.ReactNode) {
  return render(
    <AuthProvider>
      <ApiProvider api={api}>{node}</ApiProvider>
    </AuthProvider>,
  );
}

const frontier: OpenLink = async () => ({ kind: "success", publicToken: "public-frontier", institution: { id: "ins_frontier", name: "Frontier Credit Union" }, accounts: mockLinkAccounts.map((a) => ({ ...a })) });

describe("Connect a bank", () => {
  it("checks the sign-in first, suggests the share account, leaves the loan out, and saves the confirmed mapping", async () => {
    const api = createMockApi();
    const order: string[] = [];
    const confirm = vi.spyOn(api, "confirmStepUp").mockImplementation(async () => void order.push("stepUp"));
    const token = vi.spyOn(api, "bankLinkToken").mockImplementation(async () => (order.push("token"), { linkToken: "link-x", expiration: "" }));
    const link = vi.spyOn(api, "linkBank");
    const say = vi.fn();
    wrap(api, <ConnectBank openLink={async (t) => (order.push(`open:${t}`), frontier(t))} say={say} />);
    await userEvent.click(screen.getByTestId("connect-bank"));
    const dlg = await screen.findByTestId("map-accounts-dialog");
    expect(order).toEqual(["stepUp", "token", "open:link-x"]);
    expect(confirm).toHaveBeenCalledOnce();
    expect(token).toHaveBeenCalledOnce();
    const share = within(dlg).getByLabelText("Where Primary Share ending 7003 goes") as HTMLSelectElement;
    await waitFor(() => expect(share.value).toBe("acct-FRONTIER-SH"));
    expect((within(dlg).getByLabelText("Where Auto Loan ending 0001 goes") as HTMLSelectElement).value).toBe("");
    await userEvent.click(within(dlg).getByTestId("save-mapping"));
    await waitFor(() => expect(link).toHaveBeenCalledWith({ publicToken: "public-frontier", institutionId: "ins_frontier", institutionName: "Frontier Credit Union", accounts: [{ accountId: "acct-FRONTIER-SH", plaidAccountId: "pa-frontier-share" }] }));
    await waitFor(() => expect(say).toHaveBeenCalledWith(expect.stringMatching(/Frontier Credit Union connected: 1 account/)));
  });

  it("closing the dialog saves nothing", async () => {
    const api = createMockApi();
    const link = vi.spyOn(api, "linkBank");
    const say = vi.fn();
    wrap(api, <ConnectBank openLink={frontier} say={say} />);
    await userEvent.click(screen.getByTestId("connect-bank"));
    const dlg = await screen.findByTestId("map-accounts-dialog");
    await userEvent.click(within(dlg).getByRole("button", { name: "Don't connect" }));
    expect(link).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.stringMatching(/not connected\. Nothing was saved/));
  });

  it("shows Plaid's message when the person leaves Link with an error, and saves nothing", async () => {
    const api = createMockApi();
    const link = vi.spyOn(api, "linkBank");
    wrap(api, <ConnectBank openLink={async () => ({ kind: "exit", errorCode: "INSTITUTION_DOWN", message: "This bank is not answering right now." })} say={vi.fn()} />);
    await userEvent.click(screen.getByTestId("connect-bank"));
    expect(await screen.findByRole("alert")).toHaveTextContent("This bank is not answering right now.");
    expect(screen.queryByTestId("map-accounts-dialog")).toBeNull();
    expect(link).not.toHaveBeenCalled();
  });
});

describe("A login's actions", () => {
  const capone = data.feeds.find((f) => f.id === "feed-capone")!;
  const beehive = data.feeds.find((f) => f.id === "feed-beehive")!;

  it("the owner reconnects through update mode; the re-link flag clears through the sync, not the browser", async () => {
    const api = createMockApi();
    const reconnected = vi.spyOn(api, "feedReconnected");
    const opened: string[] = [];
    const say = vi.fn();
    wrap(api, <FeedActions feed={capone} memberId={data.CADE_ID} openLink={async (t) => (opened.push(t), { kind: "success", publicToken: "", institution: null, accounts: [] })} say={say} />);
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(reconnected).toHaveBeenCalledWith("feed-capone"));
    expect(opened).toEqual(["link-mock-update-feed-capone"]);
    await waitFor(() => expect(say).toHaveBeenCalledWith(expect.stringMatching(/A sync is queued/)));
  });

  it("the other spouse sees the login's accounts but cannot change or remove it", async () => {
    const api = createMockApi();
    wrap(api, <FeedActions feed={beehive} memberId={data.CADE_ID} say={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByText("Only Vanessa can change this login")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View accounts" }));
    const dlg = await screen.findByTestId("map-accounts-dialog");
    // Bank account name on the left, the household account it feeds on the right.
    expect(within(dlg).getAllByText("Beehive checking", { selector: "td" })).toHaveLength(2);
    expect(within(dlg).queryByTestId("save-mapping")).toBeNull();
    expect(within(dlg).queryByRole("combobox")).toBeNull();
  });

  it("removing asks first, then ends Plaid's access", async () => {
    const api = createMockApi();
    const unlink = vi.spyOn(api, "unlinkFeed");
    const say = vi.fn();
    wrap(api, <FeedActions feed={capone} memberId={data.CADE_ID} say={say} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dlg = screen.getByTestId("remove-login-dialog");
    expect(unlink).not.toHaveBeenCalled();
    await userEvent.click(within(dlg).getByRole("button", { name: "Remove login" }));
    await waitFor(() => expect(unlink).toHaveBeenCalledWith("feed-capone"));
    await waitFor(() => expect(say).toHaveBeenCalledWith("Capital One removed. Plaid's access has ended."));
  });
});
