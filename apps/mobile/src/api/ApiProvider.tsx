/**
 * Picks the API (HTTP against EXPO_PUBLIC_API_URL, or the in-memory MockApi) and owns the React Query client.
 * The mock is a session singleton so state survives navigation; it is keyed by the signed-in member so
 * switching between Vanessa and Cade in dev shows each side of an approval.
 */
import { createContext, useContext, useEffect, useMemo, type PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { env } from "../lib/env";
import { HttpApi } from "./client";
import { MockApi } from "./mock";
import type { HomesteadApi } from "./types";

const ApiContext = createContext<HomesteadApi | undefined>(undefined);

let mockSingleton: MockApi | undefined;
let mockMemberId = "dev-vanessa";
let mockStepUpFresh: () => boolean = () => false;

export function ApiProvider({ children, api }: PropsWithChildren<{ api?: HomesteadApi }>): React.JSX.Element {
  const auth = useAuth();
  mockMemberId = auth.member?.id ?? mockMemberId;
  mockStepUpFresh = auth.stepUpIsFresh;
  const instance = useMemo<HomesteadApi>(() => {
    if (api) return api;
    if (env.apiMode === "mock") {
      mockSingleton ??= new MockApi(() => mockMemberId, { stepUpFresh: () => mockStepUpFresh() });
      return mockSingleton;
    }
    return new HttpApi({ baseUrl: env.apiUrl, auth });
    // The auth object changes identity when the member changes; that is when a new client is wanted.
  }, [api, auth]);
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 20_000, retry: 1, refetchOnWindowFocus: true, refetchOnReconnect: true },
          mutations: { retry: 0 },
        },
      }),
    [],
  );
  // Signing out forgets every cached answer, so the next person to sign in on this phone never sees the last one's screens.
  useEffect(() => {
    if (auth.status === "signed_out") queryClient.clear();
  }, [auth.status, queryClient]);
  return (
    <ApiContext.Provider value={instance}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ApiContext.Provider>
  );
}

export function useApi(): HomesteadApi {
  const v = useContext(ApiContext);
  if (!v) throw new Error("useApi must be used inside ApiProvider");
  return v;
}
