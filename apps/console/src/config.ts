/**
 * Runtime configuration for the Console. Everything here is public (the Console is a static site);
 * no secret is ever read on this side. Values come from Vite's `VITE_*` environment at build time.
 */

export type ApiMode = "http" | "mock";
export type AuthMode = "dev" | "entra";

function env(name: string, fallback = ""): string {
  const v = (import.meta.env as Record<string, string | undefined>)[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  apiMode: (env("VITE_API_MODE", "http") as ApiMode) === "mock" ? "mock" : ("http" as ApiMode),
  apiBaseUrl: env("VITE_API_BASE_URL", "http://localhost:8080").replace(/\/$/, ""),
  authMode: (env("VITE_AUTH_MODE", "dev") as AuthMode) === "entra" ? "entra" : ("dev" as AuthMode),
  devMemberId: env("VITE_DEV_MEMBER_ID", "00000000-0000-0000-0000-000000000001"),
  devMemberName: env("VITE_DEV_MEMBER_NAME", "Cade"),
  entra: {
    clientId: env("VITE_ENTRA_CLIENT_ID"),
    authority: env("VITE_ENTRA_AUTHORITY"),
    knownAuthority: env("VITE_ENTRA_KNOWN_AUTHORITY"),
    apiScope: env("VITE_ENTRA_API_SCOPE"),
  },
  /** Console sessions expire after 12 hours (spec: Security model, Console row). */
  sessionHours: Number(env("VITE_SESSION_HOURS", "12")) || 12,
  bc: {
    tenant: env("VITE_BC_TENANT", "<tenant>"),
    environment: env("VITE_BC_ENVIRONMENT", "CADE_Sandbox_vs25"),
    company: env("VITE_BC_COMPANY", "<company>"),
    journalTemplate: env("VITE_BC_JOURNAL_TEMPLATE", "HHAPP"),
    /**
     * Deep link into the BC general journal filtered to the app's template. Page 39 is General Journal.
     * Tokens: {tenant} {environment} {company} {template} {batch}. Kept here so the URL shape lives in config.
     */
    journalUrlTemplate:
      "https://businesscentral.dynamics.com/{tenant}/{environment}?company={company}&page=39&filter='Gen. Journal Line'.'Journal Template Name' IS '{template}'",
    journalBatchUrlTemplate:
      "https://businesscentral.dynamics.com/{tenant}/{environment}?company={company}&page=39&filter='Gen. Journal Line'.'Journal Template Name' IS '{template}' AND 'Gen. Journal Line'.'Journal Batch Name' IS '{batch}'",
    /** General Ledger Entries (page 20) filtered by External Document No. */
    glEntryUrlTemplate:
      "https://businesscentral.dynamics.com/{tenant}/{environment}?company={company}&page=20&filter='G/L Entry'.'External Document No.' IS '{docNo}'",
    /** Bank Account Ledger Entries (page 372) for one bank card. */
    bankLedgerUrlTemplate:
      "https://businesscentral.dynamics.com/{tenant}/{environment}?company={company}&page=372&filter='Bank Account Ledger Entry'.'Bank Account No.' IS '{bankCard}'",
  },
  /** Where the nightly acceptance job writes its result (served next to the app). */
  healthReportPath: "/health.json",
  timeZone: "America/Boise",
} as const;
