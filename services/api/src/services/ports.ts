/**
 * Small infrastructure ports with in-memory fakes: secrets, blobs and the work queue.
 * The database holds only the *name* of a secret; the value lives in Key Vault (cloud) or memory (tests).
 */
import { randomUUID } from "node:crypto";

// Secrets --------------------------------------------------------------------------------------

export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(name: string): Promise<string | undefined> {
    return this.values.get(name);
  }
  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }
  async delete(name: string): Promise<void> {
    this.values.delete(name);
  }
}

/**
 * Azure Key Vault secrets over REST, authenticated by a bearer token from the managed identity.
 * Assumption (doc: https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/get-secret/get-secret):
 *   GET  {vaultUrl}/secrets/{name}?api-version=7.4           -> { value }
 *   PUT  {vaultUrl}/secrets/{name}?api-version=7.4  { value } -> { value }
 *   DELETE {vaultUrl}/secrets/{name}?api-version=7.4
 * The token comes from the managed identity endpoint (IDENTITY_ENDPOINT / IDENTITY_HEADER on Container Apps,
 * doc: https://learn.microsoft.com/en-us/azure/container-apps/managed-identity) for resource https://vault.azure.net.
 */
export class KeyVaultSecretStore implements SecretStore {
  constructor(
    private readonly vaultUrl: string,
    private readonly getToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private async call(method: string, name: string, body?: unknown): Promise<Response> {
    const token = await this.getToken();
    const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return this.fetchImpl(`${this.vaultUrl.replace(/\/$/, "")}/secrets/${encodeURIComponent(name)}?api-version=7.4`, init);
  }
  async get(name: string): Promise<string | undefined> {
    const r = await this.call("GET", name);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`Key Vault GET ${name} failed with ${r.status}`);
    const j = (await r.json()) as { value?: string };
    return j.value;
  }
  async set(name: string, value: string): Promise<void> {
    const r = await this.call("PUT", name, { value });
    if (!r.ok) throw new Error(`Key Vault PUT ${name} failed with ${r.status}`);
  }
  async delete(name: string): Promise<void> {
    const r = await this.call("DELETE", name);
    if (!r.ok && r.status !== 404) throw new Error(`Key Vault DELETE ${name} failed with ${r.status}`);
  }
}

/** Managed-identity token for Container Apps (IDENTITY_ENDPOINT + IDENTITY_HEADER). */
export function managedIdentityTokenProvider(resource: string, fetchImpl: typeof fetch = fetch): () => Promise<string> {
  return async () => {
    const endpoint = process.env["IDENTITY_ENDPOINT"];
    const header = process.env["IDENTITY_HEADER"];
    if (!endpoint || !header) throw new Error("Managed identity endpoint is not available");
    const url = `${endpoint}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01`;
    const r = await fetchImpl(url, { headers: { "X-IDENTITY-HEADER": header } });
    if (!r.ok) throw new Error(`Managed identity token request failed with ${r.status}`);
    const j = (await r.json()) as { access_token: string };
    return j.access_token;
  };
}

// Blobs ----------------------------------------------------------------------------------------

export interface BlobStore {
  put(ref: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(ref: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined>;
  /** A short-lived read URL for the phone (5 minutes per the spec). */
  sasUrl(ref: string, minutes: number): Promise<string>;
}

export class InMemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(ref: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.blobs.set(ref, { bytes, contentType });
  }
  async get(ref: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    return this.blobs.get(ref);
  }
  async sasUrl(ref: string, minutes: number): Promise<string> {
    return `memory://${ref}?expires=${minutes}m`;
  }
}

/**
 * Azure Blob Storage over REST with a managed-identity bearer token.
 * Assumption (doc: https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob):
 *   PUT {account}.blob.core.windows.net/{container}/{path} with x-ms-blob-type: BlockBlob, x-ms-version: 2024-11-04.
 * SAS URLs for the phone need a user delegation key (doc: https://learn.microsoft.com/en-us/rest/api/storageservices/get-user-delegation-key)
 * and HMAC signing; that is left to the cloud build and throws here so nothing pretends to work.
 */
export class AzureBlobStore implements BlobStore {
  constructor(
    private readonly accountUrl: string,
    private readonly container: string,
    private readonly getToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private url(ref: string): string {
    return `${this.accountUrl.replace(/\/$/, "")}/${this.container}/${ref}`;
  }
  async put(ref: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const token = await this.getToken();
    const r = await this.fetchImpl(this.url(ref), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "x-ms-blob-type": "BlockBlob", "x-ms-version": "2024-11-04", "content-type": contentType },
      body: bytes,
    });
    if (!r.ok) throw new Error(`Blob PUT failed with ${r.status}`);
  }
  async get(ref: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    const token = await this.getToken();
    const r = await this.fetchImpl(this.url(ref), { headers: { authorization: `Bearer ${token}`, "x-ms-version": "2024-11-04" } });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`Blob GET failed with ${r.status}`);
    return { bytes: new Uint8Array(await r.arrayBuffer()), contentType: r.headers.get("content-type") ?? "application/octet-stream" };
  }
  async sasUrl(): Promise<string> {
    throw new Error("SAS generation needs a user delegation key; not available in this build");
  }
}

// Queue ----------------------------------------------------------------------------------------

export interface QueueMessage {
  id: string;
  topic: string;
  body: Record<string, unknown>;
  enqueuedAt: string;
}

/** Service Bus later; in-process now. The outbox table is the source of truth, the queue only carries pointers. */
export interface QueuePort {
  publish(topic: string, body: Record<string, unknown>): Promise<string>;
  /** Pull up to `max` messages for a consumer; the caller completes them. */
  receive(topic: string, max: number): Promise<QueueMessage[]>;
  complete(message: QueueMessage): Promise<void>;
  deadLetter(message: QueueMessage, reason: string): Promise<void>;
}

export class InMemoryQueue implements QueuePort {
  readonly topics = new Map<string, QueueMessage[]>();
  readonly deadLetters: { message: QueueMessage; reason: string }[] = [];
  async publish(topic: string, body: Record<string, unknown>): Promise<string> {
    const m: QueueMessage = { id: randomUUID(), topic, body, enqueuedAt: new Date().toISOString() };
    const list = this.topics.get(topic) ?? [];
    list.push(m);
    this.topics.set(topic, list);
    return m.id;
  }
  async receive(topic: string, max: number): Promise<QueueMessage[]> {
    const list = this.topics.get(topic) ?? [];
    return list.slice(0, max);
  }
  async complete(message: QueueMessage): Promise<void> {
    const list = this.topics.get(message.topic) ?? [];
    this.topics.set(
      message.topic,
      list.filter((m) => m.id !== message.id),
    );
  }
  async deadLetter(message: QueueMessage, reason: string): Promise<void> {
    await this.complete(message);
    this.deadLetters.push({ message, reason });
  }
  depth(topic: string): number {
    return (this.topics.get(topic) ?? []).length;
  }
}
