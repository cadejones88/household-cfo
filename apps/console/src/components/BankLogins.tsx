/**
 * Bank logins in the Console: connect a bank through Plaid Link, choose which household account each bank account
 * feeds, reconnect a login the bank signed out (update mode), and remove a login. Each spouse looks after their own
 * logins; the other spouse sees them and their accounts but cannot change them (authority matrix: "Connect or remove
 * a bank login — the login's owner — step-up"). Read-only: nothing here can move money.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { AccountSummary, FeedConnectionSummary } from "@homestead/shared";
import { useApi } from "../api/ApiProvider";
import { useConnections, useFeedAccounts, useFeedReconnected, useHouseholdAccounts, useLinkBank, useSetFeedAccounts, useUnlinkFeed } from "../api/hooks";
import type { AccountLink, BankLoginAccount } from "../api/types";
import { mappingProblems, rankCandidates, suggestMatches, isTakenElsewhere, type MatchOptions } from "../lib/accountMatch";
import { defaultOpenLink, type LinkResult, type OpenLink } from "../lib/plaidLink";
import { Dialog, errorMessage } from "./ui";

type Say = (msg: string) => void;
type LinkSuccess = Extract<LinkResult, { kind: "success" }>;

/** Household account id -> the live login feeding it, for "already connected through …". */
function useConnectedVia(): ReadonlyMap<string, { feedId: string; institutionName: string }> {
  const accounts = useHouseholdAccounts();
  const conn = useConnections();
  return useMemo(() => {
    const byFeed = new Map((conn.data?.feeds ?? []).map((f) => [f.id, f]));
    const m = new Map<string, { feedId: string; institutionName: string }>();
    for (const a of accounts.data ?? []) {
      const f = a.feedConnectionId ? byFeed.get(a.feedConnectionId) : undefined;
      if (a.feedConnectionId && (!f || f.status !== "disabled")) m.set(a.id, { feedId: a.feedConnectionId, institutionName: f?.institutionName ?? "another login" });
    }
    return m;
  }, [accounts.data, conn.data]);
}

const linksFrom = (choice: Readonly<Record<string, string>>): AccountLink[] => Object.entries(choice).filter(([, id]) => id).map(([plaidAccountId, accountId]) => ({ accountId, plaidAccountId }));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- Connect a bank ------------------------------------------------------------------------------------------------

