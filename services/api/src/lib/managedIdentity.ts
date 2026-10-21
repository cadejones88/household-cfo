/**
 * Managed-identity access tokens for Azure resources (Key Vault, Blob Storage, Document Intelligence, Service Bus,
 * and Postgres' Entra sign-in). Tokens are cached until five minutes before they expire; concurrent callers share
 * one request. Nothing here logs a token.
 *
 * Endpoints (docs):
 *  - Container Apps: GET {IDENTITY_ENDPOINT}?resource=<r>&api-version=2019-08-01&client_id=<id> with header
 *    X-IDENTITY-HEADER: {IDENTITY_HEADER}; reply { access_token, expires_on } (seconds since epoch).
 *    https://learn.microsoft.com/en-us/azure/container-apps/managed-identity#rest-endpoint-reference
 *  - Elsewhere on Azure (VM, Container Apps Jobs without the endpoint): IMDS
 *    GET http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=<r>&client_id=<id>
 *    with header Metadata: true.
 *    https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/how-to-use-vm-token
 *  - `client_id` selects the user-assigned identity (the infra templates set AZURE_CLIENT_ID); without it only a
 *    system-assigned identity answers, which the deployment does not have.
 */

export interface AccessToken {
  token: string;
  /** Milliseconds since epoch. */
  expiresAt: number;
}

const REFRESH_MARGIN_MS = 5 * 60_000;

/** One identity-endpoint request for `resource` (no caching). */
export async function fetchManagedIdentityToken(resource: string, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<AccessToken> {
  const clientId = env["AZURE_CLIENT_ID"];
  const endpoint = env["IDENTITY_ENDPOINT"];
  const header = env["IDENTITY_HEADER"];
  let url: string;
  let headers: Record<string, string>;
  if (endpoint && header) {
    url = `${endpoint}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01${clientId ? `&client_id=${encodeURIComponent(clientId)}` : ""}`;
    headers = { "X-IDENTITY-HEADER": header };
  } else {
    url = `http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${encodeURIComponent(resource)}${clientId ? `&client_id=${encodeURIComponent(clientId)}` : ""}`;
    headers = { Metadata: "true" };
  }
  const r = await fetchImpl(url, { headers });
  if (!r.ok) throw new Error(`Managed identity token request failed with ${r.status}`);
  const j = (await r.json()) as { access_token?: string; expires_on?: string | number; expires_in?: string | number };
  if (!j.access_token) throw new Error("Managed identity returned no access token");
  const expiresAt = j.expires_on !== undefined ? Number(j.expires_on) * 1000 : Date.now() + Number(j.expires_in ?? 3600) * 1000;
  return { token: j.access_token, expiresAt };
}

/** A cached token function for one resource: refreshed five minutes before expiry, one request in flight at a time. */
export function managedIdentityTokenProvider(resource: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): () => Promise<string> {
  let cached: AccessToken | undefined;
  let inflight: Promise<AccessToken> | undefined;
  return async () => {
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached.token;
    inflight ??= fetchManagedIdentityToken(resource, fetchImpl).finally(() => {
      inflight = undefined;
    });
    cached = await inflight;
    return cached.token;
  };
}

/** Azure Database for PostgreSQL's Entra resource (the token is the password). */
export const POSTGRES_AAD_RESOURCE = "https://ossrdbms-aad.database.windows.net";
