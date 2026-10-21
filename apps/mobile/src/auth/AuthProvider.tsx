/**
 * Who is signed in, how the API is told, and the two local gates: Face ID on open (7-day refresh window,
 * passkey again after 30 days) and step-up (fresh Face ID inside 2 minutes) before approvals, rules,
 * settings and export.
 *
 * Modes (EXPO_PUBLIC_AUTH_MODE):
 *   dev   — pick a member from the seed; the API gets `x-dev-member` and, after a fresh step-up, `x-step-up: true`.
 *   entra — Entra External ID code + PKCE through the system browser; tokens in SecureStore; refresh; after a
 *           local step-up the token is re-acquired so its `iat` is fresh for the API's 2-minute check.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { AppState } from "react-native";
import type { MemberSummary } from "@homestead/shared";
import type { AuthHeaderSource } from "../api/client";
import { env } from "../lib/env";
import { authenticateLocally, biometricInfo, type BiometricInfo } from "./localAuth";
import { refreshEntra, signInWithEntra, SignInCancelled, type EntraSession } from "./entra";
import { KEYS, SecureKeyValueStore, type KeyValueStore } from "./tokenStore";
import { sessionVerdict, shouldLock, StepUpWindow } from "./stepUp";

export type AuthStatus = "loading" | "signed_out" | "locked" | "ready";

export interface AuthApi extends AuthHeaderSource {
  status: AuthStatus;
  mode: "dev" | "entra";
  member: MemberSummary | undefined;
  biometrics: BiometricInfo;
  faceIdEnabled: boolean;
  setFaceIdEnabled(on: boolean): Promise<void>;
  /** First run on this phone (V10): the "One more thing: Face ID" step has not been answered yet. */
  needsFaceIdIntro: boolean;
  /** Answer the first-run step: true confirms Face ID once and turns it on; false leaves it off. */
  finishFaceIdIntro(enable: boolean): Promise<boolean>;
  signInDev(member: { id: string; name: string }): Promise<void>;
  /** Opens the system browser on the tenant sign-in page. Resolves false when the person cancelled. */
  signInEntra(): Promise<boolean>;
  signOut(): Promise<void>;
  /** The Face ID gate on open. */
  unlock(): Promise<boolean>;
  /** Fresh local authentication for a sensitive action. True when verified now or inside the last 2 minutes. */
  stepUp(reason?: string): Promise<boolean>;
  stepUpIsFresh(): boolean;
  /** The last sign-in or session error, in plain words, for the sign-in screen. */
  error: string | undefined;
}

const AuthContext = createContext<AuthApi | undefined>(undefined);

