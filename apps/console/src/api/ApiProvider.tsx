import { createContext, useContext, useMemo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { config } from "../config";
import { useAuth } from "../auth/AuthProvider";
import { createHttpApi } from "./http";
import { createMockApi } from "./mock/mockApi";
import type { ConsoleApi } from "./types";

const ApiContext = createContext<ConsoleApi | undefined>(undefined);

let mockSingleton: ConsoleApi | undefined;

export function ApiProvider({ children, api }: { children: ReactNode; api?: ConsoleApi }) {
  const auth = useAuth();
  const instance = useMemo<ConsoleApi>(() => {
    if (api) return api;
    if (config.apiMode === "mock") {
      mockSingleton ??= createMockApi();
      return mockSingleton;
    }
    return createHttpApi(auth.getAuthHeaders, () => ({ id: auth.memberId ?? "", displayName: auth.memberName ?? "Member" }));
  }, [api, auth.getAuthHeaders, auth.memberId, auth.memberName]);
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true },
          mutations: { retry: 0 },
        },
      }),
    [],
  );
  return (
    <ApiContext.Provider value={instance}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ApiContext.Provider>
  );
}

export function useApi(): ConsoleApi {
  const v = useContext(ApiContext);
  if (!v) throw new Error("useApi outside ApiProvider");
  return v;
}
