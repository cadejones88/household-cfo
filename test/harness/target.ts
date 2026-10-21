/**
 * Which Business Central the acceptance suite runs against.
 *
 *  - "sandbox" when BC_SANDBOX_TENANT_ID, BC_SANDBOX_COMPANY_ID, BC_SANDBOX_CLIENT_ID and BC_SANDBOX_CERT_PEM are set:
 *    the real adapter with the certificate credential against CADE_Sandbox_vs25. Steps that need Cade's own BC
 *    sign-in (posting FEEDS/RECEIPTS, bank reconciliation) are manual there and the tests that need them are skipped
 *    with that reason; webhooks need a public receiver, so A6 relies on the poll alone.
 *  - "mock" otherwise: the adapter's MockBcServer in process (no network), with BC's own actions done through its API.
 *
 * Nothing here can reach production: the sandbox environment name is checked.
 */
import { MockBcServer } from "@homestead/ledger-adapter-bc";
import { bcLedgerPortForMock, createBcLedgerPort, resolveCompanyId, type LedgerPort } from "@homestead/api";

export class ManualStep extends Error {
  constructor(what: string) {
    super(`Manual in the sandbox: ${what}`);
    this.name = "ManualStep";
  }
}

export interface BcSide {
  kind: "mock" | "sandbox";
  ledger: LedgerPort;
  /** Cade posts a batch under his own BC sign-in. */
  postAsCade(batch: "FEEDS" | "RECEIPTS"): Promise<void>;
  /** BC's bank reconciliation closes the bank ledger entry of a document. */
  reconcile(externalDocumentNo: string, statementNo: string, closedAt: string): Promise<void>;
  /** A BC-native recurring-journal payment on a bank card (PennyMac, Frontier). */
  nativePayment(bankCode: string, date: string, amountCents: number, documentNo: string, liabilityGl?: string): Promise<void>;
  /** Money set aside under a FUND_GOAL on a savings card, posted by BC's own journal (goals and A7). */
  goalDeposit(bankCode: string, date: string, amountCents: number, fundGoal: string): Promise<void>;
  /**
   * Delete the given webhook subscriptions (A6's outage). Only the ones this run's household registered: in the
   * sandbox the same app registration may also serve the pilot, whose live subscriptions must survive the test.
   */
  dropSubscriptions(ids: readonly string[]): Promise<void>;
  /** How many of the given subscriptions BC still holds (all of them when `ids` is omitted, mock only). */
  subscriptionCount(ids?: readonly string[]): Promise<number>;
  /** Route BC's webhook calls (handshake and notifications) to a receiver. */
  setReceiver(deliver: (url: string, init: RequestInit) => Promise<Response>): void;
  server?: MockBcServer;
}

export function sandboxConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env["BC_SANDBOX_TENANT_ID"] && env["BC_SANDBOX_CLIENT_ID"] && env["BC_SANDBOX_CERT_PEM"]);
}

/** The household company in the sandbox. */
export const DEFAULT_SANDBOX_COMPANY_NAME = "Cade & Vanessa Jones Family";

/**
 * Before the sandbox run: when BC_SANDBOX_COMPANY_ID is not set, find it from the company's name
 * (BC_SANDBOX_COMPANY_NAME, default the household company) and print it, so setup never needs the GUID.
 */
export async function prepareSandboxEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!sandboxConfigured(env) || env["BC_SANDBOX_COMPANY_ID"]) return;
  const environment = env["BC_SANDBOX_ENVIRONMENT"] ?? "CADE_Sandbox_vs25";
  if (!/sandbox/i.test(environment)) throw new Error(`Refusing to run acceptance against a non-sandbox environment (${environment})`);
  const companyName = env["BC_SANDBOX_COMPANY_NAME"] ?? DEFAULT_SANDBOX_COMPANY_NAME;
  const id = await resolveCompanyId({ tenantId: env["BC_SANDBOX_TENANT_ID"]!, environment, clientId: env["BC_SANDBOX_CLIENT_ID"]!, pem: env["BC_SANDBOX_CERT_PEM"]!, companyName });
  env["BC_SANDBOX_COMPANY_ID"] = id;
  console.log(`BC sandbox company "${companyName}" has id ${id} (not a secret; use it as HOMESTEAD_BC_COMPANY_ID for the dev deployment).`);
}

