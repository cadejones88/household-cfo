/**
 * Entra External ID sign-in for the Console. Same external tenant as the phone app; the browser does the passkey
 * step on the custom domain (passkeys need the system browser, which a SPA already is). Tokens are kept in
 * sessionStorage so a closed browser means a fresh sign-in, and the Console enforces a 12-hour session on top of
 * whatever token lifetime the tenant issues.
 *
 * Vendor facts (spec Sources): External ID authorities are `https://<tenant>.ciamlogin.com/<tenant id>/` or the
 * custom URL domain; MSAL needs the authority host listed in `knownAuthorities`.
 * https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-sign-in-with-passkey
 */
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo, type AuthenticationResult } from "@azure/msal-browser";
import { config } from "../config";

const SIGNED_IN_AT_KEY = "homestead.console.signedInAt";
/** When the person last signed in interactively (first sign-in or a step-up sign-in). */
const AUTH_AT_KEY = "homestead.console.authAt";
/** Set before a step-up sign-in redirect so the Console can say "repeat what you were doing" on return. */
export const REAUTH_RETURN_KEY = "homestead.console.reauthReturn";

/**
 * A protected action (save a bank connection, remove a login, approve a rule, post or retry) needs a sign-in inside
 * the last 15 minutes; older, and the Console sends the person through sign-in (password and emailed code) first
 * (Cade, 10/23/2026). External ID tokens carry no amr or auth_time, so this presence check lives here, as Face ID
 * does on the phone; the API checks the token is fresh and the tenant's MFA policy (services/api lib/auth.ts).
 */
export const STEP_UP_RECENT_MINUTES = 15;

export function needsReauth(authAt: number, now: number, maxMinutes: number): boolean {
  return !authAt || now - authAt > maxMinutes * 60_000;
}

function lastAuthAt(): number {
  return Number(sessionStorage.getItem(AUTH_AT_KEY) ?? sessionStorage.getItem(SIGNED_IN_AT_KEY) ?? "0");
}

let client: PublicClientApplication | undefined;

export function entraConfigured(): boolean {
  return Boolean(config.entra.clientId && config.entra.authority && config.entra.apiScope);
}

export async function getMsal(): Promise<PublicClientApplication> {
  if (client) return client;
  if (!entraConfigured()) throw new Error("Entra sign-in is not configured (VITE_ENTRA_CLIENT_ID, VITE_ENTRA_AUTHORITY, VITE_ENTRA_API_SCOPE)");
  const knownAuthorities = config.entra.knownAuthority ? [config.entra.knownAuthority] : [new URL(config.entra.authority).host];
  client = new PublicClientApplication({
    auth: {
      clientId: config.entra.clientId,
      authority: config.entra.authority,
      knownAuthorities,
      redirectUri: window.location.origin,
      postLogoutRedirectUri: window.location.origin,
    },
    cache: { cacheLocation: "sessionStorage" },
    system: { allowPlatformBroker: false },
  });
  await client.initialize();
  return client;
}

/** Handles the redirect return once per page load and returns the active account, if any. */
export async function restoreSession(): Promise<AccountInfo | null> {
  const msal = await getMsal();
  const result = await msal.handleRedirectPromise();
  if (result?.account) {
    msal.setActiveAccount(result.account);
    // The 12-hour session runs from the first sign-in; a step-up sign-in only refreshes the recent-sign-in clock.
    if (!sessionStorage.getItem(SIGNED_IN_AT_KEY) || sessionStorage.getItem(REAUTH_RETURN_KEY) === null) sessionStorage.setItem(SIGNED_IN_AT_KEY, String(Date.now()));
    sessionStorage.setItem(AUTH_AT_KEY, String(Date.now()));
    return result.account;
  }
  const account = msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null;
  if (account && sessionExpired()) {
    await signOut();
    return null;
  }
  if (account) msal.setActiveAccount(account);
  return account;
}

export function sessionExpired(now = Date.now()): boolean {
  const at = Number(sessionStorage.getItem(SIGNED_IN_AT_KEY) ?? "0");
  if (!at) return false;
  return now - at > config.sessionHours * 3_600_000;
}

export async function signIn(): Promise<void> {
  const msal = await getMsal();
  await msal.loginRedirect({ scopes: [config.entra.apiScope], prompt: "select_account" });
}

export async function signOut(): Promise<void> {
  const msal = await getMsal();
  sessionStorage.removeItem(SIGNED_IN_AT_KEY);
  sessionStorage.removeItem(AUTH_AT_KEY);
  sessionStorage.removeItem(REAUTH_RETURN_KEY);
  const account = msal.getActiveAccount();
  await msal.logoutRedirect(account ? { account } : {});
}

/** An access token for the API, silently when possible; otherwise redirects to sign in. */
export async function getAccessToken(): Promise<string> {
  const msal = await getMsal();
  if (sessionExpired()) {
    await signOut();
    throw new Error("Session expired");
  }
  const account = msal.getActiveAccount() ?? msal.getAllAccounts()[0];
  if (!account) {
    await signIn();
    throw new Error("Not signed in");
  }
  try {
    const r: AuthenticationResult = await msal.acquireTokenSilent({ scopes: [config.entra.apiScope], account });
    return r.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      await msal.acquireTokenRedirect({ scopes: [config.entra.apiScope], account });
    }
    throw err;
  }
}

/**
 * Step-up for a protected action: a sign-in inside the last `maxAuthAgeMinutes` (otherwise a sign-in redirect now,
 * and the person repeats the action on return), then a token issued just now (`forceRefresh`), which the API
 * requires inside two minutes.
 */
export async function getStepUpToken(maxAuthAgeMinutes = STEP_UP_RECENT_MINUTES): Promise<string> {
  const msal = await getMsal();
  if (sessionExpired()) {
    await signOut();
    throw new Error("Session expired");
  }
  const account = msal.getActiveAccount() ?? msal.getAllAccounts()[0];
  if (!account) throw new Error("Not signed in");
  if (needsReauth(lastAuthAt(), Date.now(), maxAuthAgeMinutes)) {
    sessionStorage.setItem(REAUTH_RETURN_KEY, "1");
    await msal.acquireTokenRedirect({ scopes: [config.entra.apiScope], account, prompt: "login" });
    throw new Error("Signing in again before this change…");
  }
  try {
    const r = await msal.acquireTokenSilent({ scopes: [config.entra.apiScope], account, forceRefresh: true });
    return r.accessToken;
  } catch (err) {
    // The tenant wants the person back (refresh token gone or MFA required again): sign in with the passkey, then
    // the action is repeated by hand.
    if (err instanceof InteractionRequiredAuthError) {
      sessionStorage.setItem(REAUTH_RETURN_KEY, "1");
      await msal.acquireTokenRedirect({ scopes: [config.entra.apiScope], account, prompt: "login" });
    }
    throw err;
  }
}
