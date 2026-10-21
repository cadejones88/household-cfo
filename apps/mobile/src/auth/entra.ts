/**
 * Entra External ID sign-in: authorization code + PKCE through the system browser (expo-auth-session +
 * expo-web-browser), OpenID discovery from the tenant's issuer, tokens kept in SecureStore, refresh with the
 * refresh token, and re-acquisition after a local step-up.
 *
 * Assumptions about the vendor API (Phase 3 spec, "Identity and sign-in"; sources listed there):
 *  - Discovery: `<issuer>/.well-known/openid-configuration` where the issuer is
 *    https://<tenant>.ciamlogin.com/<tenant>.onmicrosoft.com/v2.0 or https://<custom domain>/<tenant id>/v2.0
 *    (https://learn.microsoft.com/en-us/entra/external-id/customers/concept-authentication-methods-customers).
 *  - Passkeys only work through the system browser, never an embedded web view; that is why promptAsync
 *    (ASWebAuthenticationSession / Custom Tabs) is used
 *    (https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-sign-in-with-passkey).
 *  - Refresh tokens for External ID public clients: 24h by default on single-page apps, 90 days on native
 *    public clients, and the app's own policy caps them at 7 days (REFRESH_WINDOW_MS) and 30 days to the passkey.
 *  - Step-up: the API wants a token issued inside 2 minutes whose `amr` carries mfa/fido/ngcmfa. A refresh-token
 *    grant yields a fresh `iat`; whether `amr` survives refresh in this tenant is to be confirmed with Cade
 *    (README, "Questions"). Until then the fallback is an interactive re-prompt with `prompt=login`.
 */
import { AuthRequest, CodeChallengeMethod, exchangeCodeAsync, fetchDiscoveryAsync, makeRedirectUri, refreshAsync, ResponseType, type DiscoveryDocument, type TokenResponse } from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import type { MemberSummary } from "@homestead/shared";
import { env, entraIssuer } from "../lib/env";

WebBrowser.maybeCompleteAuthSession();

export interface EntraSession {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** ms since epoch */
  expiresAt: number;
  signedInAt: number;
  lastRefreshAt: number;
  member: MemberSummary;
}

let discoveryCache: DiscoveryDocument | undefined;

export async function discovery(): Promise<DiscoveryDocument> {
  if (!discoveryCache) discoveryCache = await fetchDiscoveryAsync(entraIssuer());
  return discoveryCache;
}

export function redirectUri(): string {
  return makeRedirectUri({ scheme: "homestead", path: "auth" });
}

function scopes(): string[] {
  const s = ["openid", "profile", "offline_access"];
  if (env.entraApiScope) s.push(env.entraApiScope);
  return s;
}

export class SignInCancelled extends Error {
  constructor() {
    super("Sign-in cancelled");
    this.name = "SignInCancelled";
  }
}

/** Open the system browser on the tenant's sign-in page (passkey from LastPass), then exchange the code. */
export async function signInWithEntra(opts: { forceLogin?: boolean } = {}): Promise<EntraSession> {
  if (!env.entraClientId) throw new Error("EXPO_PUBLIC_ENTRA_CLIENT_ID is not set");
  const disc = await discovery();
  const request = new AuthRequest({
    clientId: env.entraClientId,
    redirectUri: redirectUri(),
    scopes: scopes(),
    responseType: ResponseType.Code,
    usePKCE: true,
    codeChallengeMethod: CodeChallengeMethod.S256,
    ...(opts.forceLogin ? { extraParams: { prompt: "login" } } : {}),
  });
  const result = await request.promptAsync(disc, { preferEphemeralSession: false });
  if (result.type !== "success") {
    if (result.type === "error") throw new Error(result.error?.message ?? result.errorCode ?? "Sign-in failed");
    throw new SignInCancelled();
  }
  const code = result.params["code"];
  if (!code) throw new Error("Sign-in returned no code");
  const token = await exchangeCodeAsync(
    { clientId: env.entraClientId, code, redirectUri: redirectUri(), scopes: scopes(), extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : {} },
    disc,
  );
  const now = Date.now();
  return sessionFromToken(token, { signedInAt: now, lastRefreshAt: now });
}

/** Exercise the refresh token. Throws when the tenant refuses (the caller signs out). */
export async function refreshEntra(session: EntraSession): Promise<EntraSession> {
  if (!session.refreshToken) throw new Error("No refresh token");
  const disc = await discovery();
  const token = await refreshAsync({ clientId: env.entraClientId, refreshToken: session.refreshToken, scopes: scopes() }, disc);
  return sessionFromToken(token, { signedInAt: session.signedInAt, lastRefreshAt: Date.now(), previous: session });
}

function sessionFromToken(token: TokenResponse, times: { signedInAt: number; lastRefreshAt: number; previous?: EntraSession }): EntraSession {
  const idToken = token.idToken ?? times.previous?.idToken;
  const claims = idToken ? decodeJwt(idToken) : {};
  const member: MemberSummary = times.previous?.member ?? {
    id: str(claims["oid"]) ?? str(claims["sub"]) ?? "",
    displayName: str(claims["name"]) ?? str(claims["given_name"]) ?? "You",
    role: "member",
  };
  const expiresIn = token.expiresIn ?? 3600;
  const refreshToken = token.refreshToken ?? times.previous?.refreshToken;
  return {
    accessToken: token.accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    expiresAt: token.issuedAt * 1000 + expiresIn * 1000,
    signedInAt: times.signedInAt,
    lastRefreshAt: times.lastRefreshAt,
    member,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Decode a JWT payload without verifying it (the API verifies; the app only reads the display name). */
export function decodeJwt(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) return {};
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const json = typeof atob === "function" ? atob(b64) : decodeBase64(b64);
    return JSON.parse(decodeURIComponent(Array.from(json, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeBase64(s: string): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const ch of s) {
    if (ch === "=") break;
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}
