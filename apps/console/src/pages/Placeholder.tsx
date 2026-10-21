import { Link, useLocation } from "react-router";
import { LATER_PAGES } from "../components/Shell";
import { PageHead, Tag } from "../components/ui";

export function Placeholder() {
  const { pathname } = useLocation();
  const page = LATER_PAGES.find((p) => p.to === pathname);
  return (
    <>
      <PageHead title={page ? `${page.fn} · ${page.label}` : "After the pilot"} right={<Tag tone="muted">After the pilot</Tag>} />
      <div className="card" data-testid="placeholder">
        <p>
          <strong>This Console function arrives after the pilot.</strong>
          {page ? ` ${page.body}` : ""}
        </p>
        <p style={{ color: "var(--muted)" }}>
          The six later functions (budget builder and scenarios, 13-week forecast, debt payoff model, net worth and ASC 274 workbench, close checklist, reports and lineage) follow once the budget and debt chats have approved outputs to show. Until then the phone app's budget screens read "Sample budget (BUD26-ORIG test data)" and the goals show "Target not set yet".
        </p>
        <Link to="/" className="btn">
          Back to overview
        </Link>
      </div>
    </>
  );
}