export function bcSide(env: NodeJS.ProcessEnv = process.env): BcSide {
  if (sandboxConfigured(env)) {
    const environment = env["BC_SANDBOX_ENVIRONMENT"] ?? "CADE_Sandbox_vs25";
    if (!/sandbox/i.test(environment)) throw new Error(`Refusing to run acceptance against a non-sandbox environment (${environment})`);
    const ledger = createBcLedgerPort({ tenantId: env["BC_SANDBOX_TENANT_ID"]!, environment, companyId: env["BC_SANDBOX_COMPANY_ID"]!, clientId: env["BC_SANDBOX_CLIENT_ID"]!, pem: env["BC_SANDBOX_CERT_PEM"]!, connectorInstalled: (env["BC_SANDBOX_CONNECTOR_INSTALLED"] ?? "true") !== "false" });
    return {
      kind: "sandbox",
      ledger,
      postAsCade: async () => {
        throw new ManualStep("Cade posts HHAPP/FEEDS or HHAPP/RECEIPTS in BC");
      },
      reconcile: async () => {
        throw new ManualStep("bank reconciliation in BC");
      },
      nativePayment: async () => {
        throw new ManualStep("a recurring-journal payment posted in BC");
      },
      goalDeposit: async () => {
        throw new ManualStep("a FUND_GOAL deposit posted in BC");
      },
      dropSubscriptions: async (ids) => {
        for (const id of ids) await ledger.deleteWebhookSubscription(id);
      },
      subscriptionCount: async (ids) => {
        const listed = (await ledger.listWebhookSubscriptions?.()) ?? [];
        return ids ? listed.filter((s) => ids.includes(s.subscriptionId)).length : listed.length;
      },
      setReceiver: () => undefined,
    };
  }
  let receiver: (url: string, init: RequestInit) => Promise<Response> = async (url) => new Response(new URL(url).searchParams.get("validationToken") ?? "", { status: 200 });
  const server = new MockBcServer({ deliver: (url, init) => receiver(url, init), budgets: ["BUD26-REV"] });
  const call = (method: string, path: string, body?: unknown) =>
    server.fetch(`${server.baseUrl}/api/v2.0/companies(${server.companyId})/${path}`, { method, headers: { authorization: "Bearer cade", "content-type": "application/json", "if-match": "*" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return {
    kind: "mock",
    server,
    ledger: bcLedgerPortForMock(server),
    postAsCade: async (batch) => {
      const r = await call("POST", `journals(${server.journalId(batch)})/Microsoft.NAV.post`);
      if (r.status !== 204) throw new Error(`post ${batch} answered ${r.status}`);
    },
    reconcile: async (doc, statementNo, closedAt) => {
      const e = server.bankLedgerEntries().find((x) => x.externalDocumentNo === doc);
      if (!e) throw new Error(`no bank ledger entry for ${doc}`);
      server.closeBankLedgerEntry(e.entryNo, statementNo, 1, closedAt);
    },
    nativePayment: async (bankCode, date, amountCents, documentNo, liabilityGl = "271101") => {
      // BC's own recurring journal (GENERAL template, not HHAPP): bank card Cr, mortgage liability Dr.
      const jid = server.journalId("DEFAULT", "GENERAL");
      for (const [accountType, accountNumber, amount] of [["Bank Account", bankCode, amountCents / 100], ["G/L Account", liabilityGl, -amountCents / 100]] as const) {
        const r = await call("POST", `journals(${jid})/journalLines`, { accountType, accountNumber, postingDate: date, amount, description: `Recurring ${documentNo}`, externalDocumentNumber: documentNo });
        if (r.status !== 201) throw new Error(`recurring journal line answered ${r.status}: ${await r.text()}`);
      }
      const p = await call("POST", `journals(${jid})/Microsoft.NAV.post`);
      if (p.status !== 204) throw new Error(`recurring post answered ${p.status}`);
    },
    goalDeposit: async (bankCode, date, amountCents, fundGoal) => {
      const jid = server.journalId("DEFAULT", "GENERAL");
      const lines = [
        { accountType: "Bank Account", accountNumber: bankCode, amount: amountCents / 100, dimensionSetLines: [{ code: "FUND_GOAL", valueCode: fundGoal }] },
        // 115101 carries SPEND_CLASS TRANSFER as a default dimension, which BC applies on insert.
        { accountType: "G/L Account", accountNumber: "115101", amount: -amountCents / 100, dimensionSetLines: [] },
      ];
      for (const l of lines) {
        const r = await call("POST", `journals(${jid})/journalLines`, { ...l, postingDate: date, description: `Set aside ${fundGoal}`, externalDocumentNumber: `GOAL-${fundGoal}` });
        if (r.status !== 201) throw new Error(`goal line answered ${r.status}: ${await r.text()}`);
      }
      const p = await call("POST", `journals(${jid})/Microsoft.NAV.post`);
      if (p.status !== 204) throw new Error(`goal post answered ${p.status}`);
    },
    dropSubscriptions: async (ids) => {
      for (const id of ids) await server.fetch(`${server.baseUrl}/api/v2.0/subscriptions('${id}')`, { method: "DELETE", headers: { authorization: "Bearer cade", "if-match": "*" } });
    },
    subscriptionCount: async (ids) => server.listSubscriptions().filter((s) => !ids || ids.includes(s.id)).length,
    setReceiver: (d) => {
      receiver = d;
    },
  };
}
