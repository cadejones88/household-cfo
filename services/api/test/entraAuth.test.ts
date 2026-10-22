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
