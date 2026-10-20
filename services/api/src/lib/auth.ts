/**
 * Sign-in: Entra External ID issues the tokens; the API validates them against the tenant's JWKS and maps
 * the `oid` claim to a member row. Step-up for approvals is a fresh local authentication (Face ID) the app
 * attests with the `acr`/`amr` claims of a token issued inside the last 2 minutes, recorded on the approval.
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
  const jwks = mode === "entra" && issuer ? createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, "")}/discovery/v2.0/keys`)) : undefined;

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

/** Step-up: the token (or the dev header x-step-up) must attest a fresh local authentication inside 2 minutes. */
export function hasFreshStepUp(req: FastifyRequest, now = Date.now()): boolean {
  if ((process.env["AUTH_MODE"] ?? "dev") === "dev") return req.headers["x-step-up"] === "true";
  const p = req.principal;
  if (!p?.issuedAt) return false;
  const ageSeconds = now / 1000 - p.issuedAt;
  return ageSeconds <= 120 && (p.amr?.includes("mfa") || p.amr?.includes("fido") || p.amr?.includes("ngcmfa")) === true;
}
