/**
 * Which Business Central the acceptance suite runs against.
 *
 *  - "sandbox" when BC_SANDBOX_TENANT_ID, BC_SANDBOX_CLIENT_ID and BC_SANDBOX_CERT_PEM are set: the real adapter
 *    with the certificate credential against CADE_Sandbox_vs25. Steps that need Cade's own BC sign-in (posting
 *    FEEDS/RECEIPTS, a bank reconciliation, BC's own journal entries) are checked in BC, not performed: the sandbox
 *    keeps them between runs and the documents are the same every run (the keys are fixed), so a step Cade did after
 *    one run is found by the next. A step not done yet skips its test with the exact instruction. With
 *    BC_SANDBOX_WAIT_MINUTES the run waits for each step instead (a guided run). A6 also needs a public receiver.
 *  - "mock" otherwise: the adapter's MockBcServer in process (no network), with BC's own actions done through its API.
 *
 * Nothing here can reach production: the sandbox environment name is checked.
 */
import { MockBcServer } from "@homestead/ledger-adapter-bc";
import { addDays } from "@homestead/shared";
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
  /** Cade posts a batch under his own BC sign-in. In the sandbox: done when every listed document has G/L entries. */
  postAsCade(batch: "FEEDS" | "RECEIPTS", docs?: readonly string[]): Promise<void>;
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

const money = (cents: number): string => (cents / 100).toFixed(2);

/** Done in BC already: go on. Otherwise wait BC_SANDBOX_WAIT_MINUTES for it (guided run), then ManualStep. */
async function doneOrManual(env: NodeJS.ProcessEnv, what: string, done: () => Promise<boolean>): Promise<void> {
  if (await done()) return;
  const minutes = Number(env["BC_SANDBOX_WAIT_MINUTES"] ?? "0");
  if (minutes > 0) {
    console.log(`::notice title=Waiting for a step in BC::${what}`);
    const until = Date.now() + minutes * 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20_000));
      if (await done()) return;
    }
  }
  throw new ManualStep(what);
}

export function bcSide(env: NodeJS.ProcessEnv = process.env): BcSide {
  if (sandboxConfigured(env)) {
    const environment = env["BC_SANDBOX_ENVIRONMENT"] ?? "CADE_Sandbox_vs25";
    if (!/sandbox/i.test(environment)) throw new Error(`Refusing to run acceptance against a non-sandbox environment (${environment})`);
    const ledger = createBcLedgerPort({ tenantId: env["BC_SANDBOX_TENANT_ID"]!, environment, companyId: env["BC_SANDBOX_COMPANY_ID"]!, clientId: env["BC_SANDBOX_CLIENT_ID"]!, pem: env["BC_SANDBOX_CERT_PEM"]!, connectorInstalled: (env["BC_SANDBOX_CONNECTOR_INSTALLED"] ?? "true") !== "false" });
    return {
      kind: "sandbox",
      ledger,
      // The sandbox persists between runs, so each of Cade's steps is checked in BC rather than performed: done means
      // the run goes on; not done raises ManualStep with the exact instruction (the run's summary lists them all).
      // With BC_SANDBOX_WAIT_MINUTES set, the run waits that long for the step, checking every 20 seconds, so the
      // steps can also be done live during a guided run.
      postAsCade: (batch, docs = []) =>
        doneOrManual(env, `Post HHAPP/${batch} in BC${docs.length ? ` (it holds ${docs.join(", ")})` : ""}`, async () => {
          if (docs.length === 0) return false;
          for (const d of docs) if ((await ledger.findByExternalDocumentNo(d)).glEntryNos.length === 0) return false;
          return true;
        }),
      reconcile: async (doc) => {
        const entries = await ledger.readBankLedgerEntries({ externalDocumentNo: doc });
        const e = entries[0];
        const which = e ? `the ${e.bankAccountCode} bank ledger entry of ${money(e.amountCents)} dated ${e.postingDate} (External Document No. ${doc})` : `the bank ledger entry of ${doc} (post it first)`;
        const amt = e ? money(e.amountCents) : "its amount";
        return doneOrManual(env, `Reconcile ${which}: Bank Account Reconciliations, New, that bank account, Statement Date 10/31/2026; one statement line (that date, ${amt}); Match Manually with that entry only; Statement Ending Balance = Balance Last Statement + ${amt}; Post`, async () => {
          const now = e ? await ledger.readBankLedgerEntries({ externalDocumentNo: doc }) : [];
          return now.length > 0 && now.every((x) => !x.open);
        });
      },
      // BC-native payments are found by the app the way pairing.ts finds them: same bank card, same amount, within
      // five days, not a Homestead document. Any document number BC assigns will do.
      nativePayment: (bankCode, date, amountCents, documentNo, liabilityGl = "271101") =>
        doneOrManual(
          env,
          `Post one line in General Journals, batch TEST (template GENERAL), not in HHAPP: Posting Date ${date}, Account Type Bank Account, Account No. ${bankCode}, Description "PennyMac payment (acceptance ${documentNo})", Amount ${money(amountCents)}, Bal. Account Type G/L Account, Bal. Account No. ${liabilityGl}`,
          async () =>
            (await ledger.readBankLedgerEntries({ bankAccountCode: bankCode, postingDateFrom: addDays(date, -5), postingDateTo: addDays(date, 5) })).some(
              (x) => !x.reversed && x.amountCents === amountCents && !x.externalDocumentNo?.startsWith("HHAPP-"),
            ),
        ),
      // A set-aside is an earmark inside the savings balance: FUND_GOAL moves from OPERATING to the goal on the same
      // bank card, so the card's balance (and its reconciliation to the statement) does not change.
      goalDeposit: (bankCode, _date, amountCents, fundGoal) =>
        doneOrManual(
          env,
          `Post two lines in General Journals, batch TEST (template GENERAL), not in HHAPP, Posting Date today, both Account Type Bank Account, Account No. ${bankCode}, Description "Set aside ${fundGoal} (acceptance A7)": Amount ${money(amountCents)} with FUND_GOAL Code ${fundGoal}; Amount ${money(-amountCents)} with FUND_GOAL Code OPERATING`,
          async () => (await ledger.readGlEntriesByExternalDocNo({ accountNoPrefix: "10" })).some((e) => e.amountCents === amountCents && e.dimensions.some((d) => d.code === "FUND_GOAL" && d.valueCode === fundGoal)),
        ),
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
  // The HH App Connector's posting guard (1.0.0.4): the app's token may post HHAPP/AUTOPOST only; "cade" is Cade in BC.
  const server = new MockBcServer({ deliver: (url, init) => receiver(url, init), budgets: ["BUD26-REV"], postGuard: { personTokens: ["cade"] } });
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
      // The earmark Cade posts in the sandbox: FUND_GOAL moves from OPERATING to the goal on the same bank card.
      const lines = [
        { accountType: "Bank Account", accountNumber: bankCode, amount: amountCents / 100, dimensionSetLines: [{ code: "FUND_GOAL", valueCode: fundGoal }] },
        { accountType: "Bank Account", accountNumber: bankCode, amount: -amountCents / 100, dimensionSetLines: [{ code: "FUND_GOAL", valueCode: "OPERATING" }] },
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
    subscriptionCount: async (ids) => server.listSubscriptions().filter((s) => !ids || ids.includes(s.subscriptionId)).length,
    setReceiver: (d) => {
      receiver = d;
    },
  };
}
