/**
 * Setup needs only the company's name: resolveCompanyId signs in with the certificate and finds the id in
 * GET api/v2.0/companies by name or display name.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveCompanyId } from "../src/services/ledgerPortBc.js";

function testPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  // The credential only hashes the certificate bytes for the x5t header; any DER-shaped bytes will do here.
  const der = randomBytes(64);
  const certBlock = `-----BEGIN CERTIFICATE-----\n${der.toString("base64")}\n-----END CERTIFICATE-----\n`;
  return `${keyPem}${certBlock}`;
}

function fakeFetch(companies: { id: string; name: string; displayName: string }[]) {
  const seen: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600, token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/v2.0/companies")) return new Response(JSON.stringify({ value: companies }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, seen };
}

const base = { tenantId: "tenant-1", environment: "CADE_Sandbox_vs25", clientId: "client-1", pem: testPem() };

describe("resolveCompanyId", () => {
  it("finds the household company by name, ignoring case and spaces", async () => {
    const { f, seen } = fakeFetch([
      { id: "c-cronus", name: "CRONUS USA, Inc.", displayName: "CRONUS USA, Inc." },
      { id: "c-family", name: "Cade & Vanessa Jones Family", displayName: "Cade & Vanessa Jones Family" },
    ]);
    expect(await resolveCompanyId({ ...base, fetch: f, companyName: "  cade & vanessa jones family " })).toBe("c-family");
    expect(seen.some((u) => u === "https://api.businesscentral.dynamics.com/v2.0/tenant-1/CADE_Sandbox_vs25/api/v2.0/companies")).toBe(true);
  });

  it("says which companies exist when the name is not found", async () => {
    const { f } = fakeFetch([{ id: "c-cronus", name: "CRONUS USA, Inc.", displayName: "CRONUS USA, Inc." }]);
    await expect(resolveCompanyId({ ...base, fetch: f, companyName: "Cade & Vanessa Jones Family" })).rejects.toThrow(/No company named .* found: CRONUS USA, Inc\./);
  });
});
