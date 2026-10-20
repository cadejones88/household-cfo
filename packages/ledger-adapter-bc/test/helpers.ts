import { externalDocumentNo, idempotencyKey, toBcDimensionSetLines, type DimensionSet } from "@homestead/shared";
import { BusinessCentralAdapter, type BcAdapterConfig } from "../src/bcAdapter.js";
import { StaticTokenProvider } from "../src/auth.js";
import { BcHttp, type BatchFormat } from "../src/http.js";
import { MockBcServer, type MockBcServerOptions } from "../src/mock/MockBcServer.js";
import type { JournalLineInput } from "../src/types.js";

export interface Receiver {
  /** Behaves like the Homestead webhook receiver: echoes validationToken with 200, answers notifications with 202. */
  deliver: (url: string, init: RequestInit) => Promise<Response>;
  notifications: unknown[];
  handshakes: string[];
  /** Flip to make the receiver fail the handshake or the delivery. */
  mode: "ok" | "reject_handshake" | "server_error" | "bad_request";
}

export function makeReceiver(): Receiver {
  const r: Receiver = {
    notifications: [],
    handshakes: [],
    mode: "ok",
    deliver: async (url, init) => {
      const u = new URL(url);
      const token = u.searchParams.get("validationToken");
      if (token) {
        r.handshakes.push(token);
        if (r.mode === "reject_handshake") return new Response("nope", { status: 200 });
        return new Response(token, { status: 200, headers: { "content-type": "text/plain" } });
      }
      r.notifications.push(JSON.parse(String(init.body ?? "{}")));
      if (r.mode === "server_error") return new Response("", { status: 503 });
      if (r.mode === "bad_request") return new Response("", { status: 400 });
      return new Response("", { status: 202 });
    },
  };
  return r;
}

export function makeAdapter(opts: MockBcServerOptions & { batchFormat?: BatchFormat; connectorInstalled?: boolean; baseUrl?: string } = {}): { server: MockBcServer; adapter: BusinessCentralAdapter; http: BcHttp } {
  const server = new MockBcServer(opts);
  const http = new BcHttp({ baseUrl: opts.baseUrl ?? server.baseUrl, tokenProvider: new StaticTokenProvider(), fetch: server.fetch, timeoutMs: 5_000, ...(opts.batchFormat ? { batchFormat: opts.batchFormat } : {}) });
  const cfg: BcAdapterConfig = { http, companyId: server.companyId, journalTemplate: server.journalTemplate, connectorInstalled: opts.connectorInstalled ?? true };
  const adapter = new BusinessCentralAdapter(cfg);
  return { server, adapter, http };
}

export const GROCERY_DIMS: DimensionSet = { SPEND_CLASS: "ESSENTIAL", FUND_GOAL: "OPERATING", FAMILY_AREA: "JOINT", TAX_TREATMENT: "NONDEDUCT", PROJECT: "HOME-SHOP" };

/** A three-line Walmart split: groceries 30.00, household 12.50, bank 42.50. */
export function walmartSplit(key = idempotencyKey.plaid("acct1", "txn-1"), postingDate = "2026-10-20"): JournalLineInput[] {
  const doc = externalDocumentNo(key, postingDate);
  const base = { postingDate, externalDocumentNumber: doc, comment: key };
  return [
    { ...base, accountType: "G/L Account", accountNumber: "603101", amountCents: 3000, description: "Walmart groceries", dimensionSetLines: toBcDimensionSetLines(GROCERY_DIMS) },
    { ...base, accountType: "G/L Account", accountNumber: "603301", amountCents: 1250, description: "Walmart household", dimensionSetLines: toBcDimensionSetLines({ ...GROCERY_DIMS, SPEND_CLASS: "ESSENTIAL" }) },
    { ...base, accountType: "Bank Account", accountNumber: "CAPONE-CC", amountCents: -4250, description: "WALMART #1234", dimensionSetLines: toBcDimensionSetLines({ FUND_GOAL: "OPERATING", FAMILY_AREA: "JOINT", TAX_TREATMENT: "TAXABLE" }) },
  ];
}
