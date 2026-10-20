import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { CHART, DIMENSION_CODES, type CategoryMapping, type DimensionSet } from "@homestead/shared";
import { useMappings, useProposeMapping } from "../api/hooks";
import { Dialog, ErrorNotice, Loading, PageHead, Tabs, Tag, useToast } from "../components/ui";
import { ago, dateTime } from "../lib/format";

type Section = "categories" | "dimensions" | "bankcards" | "employers";

const DIM_ORDER = Object.keys(DIMENSION_CODES) as (keyof typeof DIMENSION_CODES)[];

function DimsCell({ dims }: { dims: DimensionSet }) {
  const parts = DIM_ORDER.filter((k) => dims[k]).map((k) => `${k.replace("_", " ").toLowerCase()}: ${dims[k]}`);
  return parts.length ? <span className="mono" style={{ fontSize: 11.5 }}>{parts.join(" · ")}</span> : <span className="sub">account defaults</span>;
}

export function Mappings() {
  const [params, setParams] = useSearchParams();
  const section = (params.get("tab") as Section | null) ?? "categories";
  const q = useMappings();
  const [proposing, setProposing] = useState<CategoryMapping | null>(null);
  const [filter, setFilter] = useState("");
  const [toast, say] = useToast();

  const categories = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const all = q.data?.categories ?? [];
    return f ? all.filter((c) => c.name.toLowerCase().includes(f) || c.id.includes(f) || c.glAccount.includes(f) || c.group.toLowerCase().includes(f)) : all;
  }, [q.data, filter]);

  return (
    <>
      <PageHead
        title="Account and dimension mappings"
        lede="The household's words for the chart. Each category posts to one G/L account and inherits that account's five dimensions. The mapping is versioned; a change is a proposal that the other spouse approves, never an edit in place."
        dataThrough={q.data?.dataThrough}
        right={q.data ? <Tag tone="neutral">catalog v{q.data.catalogVersion}</Tag> : null}
      />
      <Tabs<Section>
        tabs={[
          { id: "categories", label: "Categories", count: q.data?.categories.length },
          { id: "dimensions", label: "Dimension dictionary", count: q.data?.dimensions.length },
          { id: "bankcards", label: "Bank cards", count: q.data?.bankCards.length },
          { id: "employers", label: "Employers and paychecks", count: q.data?.employers.length },
        ]}
        value={section}
        onChange={(s) => setParams({ tab: s })}
      />
      {q.isLoading ? <Loading what="Reading mappings" /> : q.error ? <ErrorNotice error={q.error} /> : null}
      {q.data && q.data.pendingProposals.length > 0 ? (
        <div className="notice watch" style={{ marginBottom: 12 }}>
          {q.data.pendingProposals.length} mapping proposal{q.data.pendingProposals.length === 1 ? "" : "s"} waiting for the other spouse:{" "}
          {q.data.pendingProposals.map((p) => `${p.categoryId} (${p.requestedBy}, ${ago(p.requestedAt)})`).join("; ")}
        </div>
      ) : null}

      {q.data && section === "categories" ? (
        <>
          <div className="toolbar">
            <input type="text" placeholder="Filter by name, id, account or group" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter categories" style={{ minWidth: 320 }} />
            <span className="spacer" />
            <span style={{ color: "var(--muted)", fontSize: 12.5 }}>{categories.length} shown</span>
          </div>
          <div className="table-wrap">
            <table className="data" data-testid="categories-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Group</th>
                  <th>G/L account</th>
                  <th>Dimension defaults</th>
                  <th>Flags</th>
                  <th>Version</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.name}
                      <span className="sub mono">{c.id}</span>
                    </td>
                    <td>{c.group}</td>
                    <td className="mono">
                      {c.glAccount}
                      <span className="sub">{c.glAccountName ?? CHART.find((a) => a.no === c.glAccount)?.name ?? ""}</span>
                    </td>
                    <td>
                      <DimsCell dims={c.dims} />
                    </td>
                    <td>
                      {c.isTransfer ? <Tag tone="neutral">transfer</Tag> : null} {c.isAllowance ? <Tag tone="neutral">allowance</Tag> : null} {!c.householdVisible ? <Tag tone="muted">CFO only</Tag> : null}
                    </td>
                    <td>
                      v{c.version}
                      {c.retiredAt ? <span className="sub">retired</span> : null}
                    </td>
                    <td className="actions">
                      <button type="button" className="btn small" onClick={() => setProposing(c)}>
                        Propose change
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {q.data && section === "dimensions" ? (
        <div className="grid cols-2">
          {q.data.dimensions.map((d) => (
            <div key={d.code} className="card">
              <div className="card-head">
                <h2>
                  {d.code} <span className="hint">· {d.name} · {d.slot}</span>
                </h2>
                <span className="hint">{d.values.length} values</span>
              </div>
              <table className="data">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                  </tr>
                </thead>
                <tbody>
                  {d.values.map((v) => (
                    <tr key={v.code}>
                      <td className="mono">{v.code}</td>
                      <td>
                        {v.name} {v.blocked ? <Tag tone="muted">blocked</Tag> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <div className="card" style={{ gridColumn: "1 / -1" }}>
            <h3>Combinations enforced on every line</h3>
            <p style={{ color: "var(--muted)" }}>SPEND_CLASS TRANSFER carries TAX_TREATMENT TAXFREE or blank; SPEND_CLASS GIVING carries no FUND_GOAL. Every journal line sends all five dimensions explicitly (BC test finding 1: only the two globals travel on the line itself).</p>
          </div>
        </div>
      ) : null}

      {q.data && section === "bankcards" ? (
        <div className="table-wrap">
          <table className="data" data-testid="bankcards-table">
            <thead>
              <tr>
                <th>Bank card</th>
                <th>G/L account</th>
                <th>Kind</th>
                <th>Institution</th>
                <th>Mask</th>
                <th>Feed</th>
                <th>App account</th>
              </tr>
            </thead>
            <tbody>
              {q.data.bankCards.map((b) => (
                <tr key={b.code}>
                  <td>
                    <strong>{b.code}</strong>
                    <span className="sub">{b.name}</span>
                  </td>
                  <td className="mono">{b.glAccount}</td>
                  <td>{b.kind}</td>
                  <td>{b.institution}</td>
                  <td className="mono">{b.mask ? `x${b.mask}` : "—"}</td>
                  <td>{b.feedProvider ?? <span className="sub">none</span>}</td>
                  <td className="mono">{b.accountId ?? <span className="sub">not linked</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {q.data && section === "employers" ? (
        <div className="grid cols-2">
          {q.data.employers.map((e) => (
            <div key={e.id} className="card">
              <div className="card-head">
                <h2>
                  {e.code} · {e.name}
                </h2>
                <span className="hint">{e.memberName} · last stub {e.lastStubAt ? dateTime(e.lastStubAt) : "never"}</span>
              </div>
              <dl className="kv" style={{ marginBottom: 10 }}>
                <dt>Descriptor</dt>
                <dd className="mono">{e.descriptorPattern}</dd>
                <dt>Gross wages</dt>
                <dd className="mono">{e.grossAccount}</dd>
                <dt>Bonus</dt>
                <dd className="mono">{e.bonusAccount}</dd>
              </dl>
              <table className="data">
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>G/L</th>
                    <th>Dimensions</th>
                  </tr>
                </thead>
                <tbody>
                  {e.components.map((c) => (
                    <tr key={c.kind}>
                      <td>
                        {c.label}
                        <span className="sub">{c.kind}</span>
                      </td>
                      <td className="mono">{c.glAccount}</td>
                      <td>
                        <DimsCell dims={c.dims} />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>
                      Net pay<span className="sub">to the receiving bank card</span>
                    </td>
                    <td className="mono">bank card</td>
                    <td>
                      <span className="sub">—</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ) : null}

      <ProposeDialog row={proposing} onClose={() => setProposing(null)} onDone={() => say("Proposal sent to the other spouse for approval.")} />
      {toast}
    </>
  );
}

function ProposeDialog({ row, onClose, onDone }: { row: CategoryMapping | null; onClose: () => void; onDone: () => void }) {
  const propose = useProposeMapping();
  const [gl, setGl] = useState("");
  const [reason, setReason] = useState("");
  const [dims, setDims] = useState<DimensionSet>({});
  const posting = useMemo(() => CHART.filter((a) => !["cash", "liability_card"].includes(a.kind)), []);
  const key = row?.id ?? "";
  const [seeded, setSeeded] = useState("");
  if (row && seeded !== key) {
    setSeeded(key);
    setGl(row.glAccount);
    setDims(row.dims);
    setReason("");
  }
  async function submit() {
    if (!row) return;
    await propose.mutateAsync({ categoryId: row.id, glAccount: gl, dims, reason });
    onDone();
    onClose();
  }
  return (
    <Dialog
      open={row !== null}
      title={`Propose a mapping change · ${row?.name ?? ""}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!reason.trim() || propose.isPending || (gl === row?.glAccount && JSON.stringify(dims) === JSON.stringify(row?.dims))} onClick={() => void submit()}>
            Send proposal
          </button>
        </>
      }
    >
      {row ? (
        <>
          <div className="notice">Mappings change by proposal: the other spouse approves with step-up, the catalog version increments, and the change takes effect for new lines from the effective date. Posted entries are never remapped.</div>
          <label className="field">
            G/L account
            <select value={gl} onChange={(e) => setGl(e.target.value)} aria-label="G/L account">
              {posting.map((a) => (
                <option key={a.no} value={a.no}>
                  {a.no} · {a.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid cols-3">
            {DIM_ORDER.map((k) => (
              <label key={k} className="field">
                {k}
                <input type="text" value={dims[k] ?? ""} onChange={(e) => setDims({ ...dims, [k]: e.target.value || undefined })} aria-label={k} />
              </label>
            ))}
          </div>
          <label className="field">
            Why
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          </label>
        </>
      ) : null}
    </Dialog>
  );
}
