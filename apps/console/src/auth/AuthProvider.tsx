import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { config } from "../config";
// MSAL loads only in Entra mode, so mock and dev builds do not ship it in the first chunk.
const loadMsal = () => import("./msal");

export type AuthStatus = "loading" | "signed_out" | "signed_in" | "error";

export interface AuthState {
  mode: "dev" | "entra" | "mock";
  status: AuthStatus;
  memberName?: string;
  memberId?: string;
  error?: string;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Headers for every API call: Bearer token (entra) or x-dev-member (dev). */
  getAuthHeaders: () => Promise<Record<string, string>>;
  /**
   * Headers for a call that needs step-up (approvals, posting requests, retries, bank logins): in Entra mode a
   * sign-in inside the last `maxAuthAgeMinutes` (default 15; otherwise a sign-in redirect first) and a token issued
   * just now, which the API checks within two minutes; `x-step-up: true` in dev.
   */
  getStepUpHeaders: (maxAuthAgeMinutes?: number) => Promise<Record<string, string>>;
  /** True once after a step-up sign-in brought the person back: the action they started must be repeated. */
  reauthReturned: boolean;
  clearReauthReturned: () => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const mode: AuthState["mode"] = config.apiMode === "mock" ? "mock" : config.authMode;
  const [status, setStatus] = useState<AuthStatus>(mode === "entra" ? "loading" : "signed_in");
  const [memberName, setMemberName] = useState<string | undefined>(mode === "entra" ? undefined : config.devMemberName);
  const [memberId, setMemberId] = useState<string | undefined>(mode === "entra" ? undefined : config.devMemberId);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (mode !== "entra") return;
    let cancelled = false;
    loadMsal()
      .then((msal) => msal.restoreSession())
      .then((account) => {
        if (cancelled) return;
        if (account) {
          setMemberName(account.name ?? account.username);
          setMemberId(account.localAccountId);
          setStatus("signed_in");
        } else setStatus("signed_out");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  // The 12-hour session: check once a minute and sign out when it lapses.
  useEffect(() => {
    if (mode !== "entra" || status !== "signed_in") return;
    const t = setInterval(() => {
      void loadMsal().then((msal) => {
        if (msal.sessionExpired()) void msal.signOut();
      });
    }, 60_000);
    return () => clearInterval(t);
  }, [mode, status]);

  const signIn = useCallback(async () => {
    if (mode === "entra") await (await loadMsal()).signIn();
  }, [mode]);
  const signOut = useCallback(async () => {
    if (mode === "entra") await (await loadMsal()).signOut();
    else window.location.reload();
  }, [mode]);
  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    if (mode === "entra") return { authorization: `Bearer ${await (await loadMsal()).getAccessToken()}` };
    if (mode === "dev") return { "x-dev-member": config.devMemberId };
    return {};
  }, [mode]);
  const getStepUpHeaders = useCallback(async (maxAuthAgeMinutes?: number): Promise<Record<string, string>> => {
    if (mode === "entra") return { authorization: `Bearer ${await (await loadMsal()).getStepUpToken(maxAuthAgeMinutes)}` };
    if (mode === "dev") return { "x-dev-member": config.devMemberId, "x-step-up": "true" };
    return {};
  }, [mode]);

  const [reauthReturned, setReauthReturned] = useState(false);
  useEffect(() => {
    if (mode !== "entra" || status !== "signed_in") return;
    void loadMsal().then((m) => {
      if (sessionStorage.getItem(m.REAUTH_RETURN_KEY)) setReauthReturned(true);
    });
  }, [mode, status]);
  const clearReauthReturned = useCallback(() => {
    setReauthReturned(false);
    void loadMsal().then((m) => sessionStorage.removeItem(m.REAUTH_RETURN_KEY));
  }, []);

  const value = useMemo<AuthState>(
    () => ({ mode, status, memberName, memberId, error, signIn, signOut, getAuthHeaders, getStepUpHeaders, reauthReturned, clearReauthReturned }),
    [mode, status, memberName, memberId, error, signIn, signOut, getAuthHeaders, getStepUpHeaders, reauthReturned, clearReauthReturned],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
