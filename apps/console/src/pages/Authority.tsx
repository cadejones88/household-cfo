import { Fragment } from "react";
import { useAuthority } from "../api/hooks";
import { ErrorNotice, Loading, PageHead, Tag } from "../components/ui";
import { date, dateTime } from "../lib/format";
import { ruleStateView } from "../lib/status";

export function Authority() {
  const q = useAuthority();
  return (
    <>
      <PageHead
        title="Authority matrix"
        lede="Who may do what, and with which step-up. Stored as household settings version 1 and shown read-only until both spouses approve it in writing. Nothing here is editable from the Console."
        right={q.data ? <Tag tone="neutral">settings v{q.data.settings.version}</Tag> : null}
      />
      {q.isLoading ? <Loading what="Reading the authority matrix" /> : q.error ? <ErrorNotice error={q.error} /> : null}
      {q.data ? (
        <>
          {q.data.rows.some((r) => r.tbd) ? (
            <div className="notice watch" style={{ marginBottom: 12 }} data-testid="tbd-notice">
              <strong>Open item:</strong> the I-09 dollar threshold for unilateral budget moves between flexible categories is still TBD; it is decided with the Constitution. Until then every budget move goes to the other spouse.
            </div>
          ) : null}
          <div className="card">
            <div className="card-head">
              <h2>Draft matrix (Phase 3 spec)</h2>
              <span className="hint">{q.data.approvedAt ? `approved ${date(q.data.approvedAt)} by ${q.data.approvedBy?.join(" and ")}` : "awaiting written approval"}</span>
            </div>
            <table className="data" data-testid="authority-table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Who</th>
                  <th>Step-up</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((r) => (
                  <tr key={r.action} style={r.tbd ? { background: "var(--watch-soft)" } : undefined} data-tbd={r.tbd ? "true" : undefined}>
                    <td>
                      {r.action} {r.tbd ? <Tag tone="watch">TBD</Tag> : null}
                    </td>
                    <td>{r.who}</td>
                    <td>{r.stepUp}</td>
                    <td>
                      {r.notes}
                      {r.settingKeys?.length ? <span className="sub">settings: {r.settingKeys.join(", ")}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid cols-2">
            <div className="card">
              <div className="card-head">
                <h2>Household settings</h2>
                <span className="hint">
                  v{q.data.settings.version} · effective {dateTime(q.data.settings.effectiveFrom)}
                </span>
              </div>
              <dl className="kv">
                {Object.entries(q.data.settings.values).map(([k, v]) => (
                  <Fragment key={k}>
                    <dt>{k}</dt>
                    <dd>{String(v)}</dd>
                  </Fragment>
                ))}
              </dl>
              <h3 style={{ marginTop: 14 }}>Versions</h3>
              <table className="data">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Effective</th>
                    <th>Approved by</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.settings.history.map((h) => (
                    <tr key={h.version}>
                      <td>v{h.version}</td>
                      <td>{dateTime(h.effectiveFrom)}</td>
                      <td>{h.approvedBy.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <div className="card-head">
                <h2>Auto-post rules (R1–R7)</h2>
                <span className="hint">Each needs a passed sandbox test and Cade's written approval; the household switch stays off until then</span>
              </div>
              <table className="data">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>State</th>
                    <th>Auto-post</th>
                    <th>Sandbox test</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.autoPostRules.map((r) => {
                    const sv = ruleStateView(r.state);
                    return (
                      <tr key={r.ruleNo}>
                        <td>
                          <strong>{r.ruleNo}</strong> · {r.name}
                        </td>
                        <td>
                          <Tag tone={sv.tone}>{sv.label}</Tag>
                        </td>
                        <td>{r.mayAutoPost ? "candidate" : "no"}</td>
                        <td>{r.testPassedAt ? date(r.testPassedAt) : <span className="sub">not yet</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p style={{ marginTop: 10, color: "var(--muted)", fontSize: 12.5 }}>Decision 4 (Oct 20, 2026): R2, R3 and R7 go live first once their sandbox test passes; R1, R4, R5 and R6 after one clean month.</p>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
