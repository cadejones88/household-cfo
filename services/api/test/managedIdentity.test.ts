/**
 * Managed identity: the user-assigned identity is chosen by AZURE_CLIENT_ID on both endpoints, tokens are cached
 * until five minutes before expiry, and Postgres signs in with the token as its password when DATABASE_URL is unset.
 */
import { describe, expect, it } from "vitest";
import { fetchManagedIdentityToken, managedIdentityTokenProvider } from "../src/lib/managedIdentity.js";
import { poolConfigFromEnv } from "../src/db/index.js";

function identity(expiresInS = 3600) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return Response.json({ access_token: `tok-${calls.length}`, expires_on: String(Math.floor(Date.now() / 1000) + expiresInS) });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("managed identity tokens", () => {
  it("asks the Container Apps identity endpoint with client_id and the identity header", async () => {
    const { calls, fetchImpl } = identity();
    const t = await fetchManagedIdentityToken("https://vault.azure.net", fetchImpl, { IDENTITY_ENDPOINT: "http://localhost:42356/msi/token", IDENTITY_HEADER: "hdr", AZURE_CLIENT_ID: "11111111-2222-3333-4444-555555555555" });
    expect(t.token).toBe("tok-1");
    expect(calls[0]!.url).toBe("http://localhost:42356/msi/token?resource=https%3A%2F%2Fvault.azure.net&api-version=2019-08-01&client_id=11111111-2222-3333-4444-555555555555");
    expect(calls[0]!.headers["X-IDENTITY-HEADER"]).toBe("hdr");
  });

  it("falls back to IMDS with Metadata: true and client_id", async () => {
    const { calls, fetchImpl } = identity();
    await fetchManagedIdentityToken("https://ossrdbms-aad.database.windows.net", fetchImpl, { AZURE_CLIENT_ID: "abc" });
    expect(calls[0]!.url).toBe("http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fossrdbms-aad.database.windows.net&client_id=abc");
    expect(calls[0]!.headers["Metadata"]).toBe("true");
  });

  it("caches until five minutes before expiry and shares one request between concurrent callers", async () => {
    const { calls, fetchImpl } = identity(3600);
    let now = Date.now();
    const get = managedIdentityTokenProvider("https://storage.azure.com", fetchImpl, () => now);
    const [a, b] = await Promise.all([get(), get()]);
    expect([a, b]).toEqual(["tok-1", "tok-1"]);
    expect(calls).toHaveLength(1);
    now += 54 * 60_000;
    expect(await get()).toBe("tok-1");
    now += 2 * 60_000; // inside the five-minute margin
    expect(await get()).toBe("tok-2");
  });
});

describe("Postgres connection settings", () => {
  it("uses DATABASE_URL when set", () => {
    expect(poolConfigFromEnv({ DATABASE_URL: "postgres://x@localhost/db", PGSSLMODE: "disable" })).toEqual({ connectionString: "postgres://x@localhost/db", max: 10, ssl: false });
  });
  it("signs in with the managed identity's token as the password when only PGHOST/PGUSER/PGDATABASE are set", async () => {
    const asked: string[] = [];
    const cfg = poolConfigFromEnv({ PGHOST: "psql-homestead-dev.postgres.database.azure.com", PGUSER: "homestead-dev-api", PGDATABASE: "homestead" }, (resource) => {
      asked.push(resource);
      return async () => "entra-token";
    });
    expect(cfg).toMatchObject({ host: "psql-homestead-dev.postgres.database.azure.com", user: "homestead-dev-api", database: "homestead", port: 5432, ssl: { rejectUnauthorized: true } });
    expect(asked).toEqual(["https://ossrdbms-aad.database.windows.net"]);
    expect(await (cfg.password as () => Promise<string>)()).toBe("entra-token");
  });
  it("refuses to start with neither", () => {
    expect(() => poolConfigFromEnv({})).toThrow(/DATABASE_URL/);
  });
});
