/**
 * Plaid Link for the web. Plaid requires its script to load straight from cdn.plaid.com (never bundled or
 * self-hosted), so it is added to the page only when someone starts a connection. Link runs in Plaid's own frame:
 * the bank sign-in never touches this page, and what comes back is a single-use public token plus the names and
 * masks of the accounts the person picked. The API exchanges the token; the access token never reaches the browser.
 *
 * Desktop web needs no redirect URI: OAuth banks (Capital One) open in a pop-up (plaid.com/docs/link/oauth).
 * The Console's CSP allows cdn.plaid.com for script and frame, and sandbox/production.plaid.com for connect.
 */
import { config } from "../config";
import type { BankLoginAccount } from "../api/types";

export const PLAID_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

export type LinkResult =
  | { kind: "success"; publicToken: string; institution: { id?: string; name?: string } | null; accounts: BankLoginAccount[] }
  | { kind: "exit"; errorCode?: string; message?: string };

/** Opens Link with a token and settles once the person finishes or leaves. */
export type OpenLink = (linkToken: string) => Promise<LinkResult>;

interface PlaidLinkMetadataAccount {
  id: string;
  name?: string;
  mask?: string | null;
  type?: string;
  subtype?: string | null;
}
interface PlaidHandler {
  open(): void;
  exit(opts?: { force?: boolean }): void;
  destroy(): void;
}
interface PlaidGlobal {
  create(opts: {
    token: string;
    onSuccess: (publicToken: string, metadata: { institution?: { institution_id?: string; name?: string } | null; accounts?: PlaidLinkMetadataAccount[] }) => void;
    onExit: (error: { error_code?: string; error_message?: string; display_message?: string | null } | null, metadata: unknown) => void;
  }): PlaidHandler;
}

let loading: Promise<PlaidGlobal> | undefined;

export function loadPlaid(doc: Document = document): Promise<PlaidGlobal> {
  const existing = (window as unknown as { Plaid?: PlaidGlobal }).Plaid;
  if (existing) return Promise.resolve(existing);
  loading ??= new Promise<PlaidGlobal>((resolve, reject) => {
    const s = doc.createElement("script");
    s.src = PLAID_SCRIPT;
    s.async = true;
    s.onload = () => {
      const p = (window as unknown as { Plaid?: PlaidGlobal }).Plaid;
      if (p) resolve(p);
      else reject(new Error("Plaid Link did not start"));
    };
    s.onerror = () => {
      loading = undefined;
      s.remove();
      reject(new Error("Plaid Link could not load. Check the connection (or an ad blocker) and try again."));
    };
    doc.head.appendChild(s);
  });
  return loading;
}

export function toLinkAccounts(accounts: readonly PlaidLinkMetadataAccount[] | undefined): BankLoginAccount[] {
  return (accounts ?? []).map((a) => ({ plaidAccountId: a.id, name: a.name || "Account", mask: a.mask ?? null, type: a.type ?? null, subtype: a.subtype ?? null }));
}

export const openPlaidLink: OpenLink = async (linkToken) => {
  const Plaid = await loadPlaid();
  return new Promise<LinkResult>((resolve) => {
    let handler: PlaidHandler | undefined;
    const done = (r: LinkResult) => {
      resolve(r);
      // Let Link finish its own close animation before the frame is removed.
      setTimeout(() => handler?.destroy(), 0);
    };
    handler = Plaid.create({
      token: linkToken,
      onSuccess: (publicToken, metadata) =>
        done({ kind: "success", publicToken, institution: metadata.institution ? { ...(metadata.institution.institution_id ? { id: metadata.institution.institution_id } : {}), ...(metadata.institution.name ? { name: metadata.institution.name } : {}) } : null, accounts: toLinkAccounts(metadata.accounts) }),
      onExit: (error) => done({ kind: "exit", ...(error?.error_code ? { errorCode: error.error_code } : {}), ...(error ? { message: error.display_message || error.error_message || "The bank connection stopped." } : {}) }),
    });
    handler.open();
  });
};

/** VITE_API_MODE=mock: no network. A new connection "returns" Frontier CU; update mode just succeeds. */
export const mockOpenLink: OpenLink = async (linkToken) => {
  await new Promise((r) => setTimeout(r, 300));
  if (linkToken.startsWith("link-mock-update-")) return { kind: "success", publicToken: "", institution: null, accounts: [] };
  const { mockLinkAccounts } = await import("../api/mock/mockApi");
  return { kind: "success", publicToken: "public-mock-frontier", institution: { id: "ins_frontier", name: "Frontier Credit Union" }, accounts: mockLinkAccounts.map((a) => ({ ...a })) };
};

export const defaultOpenLink: OpenLink = config.apiMode === "mock" ? mockOpenLink : openPlaidLink;
