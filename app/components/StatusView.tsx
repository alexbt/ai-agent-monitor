"use client";

import { useEffect, useState } from "react";
import type { StatusInfo, TokenTotals, ModelTotals } from "@/lib/status";
import { fmtDuration, timeAgo, modelLabel, type Provider } from "@/lib/useSnapshot";

const POLL_MS = 10_000;

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

function TotalsRow({ label, totals }: { label: string; totals: TokenTotals }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{totals.turns.toLocaleString()}</td>
      <td className="num">{fmtTokens(totals.input)}</td>
      <td className="num">{fmtTokens(totals.output)}</td>
      <td className="num">{fmtTokens(totals.cacheWrite)}</td>
      <td className="num">{fmtTokens(totals.cacheRead)}</td>
      <td className="num strong">{fmtTokens(totals.total)}</td>
    </tr>
  );
}

function ModelRow({ row }: { row: ModelTotals }) {
  return (
    <tr>
      <td title={row.model}>
        <span className="badge model">{modelLabel(row.model)}</span>
      </td>
      <td className="num">{row.turns.toLocaleString()}</td>
      <td className="num">{fmtTokens(row.input)}</td>
      <td className="num">{fmtTokens(row.output)}</td>
      <td className="num">{fmtTokens(row.cacheWrite)}</td>
      <td className="num">{fmtTokens(row.cacheRead)}</td>
      <td className="num strong">{fmtTokens(row.total)}</td>
    </tr>
  );
}

export default function StatusView({ provider }: { provider: Provider }) {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());

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

  const win = status?.window ?? null;
  const quota = status?.quota ?? null;
  const last = status?.lastTurn ?? null;

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
          </div>

          <section>
            <h2>Usage by model · last 7 days</h2>
            {status.byModel.length === 0 ? (
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
                    <th>Model</th>
                    <th className="num">Requests</th>
                    <th className="num">Input</th>
                    <th className="num">Output</th>
                    <th className="num">Cache write</th>
                    <th className="num">Cache read</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {status.byModel.map((row) => (
                    <ModelRow key={row.model} row={row} />
                  ))}
                </tbody>
                <tfoot>
                  <TotalsRow label="Today" totals={status.today} />
                  <TotalsRow label="Last 7 days" totals={status.sevenDay} />
                </tfoot>
              </table>
            )}
            <p className="footnote">
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
