/**
 * Deep links into Business Central. No credential travels with them: BC asks for Cade's own sign-in.
 * Templates live in config.ts so the URL shape can change without touching a screen.
 */
import { config } from "../config";

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(vars[k] ?? `<${k}>`));
}

const base = () => ({
  tenant: config.bc.tenant,
  environment: config.bc.environment,
  company: config.bc.company,
  template: config.bc.journalTemplate,
});

export function bcJournalUrl(): string {
  return fill(config.bc.journalUrlTemplate, base());
}

export function bcJournalBatchUrl(batch: string): string {
  return fill(config.bc.journalBatchUrlTemplate, { ...base(), batch });
}

export function bcGlEntryUrl(externalDocumentNo: string): string {
  return fill(config.bc.glEntryUrlTemplate, { ...base(), docNo: externalDocumentNo });
}

export function bcBankLedgerUrl(bankCard: string): string {
  return fill(config.bc.bankLedgerUrlTemplate, { ...base(), bankCard });
}

/** True when the link would still contain a placeholder (config not filled in yet). */
export function bcLinksConfigured(): boolean {
  return !config.bc.tenant.startsWith("<") && !config.bc.company.startsWith("<");
}
