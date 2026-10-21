/**
 * The ports the API and jobs use, built once from the environment. External services (BC, Plaid, Azure, Foundry)
 * are unreachable from the dev environment, so every port has an in-memory fake; a real client is wired only when
 * its environment variables name the endpoint and the secret *name* to read. The coordinator wires the real
 * Business Central adapter (packages/ledger-adapter-bc) in place of `InMemoryLedger` once both land.
 *
 * Secrets are read from Key Vault by name (KEY_VAULT_URL + managed identity); nothing here embeds a value.
 */
import { InMemoryNotifier, type NotifierPort } from "./services/alerts.js";
import { FoundryAskModel, TemplateAskModel, type AskModelPort } from "./services/ask/orchestrate.js";
import { FakePlaid, PlaidClient, type PlaidPort } from "./services/bankData/plaid.js";
import { InMemoryLedger, type LedgerPort } from "./services/ledgerPort.js";
import { AzureBlobStore, InMemoryBlobStore, InMemoryQueue, InMemorySecretStore, KeyVaultSecretStore, managedIdentityTokenProvider, type BlobStore, type QueuePort, type SecretStore } from "./services/ports.js";
import { FakeClaudeMapper, FoundryClaudeMapper, type ClaudeMapperPort } from "./services/receipts/claudeMapper.js";
import { AzureDocumentIntelligence, FakeDocumentIntelligence, type DocumentIntelligencePort } from "./services/receipts/documentIntelligence.js";
import { sha256Hex } from "@homestead/shared";
import type { WebhookVerifierPort } from "./routes/webhooks.js";
import { FakeWebhookVerifier } from "./routes/webhooks.js";

export interface Deps {
  ledger: LedgerPort;
  secrets: SecretStore;
  blobs: BlobStore;
  queue: QueuePort;
  plaid: PlaidPort;
  docIntel: DocumentIntelligencePort;
  mapper: ClaudeMapperPort;
  askModel: AskModelPort;
  notifier: NotifierPort;
  plaidWebhookVerifier: WebhookVerifierPort;
  /** Which ports are fakes, for the health page and the README's "what is faked". */
  fakes: string[];
  now: () => Date;
}

export function buildFakeDeps(overrides: Partial<Deps> = {}): Deps {
  const fakes = ["ledger", "secrets", "blobs", "queue", "plaid", "docIntel", "mapper", "askModel", "notifier", "plaidWebhookVerifier"];
  return {
    ledger: new InMemoryLedger(),
    secrets: new InMemorySecretStore(),
    blobs: new InMemoryBlobStore(),
    queue: new InMemoryQueue(),
    plaid: new FakePlaid(),
    docIntel: new FakeDocumentIntelligence((b) => sha256Hex(b)),
    mapper: new FakeClaudeMapper(),
    askModel: new TemplateAskModel(),
    notifier: new InMemoryNotifier(),
    plaidWebhookVerifier: new FakeWebhookVerifier(),
    fakes,
    now: () => new Date(),
    ...overrides,
  };
}

/** Real clients where the environment names them; fakes elsewhere. Never throws for a missing optional service. */
export async function buildDepsFromEnv(): Promise<Deps> {
  const env = process.env;
  const deps = buildFakeDeps();
  const fakes = new Set(deps.fakes);
  const vaultUrl = env["KEY_VAULT_URL"];
  if (vaultUrl) {
    deps.secrets = new KeyVaultSecretStore(vaultUrl, managedIdentityTokenProvider("https://vault.azure.net"));
    fakes.delete("secrets");
  }
  const storage = env["STORAGE_ACCOUNT_URL"];
  if (storage) {
    deps.blobs = new AzureBlobStore(storage, env["BLOB_CONTAINER"] ?? "receipts", managedIdentityTokenProvider("https://storage.azure.com"));
    fakes.delete("blobs");
  }
  const plaidEnv = env["PLAID_ENV"];
  const plaidClientId = env["PLAID_CLIENT_ID"];
  const plaidSecretRef = env["PLAID_SECRET_REF"];
  if (plaidClientId && plaidSecretRef && (plaidEnv === "sandbox" || plaidEnv === "production")) {
    const secret = await deps.secrets.get(plaidSecretRef);
    if (secret) {
      deps.plaid = new PlaidClient(plaidEnv, plaidClientId, secret);
      fakes.delete("plaid");
    }
  }
  const diEndpoint = env["DOCUMENT_INTELLIGENCE_ENDPOINT"];
  if (diEndpoint) {
    const keyRef = env["DOCUMENT_INTELLIGENCE_KEY_REF"];
    const apiKey = keyRef ? await deps.secrets.get(keyRef) : undefined;
    deps.docIntel = new AzureDocumentIntelligence(diEndpoint, apiKey ? { apiKey } : { getToken: managedIdentityTokenProvider("https://cognitiveservices.azure.com") });
    fakes.delete("docIntel");
  }
  const foundry = env["FOUNDRY_ENDPOINT"];
  const foundryModel = env["FOUNDRY_MODEL"];
  const foundryKeyRef = env["FOUNDRY_KEY_REF"];
  if (foundry && foundryModel && foundryKeyRef) {
    const key = await deps.secrets.get(foundryKeyRef);
    if (key) {
      deps.mapper = new FoundryClaudeMapper(foundry, key, foundryModel);
      deps.askModel = new FoundryAskModel(foundry, key, foundryModel);
      fakes.delete("mapper");
      fakes.delete("askModel");
    }
  }
  deps.fakes = [...fakes];
  return deps;
}
