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
      navigateToLoginRequestUrl: true,
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
    sessionStorage.setItem(SIGNED_IN_AT_KEY, String(Date.now()));
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
  await msal.logoutRedirect({ account: msal.getActiveAccount() ?? undefined });
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
 * Step-up for approvals: a fresh token issued inside the last two minutes whose `amr` carries the MFA/passkey
 * claim. `forceRefresh` asks the tenant for a new token; External ID decides whether to prompt.
 */
export async function getStepUpToken(): Promise<string> {
  const msal = await getMsal();
  const account = msal.getActiveAccount() ?? msal.getAllAccounts()[0];
  if (!account) throw new Error("Not signed in");
  const r = await msal.acquireTokenSilent({ scopes: [config.entra.apiScope], account, forceRefresh: true });
  return r.accessToken;
}
