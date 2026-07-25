"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import type { StatusInfo, TokenTotals } from "@/lib/status";
import { fmtCost } from "@/lib/useCosts";
import {
  useSnapshot,
  fmtDuration,
  timeAgo,
  modelLabel,
  shortId,
  sessionLabel,
  type Provider,
} from "@/lib/useSnapshot";

const POLL_MS = 10_000;

// Long enough to spot the expensive ones without turning the page into a list.
const TOP_ROWS = 12;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Tile({
  label,
  value,
  sub,
  note,
  wide,
}: {
  label: string;
  value: string;
  sub?: string | null;
  note?: string | null;
  wide?: boolean;
}) {
  return (
    <div className={`tile ${wide ? "wide" : ""}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}

// Share of the window that has elapsed — a time bar, not a quota bar.
function WindowBar({ startedAt, resetsAt, now }: { startedAt: number; resetsAt: number; now: number }) {
  const span = resetsAt - startedAt;
  const pct = Math.min(100, Math.max(0, ((now - startedAt) / span) * 100));
  return (
    <div className="bar" role="img" aria-label={`${Math.round(pct)}% of the window elapsed`}>
      <div className="bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function QuotaBar({ percent }: { percent: number }) {
  const pct = Math.min(100, Math.max(0, percent));
  return (
    <div className="bar" role="img" aria-label={`${Math.round(pct)}% of quota used`}>
      <div className={`bar-fill ${pct >= 80 ? "hot" : ""}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// A "—" cost with the count of turns we couldn't price, for the tooltip.
function costCell(totals: TokenTotals) {
  if (totals.unpricedTurns > 0 && totals.cost === 0) {
    return (
      <td className="num" title={`${totals.unpricedTurns} unpriced request(s)`}>
        —
      </td>
    );
  }
  const suffix =
    totals.unpricedTurns > 0
      ? ` (+${totals.unpricedTurns} unpriced)`
      : "";
  return (
    <td
      className="num strong cost"
      title={`${fmtCost(totals.cost)}${suffix}`}
    >
      {fmtCost(totals.cost)}
      {totals.unpricedTurns > 0 && <span className="cost-flag">*</span>}
    </td>
  );
}

// Cache writes are billed by TTL, so the 1-hour share explains part of the
// cost that the token total alone doesn't.
function cacheWriteCell(totals: TokenTotals) {
  const pct = totals.cacheWrite
    ? Math.round((totals.cacheWrite1h / totals.cacheWrite) * 100)
    : 0;
  return (
    <td
      className="num"
      title={
        totals.cacheWrite
          ? `${fmtTokens(totals.cacheWrite1h)} at the 1h rate (2x input), ${fmtTokens(
              totals.cacheWrite - totals.cacheWrite1h
            )} at 5m (1.25x)`
          : undefined
      }
    >
      {fmtTokens(totals.cacheWrite)}
      {pct > 0 && <span className="sub-note"> {pct}% 1h</span>}
    </td>
  );
}

// Every breakdown shares these columns; only the first cell differs.
function TotalsCells({ totals }: { totals: TokenTotals }) {
  return (
    <>
      <td className="num">{totals.turns.toLocaleString()}</td>
      <td className="num">{fmtTokens(totals.input)}</td>
      <td className="num">{fmtTokens(totals.output)}</td>
      {cacheWriteCell(totals)}
      <td className="num">{fmtTokens(totals.cacheRead)}</td>
      <td className="num">{fmtTokens(totals.total)}</td>
      {costCell(totals)}
    </>
  );
}

function TotalsRow({
  label,
  totals,
  pad,
}: {
  label: string;
  totals: TokenTotals;
  // Keep the footer aligned when the breakdown adds a trailing actions column.
  pad?: boolean;
}) {
  return (
    <tr>
      <td>{label}</td>
      <TotalsCells totals={totals} />
      {pad && <td />}
    </tr>
  );
}

// The last two path segments — enough to tell projects apart without wrapping.
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}

type Breakdown = "model" | "project" | "session";

const BREAKDOWN_LABEL: Record<Breakdown, string> = {
  model: "Model",
  project: "Project",
  session: "Session",
};

export default function StatusView({ provider }: { provider: Provider }) {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // The same seven-day turns, re-keyed: "which model did I spend on" vs
  // "which project/session is burning money".
  const [breakdown, setBreakdown] = useState<Breakdown>("session");
  const [showAll, setShowAll] = useState(false);
  // Usage aggregates carry no session title — the snapshot does, so name the
  // rows from it rather than making the cost pass re-read every header.
  const { snapshot } = useSnapshot(30_000, provider);
  // What ?session=… (and optionally &prompt=…) named on arrival from another
  // view: the row to scroll to and highlight, and the prompt to hand back when
  // linking onward.
  const [focus, setFocus] = useState<{
    session: string;
    prompt: number | null;
  } | null>(null);
  const focusDone = useRef(false);

  useEffect(() => {
    setStatus(null);
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`/api/status?provider=${provider}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!cancelled) {
          setStatus(data);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    };

    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [provider]);

  // Read the deep link once. Sessions are the only breakdown a session id can
  // address, so switch to it rather than leaving the link looking broken.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("session");
    if (!id) return;
    const n = Number(params.get("prompt"));
    setFocus({ session: id, prompt: n > 0 ? n : null });
    setBreakdown("session");
  }, []);

  // Reveal the row if it sits past the top-N cut, then scroll to it exactly
  // once — later manual expands shouldn't yank the viewport.
  useEffect(() => {
    if (!focus || !status || focusDone.current) return;
    const idx = status.bySession.findIndex((s) => s.session === focus.session);
    // Nothing to scroll to: the session had no priced traffic in the lookback.
    if (idx === -1) {
      focusDone.current = true;
      return;
    }
    if (idx >= TOP_ROWS && !showAll) {
      setShowAll(true);
      return; // re-runs once the extra rows have rendered
    }
    focusDone.current = true;
    requestAnimationFrame(() => {
      document
        .getElementById(`usage-${focus.session}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [focus, status, showAll]);

  const win = status?.window ?? null;
  const quota = status?.quota ?? null;
  const last = status?.lastTurn ?? null;
  const logHref = provider === "codex" ? "/codex" : "/claude";
  const officeHref = provider === "codex" ? "/codex/visual" : "/visual";

  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of snapshot?.projects ?? []) {
      for (const s of p.sessions) map.set(s.id, sessionLabel(s));
    }
    return map;
  }, [snapshot]);

  // One shape for all three breakdowns: a first cell plus the shared totals.
  // Only sessions can be opened elsewhere, so only they carry `actions`.
  const rows = useMemo((): {
    key: string;
    cell: ReactNode;
    actions?: ReactNode;
    totals: TokenTotals;
  }[] => {
    if (!status) return [];
    if (breakdown === "model") {
      return status.byModel.map((r) => ({
        key: r.model,
        cell: (
          <span className="badge model" title={r.model}>
            {modelLabel(r.model)}
          </span>
        ),
        totals: r,
      }));
    }
    if (breakdown === "project") {
      return status.byProject.map((r) => ({
        key: r.project,
        cell: (
          <span className="row-label" title={r.label}>
            <span className="mono">{shortPath(r.label)}</span>
            <span className="row-sub">
              {r.sessions} session{r.sessions === 1 ? "" : "s"}
            </span>
          </span>
        ),
        totals: r,
      }));
    }
    return status.bySession.map((r) => {
      const title = titles.get(r.session);
      // Only the session we were deep-linked to has a prompt to hand back.
      const target =
        `session=${encodeURIComponent(r.session)}` +
        (focus?.session === r.session && focus.prompt
          ? `&prompt=${focus.prompt}`
          : "");
      return {
        key: r.session,
        cell: (
          <span
            className="row-label"
            title={`${title ? `${title}\n` : ""}${r.session}\n${r.projectLabel}`}
          >
            <span>{title ?? shortId(r.session)}</span>
            <span className="row-sub">
              <span className="mono">{shortId(r.session)}</span> ·{" "}
              {r.models.map((m) => modelLabel(m)).join(", ") || "model unknown"} ·{" "}
              {timeAgo(r.lastActivity, now)}
            </span>
          </span>
        ),
        actions: (
          <span className="row-actions">
            <Link
              className="nav-btn sm"
              href={`${officeHref}?${target}`}
              title="Open this session in the Office View"
            >
              🏢 Office
            </Link>
            <Link
              className="nav-btn sm"
              href={`${logHref}?${target}`}
              title="Open this session in the Session Log"
            >
              ☰ Log
            </Link>
          </span>
        ),
        totals: r,
      };
    });
  }, [status, breakdown, logHref, officeHref, now, titles, focus]);

  const visible = showAll ? rows : rows.slice(0, TOP_ROWS);
  const hasActions = breakdown === "session";
  // A session linked from another view but absent here spent nothing priced in
  // the lookback — say so rather than showing an unhighlighted table.
  const focusMissing =
    focus !== null &&
    status !== null &&
    !status.bySession.some((s) => s.session === focus.session);

  return (
    <main>
      <header>
        <h1>
          Status <span className="provider-tag">{provider}</span>
        </h1>
        <span className={`conn ${error ? "down" : "ok"}`}>
          <span className="dot" />
          {error ? "unavailable" : "live"}
        </span>
      </header>

      {!status && !error && <p className="empty">Reading local usage data…</p>}
      {error && <p className="empty">Could not read status from the local files.</p>}

      {status && (
        <>
          <div className="status-grid">
            <Tile
              label="Plan"
              value={status.plan?.label ?? "Unknown"}
              sub={status.plan?.email ?? undefined}
              note={
                status.plan
                  ? [
                      status.plan.billingType,
                      status.plan.subscriptionCreatedAt
                        ? `since ${new Date(status.plan.subscriptionCreatedAt).toLocaleDateString()}`
                        : null,
                      status.plan.extraUsageEnabled ? "extra usage on" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : provider === "codex"
                    ? "Codex does not record plan details locally"
                    : null
              }
            />

            <div className="tile">
              <div className="tile-label">
                {quota?.known ? quota.windowLabel ?? "Quota used" : "Remaining"}
              </div>
              {quota?.known && quota.usedPercent !== null ? (
                <>
                  <div className="tile-value">
                    {(100 - quota.usedPercent).toFixed(0)}
                    <span className="unit">% left</span>
                  </div>
                  <QuotaBar percent={quota.usedPercent} />
                  <div className="tile-sub">
                    {quota.resetsAt
                      ? `resets in ${fmtDuration(Math.max(0, quota.resetsAt - now))}`
                      : "reset time unknown"}
                  </div>
                  {(quota.limitName || quota.creditsNote) && (
                    <div className="tile-note">
                      {[quota.limitName, quota.creditsNote].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="tile-value dim">n/a locally</div>
                  {(quota?.limitName || quota?.creditsNote) && (
                    <div className="tile-sub">
                      {[quota?.limitName, quota?.creditsNote].filter(Boolean).join(" · ")}
                    </div>
                  )}
                  <div className="tile-note">{quota?.note}</div>
                </>
              )}
            </div>

            <div className="tile">
              <div className="tile-label">
                {status.provider === "codex" ? "Recent 5h window" : "Current 5h window"}
              </div>
              {win ? (
                <>
                  <div className="tile-value">
                    {fmtTokens(win.totals.total)}
                    <span className="unit">tokens</span>
                  </div>
                  <WindowBar startedAt={win.startedAt} resetsAt={win.resetsAt} now={now} />
                  <div className="tile-sub">
                    resets in {fmtDuration(Math.max(0, win.resetsAt - now))} ·{" "}
                    {fmtClock(win.resetsAt)}
                  </div>
                  <div className="tile-note">
                    {win.totals.turns.toLocaleString()} requests since{" "}
                    {fmtClock(win.startedAt)} · derived from local transcripts
                  </div>
                </>
              ) : (
                <>
                  <div className="tile-value dim">
                    {status.requests > 0 && !status.usageAvailable ? "not recorded" : "idle"}
                  </div>
                  <div className="tile-note">
                    {status.requests > 0 && !status.usageAvailable
                      ? `${status.requests.toLocaleString()} request${
                          status.requests === 1 ? "" : "s"
                        } in the last 7 days, but no token counts were written to the transcripts.`
                      : "No requests in the last 5 hours — the next one opens a new window."}
                  </div>
                </>
              )}
            </div>

            <div className="tile">
              <div className="tile-label">Last usage</div>
              {last ? (
                <>
                  <div className="tile-value">
                    {fmtTokens(last.tokens.total)}
                    <span className="unit">tokens</span>
                  </div>
                  <div className="tile-sub">
                    {last.model ? (
                      <span className="badge model" title={last.model}>
                        {modelLabel(last.model)}
                      </span>
                    ) : (
                      "model unknown"
                    )}{" "}
                    · {timeAgo(last.at, now)}
                  </div>
                  <div className="tile-note">
                    {fmtTokens(last.tokens.input)} in · {fmtTokens(last.tokens.output)} out ·{" "}
                    {fmtTokens(last.tokens.cacheWrite)} cache write ·{" "}
                    {fmtTokens(last.tokens.cacheRead)} cache read
                  </div>
                </>
              ) : status.lastModel ? (
                <>
                  <div className="tile-value dim">not recorded</div>
                  <div className="tile-sub">
                    <span className="badge model" title={status.lastModel.model}>
                      {modelLabel(status.lastModel.model)}
                    </span>{" "}
                    · {timeAgo(status.lastModel.at, now)}
                  </div>
                  <div className="tile-note">
                    Last model is known from the transcript, but the request carried no
                    token counts.
                  </div>
                </>
              ) : (
                <div className="tile-value dim">no activity</div>
              )}
            </div>

            <div className="tile">
              <div className="tile-label">Estimated spend</div>
              <div className="tile-value">
                {fmtCost(status.sevenDay.cost)}
                <span className="unit">7d</span>
              </div>
              <div className="tile-sub">
                {fmtCost(status.today.cost)} today
                {win ? ` · ${fmtCost(win.totals.cost)} this window` : ""}
              </div>
              {/* The one number the breakdown below exists to surface. */}
              {status.bySession[0] && status.bySession[0].cost > 0 && (
                <div className="tile-sub">
                  top session{" "}
                  <Link
                    className="mono session-link"
                    href={`${logHref}?session=${encodeURIComponent(status.bySession[0].session)}`}
                    title={
                      [titles.get(status.bySession[0].session), status.bySession[0].session]
                        .filter(Boolean)
                        .join("\n")
                    }
                  >
                    {shortId(status.bySession[0].session)}
                  </Link>{" "}
                  · {fmtCost(status.bySession[0].cost)}
                </div>
              )}
              <div className="tile-note">
                {status.sevenDay.unpricedTurns > 0
                  ? `Excludes ${status.sevenDay.unpricedTurns.toLocaleString()} request(s) on unpriced models. `
                  : ""}
                {status.costNote}
              </div>
            </div>
          </div>

          <section>
            <h2 className="with-actions">
              Usage · last 7 days
              <div className="seg" role="group" aria-label="Break usage down by">
                {(["session", "project", "model"] as const).map((b) => (
                  <button
                    key={b}
                    className={`seg-btn ${breakdown === b ? "on" : ""}`}
                    aria-pressed={breakdown === b}
                    onClick={() => {
                      setBreakdown(b);
                      setShowAll(false);
                    }}
                  >
                    {BREAKDOWN_LABEL[b]}
                  </button>
                ))}
              </div>
            </h2>
            {focusMissing && (
              <p className="footnote">
                Session <span className="mono">{shortId(focus.session)}</span> has
                no priced usage in the last 7 days, so it has no row here.
              </p>
            )}
            {rows.length === 0 ? (
              <p className="empty">
                {status.requests > 0
                  ? `${status.requests.toLocaleString()} request${
                      status.requests === 1 ? "" : "s"
                    } seen in the last 7 days, but the transcripts carry no token counts to break down.`
                  : "No requests recorded in the last 7 days."}
              </p>
            ) : (
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>{BREAKDOWN_LABEL[breakdown]}</th>
                    <th className="num">Requests</th>
                    <th className="num">Input</th>
                    <th className="num">Output</th>
                    <th className="num">Cache write</th>
                    <th className="num">Cache read</th>
                    <th className="num">Total</th>
                    <th className="num">Est. cost</th>
                    {hasActions && <th />}
                  </tr>
                </thead>
                <tbody>
                  {visible.map(({ key, cell, actions, totals }) => (
                    <tr
                      key={key}
                      id={`usage-${key}`}
                      className={focus?.session === key ? "focused" : ""}
                    >
                      <td>{cell}</td>
                      <TotalsCells totals={totals} />
                      {hasActions && <td>{actions}</td>}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <TotalsRow label="Today" totals={status.today} pad={hasActions} />
                  <TotalsRow
                    label="Last 7 days"
                    totals={status.sevenDay}
                    pad={hasActions}
                  />
                </tfoot>
              </table>
            )}
            {rows.length > TOP_ROWS && (
              <button
                type="button"
                className="nav-btn sm show-all"
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll
                  ? `Show top ${TOP_ROWS}`
                  : `Show all ${rows.length} ${breakdown}s`}
              </button>
            )}
            <p className="footnote">
              {breakdown === "session" &&
                "Subagent transcripts count against the session that spawned them. "}
              Aggregated from {status.filesScanned.toLocaleString()} local transcript
              {status.filesScanned === 1 ? "" : "s"}, including subagent runs. Updated{" "}
              {timeAgo(status.generatedAt, now)}.
            </p>
          </section>
        </>
      )}
    </main>
  );
}