export function ConnectBank({ openLink = defaultOpenLink, say }: { openLink?: OpenLink; say: Say }) {
  const api = useApi();
  const household = useHouseholdAccounts();
  const connectedVia = useConnectedVia();
  const link = useLinkBank();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<{ link: LinkSuccess; household: AccountSummary[]; initial: Record<string, string> } | null>(null);

  async function start() {
    setError(undefined);
    try {
      // A fresh sign-in now, while nothing is in hand; the save at the end then needs no trip away from the page.
      setBusy("Checking your sign-in…");
      await api.confirmStepUp();
      setBusy("Opening Plaid…");
      const [t, accounts] = await Promise.all([api.bankLinkToken(), household.data ? Promise.resolve(household.data) : api.householdAccounts()]);
      const r = await openLink(t.linkToken);
      if (r.kind === "exit") {
        if (r.message) setError(r.message);
        return;
      }
      const latest = household.data ?? accounts;
      setResult({ link: r, household: latest, initial: suggestMatches(r.accounts, latest, { institutionName: r.institution?.name ?? null, connectedVia }) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  const name = result?.link.institution?.name ?? "The bank";
  return (
    <>
      <div className="connect-bank">
        <button type="button" className="btn primary" onClick={() => void start()} disabled={busy !== undefined} data-testid="connect-bank">
          {busy ?? "Connect a bank"}
        </button>
        {error ? (
          <span className="sub" role="alert" style={{ color: "var(--action)" }}>
            {error}
          </span>
        ) : null}
      </div>
      {result ? (
        <MapAccountsDialog
          title={`Connect ${name}`}
          intro={
            <>
              Choose where each account from <strong>{name}</strong> goes. Nothing is saved until you press <em>Save connection</em>; closing this
              leaves the bank unconnected.
            </>
          }
          institutionName={result.link.institution?.name ?? null}
          plaidAccounts={result.link.accounts}
          household={household.data ?? result.household}
          opts={{ institutionName: result.link.institution?.name ?? null, connectedVia }}
          initial={result.initial}
          saveLabel="Save connection"
          cancelLabel="Don't connect"
          busy={link.isPending}
          onClose={() => {
            setResult(null);
            say(`${name} was not connected. Nothing was saved.`);
          }}
          onSave={async (choice) => {
            const accounts = linksFrom(choice);
            const inst = result.link.institution;
            await link.mutateAsync({ publicToken: result.link.publicToken, ...(inst?.id ? { institutionId: inst.id } : {}), ...(inst?.name ? { institutionName: inst.name } : {}), accounts });
            setResult(null);
            say(accounts.length > 0 ? `${name} connected: ${plural(accounts.length, "account")}. Transactions arrive over the next few minutes.` : `${name} connected with no accounts chosen yet. Use Accounts on its row to choose.`);
          }}
        />
      ) : null}
    </>
  );
}

// ---- One login's actions ---------------------------------------------------------------------------------------------

export function FeedActions({ feed, memberId, openLink = defaultOpenLink, say }: { feed: FeedConnectionSummary; memberId: string | undefined; openLink?: OpenLink; say: Say }) {
  const api = useApi();
  const reconnected = useFeedReconnected();
  const unlink = useUnlinkFeed();
  const [busy, setBusy] = useState<string | undefined>();
  const [showAccounts, setShowAccounts] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeError, setRemoveError] = useState<string | undefined>();
  if (feed.provider !== "plaid" || feed.status === "disabled") return null;
  const mine = Boolean(memberId) && feed.ownerMemberId === memberId;

  async function reconnect() {
    try {
      setBusy("Opening Plaid…");
      const t = await api.feedLinkToken(feed.id);
      const r = await openLink(t.linkToken);
      if (r.kind === "exit") {
        if (r.message) say(r.message);
        return;
      }
      await reconnected.mutateAsync(feed.id);
      say(`${feed.institutionName} reconnected. A sync is queued; the re-link flag clears when it succeeds.`);
    } catch (e) {
      say(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <>
      {mine ? (
        <>
          <button type="button" className={`btn small${feed.needsRelink ? " primary" : ""}`} onClick={() => void reconnect()} disabled={busy !== undefined} title="Sign in to the bank again through Plaid; history and accounts stay">
            {busy ?? "Reconnect"}
          </button>
          <button type="button" className="btn small" onClick={() => setShowAccounts(true)}>
            Accounts
          </button>
          <button type="button" className="btn small" onClick={() => setConfirmRemove(true)}>
            Remove
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn small" onClick={() => setShowAccounts(true)}>
            View accounts
          </button>
          <span className="sub">Only {feed.ownerName} can change this login</span>
        </>
      )}
      {showAccounts ? <FeedAccountsDialog feed={feed} readOnly={!mine} onClose={() => setShowAccounts(false)} say={say} /> : null}
      <Dialog
        open={confirmRemove}
        title={`Remove ${feed.institutionName}?`}
        onClose={() => {
          setConfirmRemove(false);
          setRemoveError(undefined);
        }}
        testId="remove-login-dialog"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirmRemove(false)} disabled={unlink.isPending}>
              Keep it
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={unlink.isPending}
              onClick={() =>
                void unlink.mutateAsync(feed.id).then(
                  () => {
                    setConfirmRemove(false);
                    say(`${feed.institutionName} removed. Plaid's access has ended.`);
                  },
                  (e: unknown) => setRemoveError(errorMessage(e)),
                )
              }
            >
              Remove login
            </button>
          </>
        }
      >
        <p>Plaid's access to this login ends and its saved key is deleted. Transactions already imported stay in Homestead and BC.</p>
        <p className="sub">Its {plural(feed.accountCount, "account")} stop updating until they are connected again or fed from statement files.</p>
        {removeError ? (
          <div className="notice action" role="alert">
            {removeError}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

function FeedAccountsDialog({ feed, readOnly, onClose, say }: { feed: FeedConnectionSummary; readOnly: boolean; onClose: () => void; say: Say }) {
  const q = useFeedAccounts(feed.id);
  const household = useHouseholdAccounts();
  const connectedVia = useConnectedVia();
  const save = useSetFeedAccounts();
  const opts: MatchOptions = { institutionName: feed.institutionName, feedConnectionId: feed.id, connectedVia };
  const initial = useMemo(() => {
    if (!q.data) return {};
    const unmapped = q.data.accounts.filter((a) => !a.accountId);
    const taken = new Set(q.data.accounts.map((a) => a.accountId).filter(Boolean));
    const suggested = suggestMatches(unmapped, (household.data ?? []).filter((h) => !taken.has(h.id)), opts);
    return Object.fromEntries(q.data.accounts.map((a) => [a.plaidAccountId, a.accountId ?? (readOnly ? "" : (suggested[a.plaidAccountId] ?? ""))]));
    // opts is rebuilt each render; its parts are the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, household.data, readOnly, connectedVia]);

  if (q.isLoading || household.isLoading)
    return (
      <Dialog open title={`${feed.institutionName}: accounts`} onClose={onClose}>
        <div className="loading" role="status">
          Asking Plaid for this login's accounts…
        </div>
      </Dialog>
    );
  if (q.error)
    return (
      <Dialog open title={`${feed.institutionName}: accounts`} onClose={onClose}>
        <div className="notice action" role="alert">
          {errorMessage(q.error)}
        </div>
      </Dialog>
    );
  return (
    <MapAccountsDialog
      title={`${feed.institutionName}: accounts`}
      intro={readOnly ? <>What each bank account on {feed.ownerName}'s login feeds. Only {feed.ownerName} can change this.</> : <>Change where each bank account goes. A newly added account brings in its history; lines already in Homestead are not repeated.</>}
      institutionName={feed.institutionName}
      plaidAccounts={q.data?.accounts ?? []}
      household={household.data ?? []}
      opts={opts}
      initial={initial}
      readOnly={readOnly}
      saveLabel="Save accounts"
      cancelLabel={readOnly ? "Close" : "Cancel"}
      busy={save.isPending}
      onClose={onClose}
      onSave={async (choice) => {
        const r = await save.mutateAsync({ feedId: feed.id, accounts: linksFrom(choice) });
        onClose();
        say(r.attached > 0 ? `Saved. History for ${plural(r.attached, "newly added account")} is coming in now.` : r.detached > 0 ? `Saved. ${plural(r.detached, "account")} no longer fed by this login.` : "No changes.");
      }}
    />
  );
}

// ---- Mapping dialog -----------------------------------------------------------------------------------------------------

const KIND_WORDS: Record<string, string> = { checking: "checking", savings: "savings", share: "share", card: "card", line: "credit line", loan: "loan", mortgage: "mortgage", wallet: "wallet", cash: "cash" };

export interface MapAccountsDialogProps {
  title: string;
  intro?: ReactNode;
  institutionName: string | null;
  plaidAccounts: readonly BankLoginAccount[];
  household: readonly AccountSummary[];
  opts: MatchOptions;
  initial: Readonly<Record<string, string>>;
  readOnly?: boolean;
  saveLabel: string;
  cancelLabel: string;
  busy?: boolean;
  onSave: (choice: Record<string, string>) => Promise<void>;
  onClose: () => void;
}

export function MapAccountsDialog({ title, intro, plaidAccounts, household, opts, initial, readOnly, saveLabel, cancelLabel, busy, onSave, onClose }: MapAccountsDialogProps) {
  // Taken once, when the dialog opens: later refetches never undo what the person has chosen.
  const [choice, setChoice] = useState<Record<string, string>>(() => ({ ...initial }));
  const [error, setError] = useState<string | undefined>();
  const problems = mappingProblems(choice, household, opts);
  const chosen = Object.values(choice).filter(Boolean).length;

  async function save() {
    setError(undefined);
    try {
      await onSave(choice);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      testId="map-accounts-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          {readOnly ? null : (
            <button type="button" className="btn primary" onClick={() => void save()} disabled={busy || problems.length > 0} data-testid="save-mapping">
              {busy ? "Saving…" : saveLabel}
            </button>
          )}
        </>
      }
    >
      {intro ? <p>{intro}</p> : null}
      {plaidAccounts.length === 0 ? <p className="sub">Plaid returned no accounts for this login.</p> : null}
      <table className="data" data-testid="map-accounts-table">
        <thead>
          <tr>
            <th>Bank account</th>
            <th>Goes to</th>
          </tr>
        </thead>
        <tbody>
          {plaidAccounts.map((p) => {
            const ranked = rankCandidates(p, household, opts);
            const current = choice[p.plaidAccountId] ?? "";
            return (
              <tr key={p.plaidAccountId}>
                <td>
                  {p.name}
                  {p.mask ? <span className="mono"> ••{p.mask}</span> : null}
                  <span className="sub">{[p.type, p.subtype].filter(Boolean).join(" · ")}</span>
                </td>
                <td>
                  {readOnly ? (
                    household.find((h) => h.id === current)?.displayName ?? <span className="sub">Not brought in</span>
                  ) : (
                    <select aria-label={`Where ${p.name}${p.mask ? ` ending ${p.mask}` : ""} goes`} value={current} onChange={(e) => setChoice((c) => ({ ...c, [p.plaidAccountId]: e.target.value }))}>
                      <option value="">Don't bring in</option>
                      {ranked.map((h) => {
                        const taken = isTakenElsewhere(h, opts);
                        return (
                          <option key={h.id} value={h.id} disabled={taken && h.id !== current}>
                            {h.displayName}
                            {h.mask ? ` (${h.mask})` : ""} · {KIND_WORDS[h.kind] ?? h.kind}
                            {taken ? ` · connected through ${opts.connectedVia?.get(h.id)?.institutionName ?? "another login"}` : ""}
                          </option>
                        );
                      })}
                    </select>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {readOnly ? null : (
        <p className="sub">
          {plural(chosen, "account")} chosen. Loans and the mortgage stay on statements for now: leave them as "Don't bring in". Lines from before the opening balances are skipped.
        </p>
      )}
      {problems.map((m) => (
        <div key={m} className="notice action" role="alert">
          {m}
        </div>
      ))}
      {error ? (
        <div className="notice action" role="alert">
          {error}
        </div>
      ) : null}
    </Dialog>
  );
}
