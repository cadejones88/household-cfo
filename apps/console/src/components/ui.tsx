/**
 * Small shared pieces: the data-through line, quality and status tags, dialog, tabs, empty states, pager.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DataThrough } from "@homestead/shared";
import { qualityView, type Tone } from "../lib/status";
import { ago, dateTime } from "../lib/format";

export function Tag({ tone, children, title, plain }: { tone: Tone; children: ReactNode; title?: string; plain?: boolean }) {
  return (
    <span className={`tag ${tone}${plain ? " plain" : ""}`} title={title}>
      {children}
    </span>
  );
}

export function QualityTag({ quality }: { quality: DataThrough["quality"] }) {
  const q = qualityView(quality);
  return (
    <Tag tone={q.tone} title={q.hint}>
      {q.label}
    </Tag>
  );
}

/** Every screen carries one of these: "Data through … · N pending" plus the quality tag. */
export function DataThroughLine({ dataThrough, extra }: { dataThrough: DataThrough | undefined; extra?: ReactNode }) {
  if (!dataThrough) return <div className="data-through">Data through —</div>;
  return (
    <div className="data-through" data-testid="data-through">
      <span>
        Data through <strong title={dataThrough.at}>{dateTime(dataThrough.at)}</strong> ({ago(dataThrough.at)})
      </span>
      <span>· {dataThrough.pendingCount.toLocaleString("en-US")} pending</span>
      <QualityTag quality={dataThrough.quality} />
      {extra}
    </div>
  );
}

export function PageHead({ title, lede, right, dataThrough }: { title: string; lede?: ReactNode; right?: ReactNode; dataThrough?: DataThrough | undefined }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
        {dataThrough !== undefined ? <DataThroughLine dataThrough={dataThrough} /> : null}
      </div>
      {right ? <div className="right">{right}</div> : null}
    </header>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: readonly { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" type="button" aria-selected={value === t.id} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined ? <span className="count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <div className="loading" role="status">
      {what}…
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="notice action" role="alert">
      Could not load: {msg}
    </div>
  );
}

export function Dialog({ open, title, onClose, children, footer, testId }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; testId?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);
  return (
    <dialog ref={ref} className="dlg" onClose={onClose} onCancel={onClose} aria-label={title} data-testid={testId}>
      {open ? (
        <>
          <div className="dlg-head">
            <h2>{title}</h2>
            <button type="button" className="btn small" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
          <div className="dlg-body">{children}</div>
          {footer ? <div className="dlg-foot">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <span>
        Page {page} of {pages} · {total.toLocaleString("en-US")} rows
      </span>
      <button type="button" className="btn small" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <button type="button" className="btn small" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  );
}

export function useToast(): [ReactNode, (msg: string) => void] {
  const [msg, setMsg] = useState<string | undefined>();
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(undefined), 4000);
    return () => clearTimeout(t);
  }, [msg]);
  const node = msg ? (
    <div className="toast" role="status">
      {msg}
    </div>
  ) : null;
  return [node, setMsg];
}

export function JsonDetails({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return <span className="sub">—</span>;
  return (
    <details className="json">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
