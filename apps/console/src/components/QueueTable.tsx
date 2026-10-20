/**
 * The transaction queue table (Console function 1). Keyboard-friendly: rows are focusable, Space toggles
 * selection, Enter opens the row's main action, "a" approves the selection when the queue allows it.
 */
import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import type { BusinessFlag, ConsoleTransactionRow } from "@homestead/shared";
import { stateView } from "../lib/status";
import { date, money, pct } from "../lib/format";
import { Tag } from "./ui";
import { bcGlEntryUrl, bcLinksConfigured } from "../lib/bcLinks";

export interface QueueTableProps {
  rows: readonly ConsoleTransactionRow[];
  /** Which rows may be selected for bulk approval. */
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onSelectedChange?: (next: Set<string>) => void;
  onApproveSelected?: () => void;
  onWrong?: (row: ConsoleTransactionRow) => void;
  onBusinessFlag?: (row: ConsoleTransactionRow, flag: BusinessFlag) => void;
  onDuplicate?: (row: ConsoleTransactionRow, decision: "not_a_repeat" | "same_thing") => void;
  onResolveException?: (row: ConsoleTransactionRow) => void;
  busy?: boolean;
}

const FLAGS: readonly { id: BusinessFlag; label: string }[] = [
  { id: "none", label: "Personal" },
  { id: "ctj", label: "CTJ" },
  { id: "lash", label: "Lash" },
];

export function QueueTable(props: QueueTableProps) {
  const { rows, selectable = false, selected = new Set<string>(), onSelectedChange, onApproveSelected, onWrong, onBusinessFlag, onDuplicate, onResolveException, busy } = props;
  const [focusIndex, setFocusIndex] = useState(0);
  const allSelected = useMemo(() => rows.length > 0 && rows.every((r) => selected.has(r.id)), [rows, selected]);

  const toggle = useCallback(
    (id: string) => {
      if (!onSelectedChange) return;
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onSelectedChange(next);
    },
    [onSelectedChange, selected],
  );
  const toggleAll = useCallback(() => {
    if (!onSelectedChange) return;
    onSelectedChange(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }, [allSelected, onSelectedChange, rows]);

  function primaryAction(row: ConsoleTransactionRow) {
    if (row.state === "exception") onResolveException?.(row);
    else if (row.state === "possible_duplicate") onDuplicate?.(row, "not_a_repeat");
    else onWrong?.(row);
  }

  function onKey(e: KeyboardEvent<HTMLTableRowElement>, row: ConsoleTransactionRow, i: number) {
    if (e.target !== e.currentTarget) return; // let buttons and selects handle their own keys
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = Math.min(rows.length - 1, i + 1);
      setFocusIndex(n);
      (e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.max(0, i - 1);
      setFocusIndex(n);
      (e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus();
    } else if (e.key === " " && selectable) {
      e.preventDefault();
      toggle(row.id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      primaryAction(row);
    } else if ((e.key === "a" || e.key === "A") && selectable && selected.size > 0) {
      e.preventDefault();
      onApproveSelected?.();
    }
  }

  if (rows.length === 0) {
    return (
      <div className="empty" data-testid="queue-empty">
        <strong>Nothing waiting here.</strong>
        New items arrive with each feed sync and nightly poll.
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="data" data-testid="queue-table">
        <thead>
          <tr>
            {selectable ? (
              <th style={{ width: 32 }}>
                <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={toggleAll} />
              </th>
            ) : null}
            <th>Date</th>
            <th>Account</th>
            <th>Merchant</th>
            <th className="num">Amount</th>
            <th>Category</th>
            <th>State</th>
            <th>Receipt</th>
            <th>Business</th>
            <th>BC</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const sv = stateView(row.state);
            const isSel = selected.has(row.id);
            return (
              <tr key={row.id} className={isSel ? "selected" : undefined} tabIndex={i === focusIndex ? 0 : -1} onKeyDown={(e) => onKey(e, row, i)} onFocus={() => setFocusIndex(i)} data-testid={`row-${row.id}`} aria-selected={selectable ? isSel : undefined}>
                {selectable ? (
                  <td>
                    <input type="checkbox" aria-label={`Select ${row.merchantRaw}`} checked={isSel} onChange={() => toggle(row.id)} />
                  </td>
                ) : null}
                <td>
                  {date(row.postedDate)}
                  {row.pending ? <span className="sub">pending</span> : null}
                </td>
                <td>
                  {row.accountName}
                  {row.accountMask ? <span className="sub">x{row.accountMask}</span> : null}
                </td>
                <td>
                  {row.merchantRaw}
                  <span className="sub">
                    {row.source} · {row.kind}
                    {row.duplicateOfId ? ` · may repeat ${row.duplicateOfId}` : ""}
                  </span>
                </td>
                <td className={`num ${row.amountCents < 0 ? "neg" : "pos"}`}>{money(row.amountCents)}</td>
                <td>
                  {row.categoryName ?? <span className="sub">not chosen</span>}
                  {row.confidence !== undefined ? (
                    <span className="sub">
                      {row.tier} · {pct(row.confidence)}
                      {row.ruleId ? " · rule" : ""}
                    </span>
                  ) : null}
                  {row.splits.length > 1 ? <span className="sub">{row.splits.length} lines</span> : null}
                </td>
                <td>
                  <Tag tone={sv.tone} title={`Vanessa sees: ${sv.plain}`}>
                    {sv.label}
                  </Tag>
                  {row.exception ? <span className="sub">{row.exception.reason}</span> : null}
                </td>
                <td>{row.receiptStatus === "none" ? <span className="sub">—</span> : row.receiptStatus}</td>
                <td>
                  <select aria-label={`Business flag for ${row.merchantRaw}`} value={row.businessFlag} disabled={busy || !onBusinessFlag} onChange={(e) => onBusinessFlag?.(row, e.target.value as BusinessFlag)}>
                    {FLAGS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {row.bc ? (
                    <>
                      <code title="External Document No.">{row.bc.externalDocumentNo}</code>
                      <span className="sub">
                        {row.bc.batch ? `HHAPP/${row.bc.batch}` : ""}
                        {row.bc.entryNos?.length ? ` · entries ${row.bc.entryNos.join(", ")}` : ""}
                        {row.bc.syncStatus ? ` · ${row.bc.syncStatus}` : ""}
                        {bcLinksConfigured() ? (
                          <>
                            {" · "}
                            <a href={bcGlEntryUrl(row.bc.externalDocumentNo)} target="_blank" rel="noreferrer">
                              open in BC
                            </a>
                          </>
                        ) : null}
                      </span>
                    </>
                  ) : (
                    <span className="sub">not sent</span>
                  )}
                </td>
                <td className="actions">
                  {row.state === "exception" ? (
                    <button type="button" className="btn small primary" disabled={busy} onClick={() => onResolveException?.(row)}>
                      Resolve
                    </button>
                  ) : row.state === "possible_duplicate" ? (
                    <>
                      <button type="button" className="btn small" disabled={busy} onClick={() => onDuplicate?.(row, "not_a_repeat")}>
                        Not a repeat
                      </button>{" "}
                      <button type="button" className="btn small" disabled={busy} onClick={() => onDuplicate?.(row, "same_thing")}>
                        Same thing
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn small" disabled={busy} onClick={() => onWrong?.(row)}>
                      This is wrong
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