export function AuthProvider({ children, store: storeProp }: PropsWithChildren<{ store?: KeyValueStore }>): React.JSX.Element {
  const store = useMemo(() => storeProp ?? new SecureKeyValueStore(), [storeProp]);
  const mode = env.authMode;
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [member, setMember] = useState<MemberSummary | undefined>(undefined);
  const [biometrics, setBiometrics] = useState<BiometricInfo>({ available: false, faceId: false, passcodeOnly: false });
  const [faceIdEnabled, setFaceIdState] = useState(true);
  const [faceIdAnswered, setFaceIdAnswered] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const session = useRef<EntraSession | undefined>(undefined);
  const stepUpWindow = useRef(new StepUpWindow());
  const lastUnlockAt = useRef<number | undefined>(undefined);
  const backgroundedAt = useRef<number | undefined>(undefined);
  const refreshing = useRef<Promise<EntraSession> | undefined>(undefined);

  const canLock = useCallback((bio: BiometricInfo, enabled: boolean) => enabled && (bio.available || bio.passcodeOnly), []);

  // Restore the session on a cold start.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const bio = await biometricInfo();
      const enabledPref = await store.get<boolean>(KEYS.faceId);
      const enabled = enabledPref ?? true;
      lastUnlockAt.current = await store.get<number>(KEYS.lastUnlockAt);
      let m: MemberSummary | undefined;
      if (mode === "dev") {
        m = await store.get<MemberSummary>(KEYS.devMember);
      } else {
        const s = await store.get<EntraSession>(KEYS.session);
        if (s) {
          const verdict = sessionVerdict({ signedInAt: s.signedInAt, lastRefreshAt: s.lastRefreshAt, accessExpiresAt: s.expiresAt, now: Date.now() });
          if (verdict === "sign_in_again") {
            await store.remove(KEYS.session);
          } else {
            session.current = s;
            m = s.member;
          }
        }
      }
      if (cancelled) return;
      setBiometrics(bio);
      setFaceIdState(enabled);
      setFaceIdAnswered(enabledPref !== undefined);
      setMember(m);
      if (!m) setStatus("signed_out");
      else setStatus(canLock(bio, enabled) && shouldLock({ faceIdEnabled: true, lastUnlockAt: lastUnlockAt.current, now: Date.now() }) ? "locked" : "ready");
    })().catch(() => {
      if (!cancelled) setStatus("signed_out");
    });
    return () => {
      cancelled = true;
    };
  }, [store, mode, canLock]);

  // Lock again after a long time in the background.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        backgroundedAt.current = Date.now();
        return;
      }
      if (state === "active" && status === "ready" && canLock(biometrics, faceIdEnabled)) {
        if (shouldLock({ faceIdEnabled: true, lastUnlockAt: lastUnlockAt.current, backgroundedAt: backgroundedAt.current, now: Date.now() })) setStatus("locked");
      }
    });
    return () => sub.remove();
  }, [status, biometrics, faceIdEnabled, canLock]);

  const recordUnlock = useCallback(async () => {
    const now = Date.now();
    lastUnlockAt.current = now;
    stepUpWindow.current.record(now);
    await store.set(KEYS.lastUnlockAt, now);
  }, [store]);

  const ensureFreshSession = useCallback(async (): Promise<EntraSession> => {
    const s = session.current;
    if (!s) throw new Error("not_signed_in");
    const verdict = sessionVerdict({ signedInAt: s.signedInAt, lastRefreshAt: s.lastRefreshAt, accessExpiresAt: s.expiresAt, now: Date.now() });
    if (verdict === "ok") return s;
    if (verdict === "sign_in_again") {
      session.current = undefined;
      await store.remove(KEYS.session);
      setMember(undefined);
      setStatus("signed_out");
      setError("Please sign in again with your passkey.");
      throw new Error("sign_in_again");
    }
    refreshing.current ??= refreshEntra(s)
      .then(async (next) => {
        session.current = next;
        await store.set(KEYS.session, next);
        return next;
      })
      .catch(async (err: unknown) => {
        session.current = undefined;
        await store.remove(KEYS.session);
        setMember(undefined);
        setStatus("signed_out");
        setError("Your sign-in expired. Please sign in again with your passkey.");
        throw err;
      })
      .finally(() => {
        refreshing.current = undefined;
      });
    return refreshing.current;
  }, [store]);

  const headers = useCallback<AuthHeaderSource["headers"]>(
    async (opts) => {
      if (mode === "dev") {
        const h: Record<string, string> = { "x-dev-member": member?.id ?? "" };
        if (opts?.stepUp && stepUpWindow.current.isFresh()) h["x-step-up"] = "true";
        return h;
      }
      const s = await ensureFreshSession();
      return { authorization: `Bearer ${s.accessToken}` };
    },
    [mode, member?.id, ensureFreshSession],
  );

  const currentMember = useCallback<AuthHeaderSource["currentMember"]>(() => member ?? { id: "", displayName: "You", role: "member" }, [member]);

  const signOut = useCallback(async () => {
    session.current = undefined;
    stepUpWindow.current.clear();
    await Promise.all([store.remove(KEYS.session), store.remove(KEYS.devMember), store.remove(KEYS.lastUnlockAt)]);
    setMember(undefined);
    setStatus("signed_out");
  }, [store]);

  const onUnauthorized = useCallback(() => {
    if (mode === "entra") {
      // The API refused the token: try one refresh on the next call; if that fails the session ends.
      const s = session.current;
      if (s) session.current = { ...s, expiresAt: 0 };
    }
  }, [mode]);

  const signInDev = useCallback(
    async (m: { id: string; name: string }) => {
      const summary: MemberSummary = { id: m.id, displayName: m.name, role: "member" };
      await store.set(KEYS.devMember, summary);
      setMember(summary);
      setError(undefined);
      await recordUnlock();
      setStatus("ready");
    },
    [store, recordUnlock],
  );

  const signInEntra = useCallback(async () => {
    setError(undefined);
    try {
      const s = await signInWithEntra();
      session.current = s;
      await store.set(KEYS.session, s);
      setMember(s.member);
      await recordUnlock();
      setStatus("ready");
      return true;
    } catch (err) {
      if (err instanceof SignInCancelled) return false;
      setError(err instanceof Error ? err.message : "Sign-in didn't go through. Try again.");
      return false;
    }
  }, [store, recordUnlock]);

  const unlock = useCallback(async () => {
    if (!canLock(biometrics, faceIdEnabled)) {
      await recordUnlock();
      setStatus("ready");
      return true;
    }
    const ok = await authenticateLocally("Open Homestead");
    if (ok) {
      await recordUnlock();
      setStatus("ready");
    }
    return ok;
  }, [biometrics, faceIdEnabled, canLock, recordUnlock]);

  const stepUp = useCallback(
    async (reason = "Confirm it's you") => {
      if (stepUpWindow.current.isFresh()) return true;
      const ok = biometrics.available || biometrics.passcodeOnly ? await authenticateLocally(reason) : true;
      if (!ok) return false;
      if (mode === "entra" && session.current) {
        // Re-acquire so the token's iat falls inside the API's 2-minute window.
        try {
          const next = await refreshEntra(session.current);
          session.current = next;
          await store.set(KEYS.session, next);
        } catch {
          return false;
        }
      }
      stepUpWindow.current.record();
      return true;
    },
    [biometrics, mode, store],
  );

  const stepUpIsFresh = useCallback(() => stepUpWindow.current.isFresh(), []);

  const setFaceIdEnabled = useCallback(
    async (on: boolean) => {
      setFaceIdState(on);
      setFaceIdAnswered(true);
      await store.set(KEYS.faceId, on);
    },
    [store],
  );

  const needsFaceIdIntro = status === "ready" && !faceIdAnswered && (biometrics.available || biometrics.passcodeOnly);

  const finishFaceIdIntro = useCallback(
    async (enable: boolean) => {
      if (!enable) {
        await setFaceIdEnabled(false);
        return true;
      }
      const ok = await authenticateLocally("Turn on Face ID for Homestead");
      if (!ok) return false;
      await setFaceIdEnabled(true);
      await recordUnlock();
      return true;
    },
    [setFaceIdEnabled, recordUnlock],
  );

  const value = useMemo<AuthApi>(
    () => ({ status, mode, member, biometrics, faceIdEnabled, setFaceIdEnabled, needsFaceIdIntro, finishFaceIdIntro, signInDev, signInEntra, signOut, unlock, stepUp, stepUpIsFresh, headers, currentMember, onUnauthorized, error }),
    [status, mode, member, biometrics, faceIdEnabled, setFaceIdEnabled, needsFaceIdIntro, finishFaceIdIntro, signInDev, signInEntra, signOut, unlock, stepUp, stepUpIsFresh, headers, currentMember, onUnauthorized, error],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}
