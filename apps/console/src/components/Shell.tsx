import { NavLink, Outlet } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { useMe, useSyncStatus, useTransactions } from "../api/hooks";
import { config } from "../config";

export const MVP_PAGES = [
  { to: "/queues", label: "Work queues", fn: 1 },
  { to: "/sync", label: "BC sync and posting", fn: 2 },
  { to: "/reconciliation", label: "Reconciliation", fn: 3 },
  { to: "/mappings", label: "Mappings", fn: 4 },
  { to: "/authority", label: "Authority matrix", fn: 11 },
  { to: "/health", label: "Health, logs and audit", fn: 12 },
] as const;

export const LATER_PAGES = [
  { to: "/later/budget", label: "Budget builder and scenarios", fn: 5, body: "Reads BC budgets; scenarios once the budget chat delivers v1." },
  { to: "/later/forecast", label: "13-week cash forecast", fn: 6, body: "Cash by week with the assumptions shown." },
  { to: "/later/debt", label: "Debt payoff model", fn: 7, body: "Waterfall and schedules from the debt chat's approved plan." },
  { to: "/later/net-worth", label: "Net worth and ASC 274 workbench", fn: 8, body: "Links to the PFS workpapers, which stay outside BC." },
  { to: "/later/close", label: "Close checklist", fn: 9, body: "Month-end and quarter-end checklists with sign-off." },
  { to: "/later/reports", label: "Reports and lineage", fn: 10, body: "Any number → report line → BC entry → bank line → receipt." },
] as const;

export function Shell() {
  const auth = useAuth();
  const me = useMe();
  const ready = useTransactions("ready_for_review", { pageSize: 1 });
  const exceptions = useTransactions("exception", { pageSize: 1 });
  const sync = useSyncStatus();
  const queueCount = (ready.data?.total ?? 0) + (exceptions.data?.total ?? 0);
  const deadLetters = sync.data?.outbox.deadLetters ?? 0;

  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/" className="brand" aria-label="Homestead Console home">
          <span className="mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 32 32" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinejoin="round">
              <path d="M8 17 16 9l8 8v8H8z" />
              <path d="M13 25v-6h6v6" />
            </svg>
          </span>
          <span>
            <span className="name">Homestead</span>
            <br />
            <span className="sub">Console</span>
          </span>
        </NavLink>
        <nav className="nav" aria-label="Console">
          <NavLink to="/" end>
            Overview
          </NavLink>
          <div className="group">MVP</div>
          {MVP_PAGES.map((p) => (
            <NavLink key={p.to} to={p.to}>
              <span>{p.label}</span>
              {p.to === "/queues" && queueCount > 0 ? <span className="count">{queueCount}</span> : null}
              {p.to === "/health" && deadLetters > 0 ? <span className="count">{deadLetters}</span> : null}
            </NavLink>
          ))}
          <div className="group">After the pilot</div>
          {LATER_PAGES.map((p) => (
            <NavLink key={p.to} to={p.to} className="later">
              {p.label}
            </NavLink>
          ))}
        </nav>
        <div className="foot">
          <div>
            <strong>{auth.memberName ?? me.data?.member.displayName ?? "—"}</strong>
            <br />
            {me.data?.household.name ?? "Household"} · settings v{me.data?.household.settingsVersion ?? "—"}
          </div>
          <div>
            BC {me.data?.ledger.environment ?? config.bc.environment}
            {config.apiMode === "mock" ? " · mock data" : auth.mode === "dev" ? " · dev auth" : ""}
          </div>
          <button type="button" className="btn small" onClick={() => void auth.signOut()}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
