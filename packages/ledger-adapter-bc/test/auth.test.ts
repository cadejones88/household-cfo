import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { ASSERTION_LIFETIME_S, BC_SCOPE, CLIENT_ASSERTION_TYPE, CertificateCredential, TOKEN_REFRESH_MARGIN_MS, parsePemBundle } from "../src/auth.js";
import { LedgerAdapterError } from "../src/errors.js";

/** A throwaway RSA key and a stand-in certificate block (random DER; the thumbprints only need bytes). */
function testPem(): { pem: string; publicKeyPem: string; der: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const der = randomBytes(300);
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  const certBlock = `-----BEGIN ${"CERTIFICATE"}-----\n${b64}\n-----END ${"CERTIFICATE"}-----\n`;
  return { pem: `${keyPem}${certBlock}`, publicKeyPem, der };
}

const TENANT = "0f3f0f3f-aaaa-bbbb-cccc-000000000001";
const CLIENT = "cafecafe-1111-2222-3333-000000000002";

describe("parsePemBundle", () => {
  it("computes x5t (SHA-1) and x5t#S256 of the certificate DER", () => {
    const { pem, der } = testPem();
    const b = parsePemBundle(pem);
    expect(b.certificateDer.equals(der)).toBe(true);
    expect(b.x5t).toBe(createHash("sha1").update(der).digest("base64url"));
    expect(b.x5tS256).toBe(createHash("sha256").update(der).digest("base64url"));
    expect(b.privateKey.asymmetricKeyType).toBe("rsa");
  });

  it("refuses a bundle without both blocks, without leaking it", () => {
    expect(() => parsePemBundle("not a pem")).toThrow(LedgerAdapterError);
    const { pem } = testPem();
    const keyOnly = pem.slice(0, pem.indexOf("-----BEGIN CERT"));
    try {
      parsePemBundle(keyOnly);
      expect.fail("should throw");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("BEGIN");
    }
  });
});

describe("CertificateCredential (client-credentials with a certificate)", () => {
  it("posts the documented form fields with a signed RS256 assertion carrying both thumbprint headers", async () => {
    const { pem, publicKeyPem, der } = testPem();
    const calls: { url: string; body: URLSearchParams; headers: Record<string, string> }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ token_type: "Bearer", expires_in: 3599, access_token: "tok-1" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    let now = Date.parse("2026-10-20T15:00:00Z");
    const cred = new CertificateCredential({ tenantId: TENANT, clientId: CLIENT, pem, fetch: fetchImpl, now: () => now });

    expect(await cred.getToken()).toBe("tok-1");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.body.get("grant_type")).toBe("client_credentials");
    expect(call.body.get("client_id")).toBe(CLIENT);
    expect(call.body.get("scope")).toBe(BC_SCOPE);
    expect(call.body.get("client_assertion_type")).toBe(CLIENT_ASSERTION_TYPE);
    const assertion = call.body.get("client_assertion") ?? "";

    const header = decodeProtectedHeader(assertion);
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    expect(header.x5t).toBe(createHash("sha1").update(der).digest("base64url"));
    expect(header["x5t#S256"]).toBe(createHash("sha256").update(der).digest("base64url"));

    const { payload } = await jwtVerify(assertion, await importSPKI(publicKeyPem, "RS256"), { audience: cred.tokenEndpoint, issuer: CLIENT, subject: CLIENT, currentDate: new Date(now) });
    expect(typeof payload.jti).toBe("string");
    expect(payload.nbf).toBe(Math.floor(now / 1000));
    expect(payload.iat).toBe(Math.floor(now / 1000));
    expect(payload.exp).toBe(Math.floor(now / 1000) + ASSERTION_LIFETIME_S);
    expect(ASSERTION_LIFETIME_S).toBeLessThanOrEqual(600);

    // Cached until five minutes before expiry; refreshed after; invalidate() forces a new request.
    now += 10 * 60_000;
    expect(await cred.getToken()).toBe("tok-1");
    expect(calls).toHaveLength(1);
    now += 3599 * 1000 - 10 * 60_000 - TOKEN_REFRESH_MARGIN_MS + 1000;
    await cred.getToken();
    expect(calls).toHaveLength(2);
    cred.invalidate();
    await cred.getToken();
    expect(calls).toHaveLength(3);
  });

  it("can sign with PS256 when Entra is configured for it", async () => {
    const { pem } = testPem();
    const cred = new CertificateCredential({ tenantId: TENANT, clientId: CLIENT, pem, assertionAlgorithm: "PS256" });
    const header = decodeProtectedHeader(await cred.buildClientAssertion());
    expect(header.alg).toBe("PS256");
    expect(header["x5t#S256"]).toBeTypeOf("string");
  });

  it("coalesces concurrent refreshes into one request", async () => {
    const { pem } = testPem();
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ access_token: `tok-${n}`, expires_in: 3600 }), { status: 200 });
    };
    const cred = new CertificateCredential({ tenantId: TENANT, clientId: CLIENT, pem, fetch: fetchImpl });
    const tokens = await Promise.all([cred.getToken(), cred.getToken(), cred.getToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(n).toBe(1);
  });

  it("surfaces an Entra refusal with the AADSTS text but never the assertion or the PEM", async () => {
    const { pem } = testPem();
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: "invalid_client", error_description: "AADSTS700027: Client assertion contains an invalid signature." }), { status: 401 });
    const cred = new CertificateCredential({ tenantId: TENANT, clientId: CLIENT, pem, fetch: fetchImpl });
    await expect(cred.getToken()).rejects.toThrow(/AADSTS700027/);
    await expect(cred.getToken()).rejects.not.toThrow(/PRIVATE KEY|eyJ/);
  });
});
