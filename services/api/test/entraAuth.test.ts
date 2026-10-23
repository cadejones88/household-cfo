import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, createLocalJWKSet } from "jose";
import { jwksUriFromIssuer } from "../src/lib/auth.js";

// The family tenant's discovery document (https://homesteadfamily.ciamlogin.com/<tid>/v2.0/.well-known/openid-configuration,
// read 10/21/2026): the issuer is the tenant-id host, the keys sit beside /v2.0 on the sign-in host.
const TID = "b6393b06-8c32-43bf-abd3-69beb7e0be1c";
const ISSUER = `https://${TID}.ciamlogin.com/${TID}/v2.0`;

describe("Entra External ID token settings", () => {
  it("derives the keys address beside the issuer's /v2.0, not under it", () => {
    expect(jwksUriFromIssuer(ISSUER)).toBe(`https://${TID}.ciamlogin.com/${TID}/discovery/v2.0/keys`);
    expect(jwksUriFromIssuer(`${ISSUER}/`)).toBe(`https://${TID}.ciamlogin.com/${TID}/discovery/v2.0/keys`);
  });

  it("accepts a token the tenant signs in to through homesteadfamily.ciamlogin.com, because its iss names the tenant-id host", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const audience = "e5c87756-2b4d-40bc-9926-a14f143838a4";
    const token = await new SignJWT({ oid: "member-oid", amr: ["pwd", "mfa"] })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: [jwk] }), { issuer: ISSUER, audience });
    expect(payload["oid"]).toBe("member-oid");
    await expect(
      jwtVerify(token, createLocalJWKSet({ keys: [jwk] }), { issuer: `https://homestead.cadejonescpa.com/${TID}/v2.0`, audience }),
    ).rejects.toThrow();
  });
});

describe("step-up (hasFreshStepUp)", () => {
  const now = 1_792_778_400_000;
  const req = (p: { issuedAt?: number; amr?: string[] }) => ({ principal: { memberId: "m", householdId: "h", displayName: "Cade", role: "member" as const, ...p }, headers: {} }) as unknown as import("fastify").FastifyRequest;
  const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  };

  it("External ID (no amr): a fresh token passes only when the tenant's policy requires MFA", async () => {
    const { hasFreshStepUp } = await import("../src/lib/auth.js");
    withEnv({ AUTH_MODE: "entra", ENTRA_MFA_BY_POLICY: "true" }, () => {
      expect(hasFreshStepUp(req({ issuedAt: now / 1000 - 30 }), now)).toBe(true);
      // Entra backdates iat by 300 s: a token issued 12 s ago carries iat 312 s ago (seen on the family tenant).
      expect(hasFreshStepUp(req({ issuedAt: now / 1000 - 312 }), now)).toBe(true);
      expect(hasFreshStepUp(req({ issuedAt: now / 1000 - 421 }), now)).toBe(false); // issued more than 2 minutes ago
      expect(hasFreshStepUp(req({}), now)).toBe(false);
    });
    withEnv({ AUTH_MODE: "entra", ENTRA_MFA_BY_POLICY: undefined }, () => {
      expect(hasFreshStepUp(req({ issuedAt: now / 1000 - 30 }), now)).toBe(false);
    });
  });

  it("a token that does carry amr must name MFA, whatever the policy flag says", async () => {
    const { hasFreshStepUp } = await import("../src/lib/auth.js");
    withEnv({ AUTH_MODE: "entra", ENTRA_MFA_BY_POLICY: "true" }, () => {
      expect(hasFreshStepUp(req({ issuedAt: now / 1000 - 30, amr: ["pwd"] }), now)).toBe(false);
      expect(hasFreshStepUp(req({ issuedAt: now / 1000 - 30, amr: ["pwd", "mfa"] }), now)).toBe(true);
      expect(hasFreshStepUp(req({ issuedAt: now / 1000 - 30, amr: ["fido"] }), now)).toBe(true);
    });
  });
});
