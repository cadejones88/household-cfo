import { CHART } from "@homestead/shared";
import { useReconciliation } from "../api/hooks";
import { Empty, ErrorNotice, Loading, PageHead, Tag } from "../components/ui";
import { date, dateTime, money } from "../lib/format";
import { feedStatusView } from "../lib/status";
import { bcBankLedgerUrl, bcLinksConfigured } from "../lib/bcLinks";

/** The three loans the rollforward tiles cover (G/L liabilities in the shared chart). */
const LOAN_ACCOUNTS = ["251101", "251201", "271101"] as const;

export function Reconciliation() {
  const q = useReconciliation();
  const missing = new Set(q.data?.missing ?? []);
  const totalOpen = q.data?.bankCards.reduce((n, c) => n + c.openCount, 0) ?? 0;
  const totalDiff = q.data?.bankCards.reduce((n, c) => n + c.differences.length, 0) ?? 0;

  return (
    <>
      <PageHead
        title="Reconciliation status"
        lede="Bank reconciliation runs in BC as today. The app reads Bank Account Ledger Entry status through the HH App Connector (hhBankLedgerEntries) and marks lines Reconciled; differences come here and to the Exceptions queue."
        dataThrough={q.data?.dataThrough}
      />
      {q.isLoading ? <Loading what="Reading reconciliation status" /> : q.error ? <ErrorNotice error={q.error} /> : null}
      {q.data ? (
        <>
          <div className="grid cols-3" style={{ marginBottom: 14 }}>
            <div className="card stat">
              <span className="label">Open bank ledger lines</span>
              <span className="value">{totalOpen}</span>
              <span className="sub">posted in BC, not yet on a reconciled statement · {q.data.bankCards.length} bank cards</span>
            </div>
            <div className="card stat">
              <span className="label">Differences</span>
              <span className="value" style={{ color: totalDiff > 0 ? "var(--watch)" : undefined }}>
                {totalDiff}
              </span>
              <span className="sub">app vs BC bank ledger after the last statement</span>
            </div>
            <div className="card stat">
              <span className="label">Loans matched this period</span>
              <span className="value">{missing.has("loans") ? "—" : `${q.data.loans.filter((l) => l.matchedEntryNo).length} / ${q.data.loans.length}`}</span>
              <span className="sub">BC-native recurring entries (R7){missing.has("loans") ? " · not in the API yet" : ""}</span>
            </div>
          </div>
          {missing.size > 0 ? (
            <div className="notice watch" style={{ marginBottom: 12 }} data-testid="recon-missing">
              The API does not report {[missing.has("openSum") ? "open sums" : "", missing.has("statements") ? "statement numbers and dates" : "", missing.has("differenceLines") ? "the individual difference lines" : "", missing.has("loans") ? "loan rollforwards" : ""].filter(Boolean).join(", ")} yet. Those cells show "—" rather than a zero; the counts come from the app's mirror of BC.
            </div>
          ) : null}

          <div className="card">
            <div className="card-head">
              <h2>Bank cards</h2>
              <span className="hint">Cards, Venmo and CareCredit are bank account cards in BC; loans are G/L liabilities below</span>
            </div>
            <div className="table-wrap" style={{ maxHeight: "none" }}>
              <table className="data" data-testid="recon-table">
                <thead>
                  <tr>
                    <th>Bank card</th>
                    <th>G/L</th>
                    <th>Feed</th>
                    <th className="num">Open</th>
                    <th className="num">Reconciled</th>
                    <th className="num">Open sum</th>
                    <th>Last statement</th>
                    <th>Reconciled through</th>
                    <th>Differences</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.bankCards.map((c) => {
                    const fs = feedStatusView(c.feedStatus);
                    return (
                      <tr key={c.code}>
                        <td>
                          <strong>{c.code}</strong>
                          <span className="sub">
                            {c.name}
                            {c.mask ? ` · x${c.mask}` : ""} · {c.institution}
                          </span>
                        </td>
                        <td className="mono">
                          {c.glAccount}
                          {bcLinksConfigured() ? (
                            <span className="sub">
                              <a href={bcBankLedgerUrl(c.code)} target="_blank" rel="noreferrer">
                                ledger in BC
                              </a>
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <Tag tone={fs.tone}>{fs.label}</Tag>
                        </td>
                        <td className="num">{c.openCount}</td>
                        <td className="num">{c.reconciledCount}</td>
                        <td className="num">{missing.has("openSum") ? "—" : money(c.openSumCents)}</td>
                        <td>
                          {c.lastStatementNo ?? "—"}
                          <span className="sub">{c.lastStatementDate ? date(c.lastStatementDate) : ""}</span>
                        </td>
                        <td>{c.reconciledThrough ? date(c.reconciledThrough) : <span className="sub">{missing.has("statements") ? "—" : "never"}</span>}</td>
                        <td>
                          {c.differences.length === 0 ? (
                            <Tag tone="good">none</Tag>
                          ) : (
                            <ul style={{ margin: 0, paddingLeft: 16 }}>
                              {c.differences.map((d, i) => (
                                <li key={i}>
                                  {missing.has("differenceLines") ? d.note : `${date(d.postedDate)} · ${money(d.amountCents)} · ${d.note}`}
                                  {d.transactionId ? (
                                    <>
                                      {" "}
                                      <a href={`/queues?tab=exceptions`}>{d.transactionId}</a>
                                    </>
                                  ) : null}
                                  {d.bankLedgerEntryNo ? <span className="sub">BC bank ledger entry {d.bankLedgerEntryNo}</span> : null}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Loan rollforwards</h2>
              <span className="hint">Posted by BC's recurring journals; the app matches the bank line to BC's entry and never creates lines for them</span>
            </div>
            {q.data.loans.length === 0 ? (
              <Empty title={missing.has("loans") ? "Loan rollforwards are not in the API yet." : "No loan rollforwards for this period."}>
                {" "}
                The tiles cover {LOAN_ACCOUNTS.map((no) => CHART.find((a) => a.no === no)?.name ?? no).join("; ")}. BC's recurring journals post them; until the API reports the rollforward, check them in BC.
              </Empty>
            ) : null}
            <div className="grid cols-3">
              {q.data.loans.map((l) => (
                <div key={l.id} className="card" data-testid={`loan-${l.id}`}>
                  <div className="card-head">
                    <h3>{l.name}</h3>
                    {l.matchedEntryNo ? <Tag tone="good">matched · entry {l.matchedEntryNo}</Tag> : <Tag tone="watch">not matched</Tag>}
                  </div>
                  <dl className="kv">
                    <dt>Lender</dt>
                    <dd>
                      {l.lender} · x{l.mask} · G/L {l.glAccount}
                    </dd>
                    <dt>Period</dt>
                    <dd>{l.period}</dd>
                    <dt>Opening</dt>
                    <dd>{money(l.openingCents)}</dd>
                    <dt>Principal</dt>
                    <dd>−{money(l.principalCents)}</dd>
                    <dt>Interest</dt>
                    <dd>{money(l.interestCents)} (expense)</dd>
                    {l.escrowCents !== undefined ? (
                      <>
                        <dt>Escrow</dt>
                        <dd>{money(l.escrowCents)} (prepaid)</dd>
                      </>
                    ) : null}
                    {l.feesCents ? (
                      <>
                        <dt>Fees</dt>
                        <dd>{money(l.feesCents)}</dd>
                      </>
                    ) : null}
                    <dt>Closing</dt>
                    <dd>
                      <strong>{money(l.closingCents)}</strong>
                    </dd>
                    <dt>Next due</dt>
                    <dd>{date(l.nextDueDate)}</dd>
                    <dt>Matched</dt>
                    <dd>{l.matchedAt ? dateTime(l.matchedAt) : "—"}</dd>
                  </dl>
                  {l.openingCents - l.principalCents !== l.closingCents ? <div className="notice action" style={{ marginTop: 8 }}>Rollforward does not tie: opening − principal ≠ closing.</div> : null}
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
