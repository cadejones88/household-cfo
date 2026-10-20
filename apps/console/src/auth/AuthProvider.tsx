import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { config } from "../config";
import * as msal from "./msal";

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
    msal
      .restoreSession()
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
      if (msal.sessionExpired()) void msal.signOut();
    }, 60_000);
    return () => clearInterval(t);
  }, [mode, status]);

  const signIn = useCallback(async () => {
    if (mode === "entra") await msal.signIn();
  }, [mode]);
  const signOut = useCallback(async () => {
    if (mode === "entra") await msal.signOut();
    else window.location.reload();
  }, [mode]);
  const getAuthHeaders = useCallback(async () => {
    if (mode === "entra") return { authorization: `Bearer ${await msal.getAccessToken()}` };
    if (mode === "dev") return { "x-dev-member": config.devMemberId };
    return {};
  }, [mode]);

  const value = useMemo<AuthState>(
    () => ({ mode, status, memberName, memberId, error, signIn, signOut, getAuthHeaders }),
    [mode, status, memberName, memberId, error, signIn, signOut, getAuthHeaders],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
