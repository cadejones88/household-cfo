/**
 * Sign-in: Entra External ID issues the tokens; the API validates them against the tenant's JWKS and maps
 * the `oid` claim to a member row. Step-up for approvals is a token issued inside the last 2 minutes that shows
 * multifactor sign-in (see hasFreshStepUp), after the client's own presence check; recorded on the approval.
 *
 * In development with AUTH_MODE=dev, a header `x-dev-member` names a member id and no token is checked.
 */
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { getPool } from "../db/index.js";

export interface Principal {
  memberId: string;
  householdId: string;
  displayName: string;
  role: "member" | "adviser";
  /** When the token was issued; used for the step-up window. */
  issuedAt?: number;
  amr?: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const PUBLIC_PATHS = [/^\/health/, /^\/v1\/webhooks\//];

export const authPlugin = fp(async (app: FastifyInstance) => {
  const mode = process.env["AUTH_MODE"] ?? (process.env["NODE_ENV"] === "production" ? "entra" : "dev");
  const issuer = process.env["ENTRA_ISSUER"];
  const audience = process.env["ENTRA_API_AUDIENCE"];
  const jwksUri = process.env["ENTRA_JWKS_URI"] || (issuer ? jwksUriFromIssuer(issuer) : undefined);
  const jwks = mode === "entra" && jwksUri ? createRemoteJWKSet(new URL(jwksUri)) : undefined;

  app.decorateRequest("principal", undefined);

  app.addHook("onRequest", async (req, reply) => {
    if (PUBLIC_PATHS.some((p) => p.test(req.url))) return;
    const principal = mode === "dev" ? await devPrincipal(req) : await entraPrincipal(req, jwks, issuer, audience);
    if (!principal) {
      await reply.code(401).send({ error: "not_signed_in" });
      return reply;
    }
    req.principal = principal;
  });
});

/**
 * External ID publishes its signing keys at `https://<host>/<tenant id>/discovery/v2.0/keys`, beside the issuer's
 * `/v2.0`, not under it (the tenant's discovery document, checked 10/21/2026). Used when ENTRA_JWKS_URI is unset.
 */
export function jwksUriFromIssuer(issuer: string): string {
  return `${issuer.replace(/\/+$/, "").replace(/\/v2\.0$/, "")}/discovery/v2.0/keys`;
}

async function devPrincipal(req: FastifyRequest): Promise<Principal | undefined> {
  const memberId = req.headers["x-dev-member"];
  if (typeof memberId !== "string") return undefined;
  return lookupMember({ memberId });
}

async function entraPrincipal(req: FastifyRequest, jwks: ReturnType<typeof createRemoteJWKSet> | undefined, issuer?: string, audience?: string): Promise<Principal | undefined> {
  if (!jwks || !issuer || !audience) throw new Error("Entra auth is not configured (ENTRA_ISSUER, ENTRA_API_AUDIENCE)");
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(header.slice(7), jwks, { issuer, audience }));
  } catch {
    return undefined;
  }
  const oid = typeof payload["oid"] === "string" ? payload["oid"] : undefined;
  if (!oid) return undefined;
  const p = await lookupMember({ entraObjectId: oid });
  if (!p) return undefined;
  if (typeof payload.iat === "number") p.issuedAt = payload.iat;
  if (Array.isArray(payload["amr"])) p.amr = payload["amr"] as string[];
  return p;
}

async function lookupMember(by: { memberId?: string; entraObjectId?: string }): Promise<Principal | undefined> {
  // Member lookup happens before the household is known: migration 0002's security-definer function does it.
  const r = await getPool().query<{ id: string; household_id: string; display_name: string; role: "member" | "adviser" }>(
    "select id, household_id, display_name, role from members_lookup_fn($1, $2)",
    [by.memberId ?? null, by.entraObjectId ?? null],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  return { memberId: row.id, householdId: row.household_id, displayName: row.display_name, role: row.role };
}

/**
 * Step-up: a token issued inside the last 2 minutes (or the dev header x-step-up) that shows multifactor sign-in.
 * "Issued" allows for Entra's five-minute backdating of iat (STEP_UP_MAX_IAT_AGE_SECONDS).
 *
 * Where the token carries `amr`, it must name MFA (mfa, fido or ngcmfa). Entra External ID issues no `amr` at all
 * (checked on the family tenant's access and ID tokens, 10/23/2026); there, ENTRA_MFA_BY_POLICY=true says the
 * tenant's Conditional Access policy ("Homestead MFA" on homestead-api) refuses every token to this API without the
 * emailed code, so a valid token is itself proof of MFA. The client adds the presence check before it asks for the
 * token: Face ID on the phone, a sign-in inside the last 15 minutes in the Console (Cade, 10/23/2026).
 */
/**
 * How old `iat` may be on a token issued just now. Entra backdates `iat` and `nbf` by five minutes for clock skew
 * (family tenant, 10/23/2026: tokens MSAL wrote at :51 and :41 past the minute carried iat exactly 300 s earlier,
 * each with a new uti and exp), so "issued inside 2 minutes" reads as iat inside 2 + 5 minutes.
 */
export const STEP_UP_MAX_IAT_AGE_SECONDS = 120 + 300;

export function hasFreshStepUp(req: FastifyRequest, now = Date.now()): boolean {
  if ((process.env["AUTH_MODE"] ?? "dev") === "dev") return req.headers["x-step-up"] === "true";
  const p = req.principal;
  if (!p?.issuedAt) return false;
  const ageSeconds = now / 1000 - p.issuedAt;
  if (ageSeconds > STEP_UP_MAX_IAT_AGE_SECONDS) return false;
  if (p.amr) return p.amr.includes("mfa") || p.amr.includes("fido") || p.amr.includes("ngcmfa");
  return process.env["ENTRA_MFA_BY_POLICY"] === "true";
}
