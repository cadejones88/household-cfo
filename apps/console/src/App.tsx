import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { ApiProvider } from "./api/ApiProvider";
import { Shell } from "./components/Shell";
import { Overview } from "./pages/Overview";
import { WorkQueues } from "./pages/WorkQueues";
import { SyncPosting } from "./pages/SyncPosting";
import { Reconciliation } from "./pages/Reconciliation";
import { Mappings } from "./pages/Mappings";
import { Authority } from "./pages/Authority";
import { Health } from "./pages/Health";
import { Placeholder } from "./pages/Placeholder";
import type { ConsoleApi } from "./api/types";

function SignIn() {
  const auth = useAuth();
  return (
    <div className="signin">
      <div className="card">
        <h1>Homestead Console</h1>
        <p style={{ color: "var(--muted)", margin: "8px 0 16px" }}>Sign in with your household account. Your passkey works through this browser; sessions last 12 hours.</p>
        {auth.status === "error" ? (
          <div className="notice action" style={{ marginBottom: 12 }}>
            {auth.error}
          </div>
        ) : null}
        <button type="button" className="btn primary" onClick={() => void auth.signIn()} disabled={auth.status === "loading"}>
          {auth.status === "loading" ? "Checking your session…" : "Sign in"}
        </button>
      </div>
    </div>
  );
}

function Gate() {
  const auth = useAuth();
  if (auth.mode === "entra" && auth.status !== "signed_in") return <SignIn />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Overview />} />
        <Route path="/queues" element={<WorkQueues />} />
        <Route path="/sync" element={<SyncPosting />} />
        <Route path="/reconciliation" element={<Reconciliation />} />
        <Route path="/mappings" element={<Mappings />} />
        <Route path="/authority" element={<Authority />} />
        <Route path="/health" element={<Health />} />
        <Route path="/later/*" element={<Placeholder />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App({ api }: { api?: ConsoleApi }) {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ApiProvider api={api}>
          <Gate />
        </ApiProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
