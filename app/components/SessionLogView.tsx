"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { SessionInfo, AgentInfo } from "@/lib/scanner";
import { usePrompts, useViewMode, type Prompt } from "@/lib/usePrompts";
import {
  useSnapshot,
  timeAgo,
  shortId,
  modelLabel,
  isWorking,
  needsYou,
  stateClass,
  STATE_LABEL,
  type Provider,
} from "@/lib/useSnapshot";
import { useAlerts } from "@/lib/useAlerts";
import { useCosts, fmtCost, type Costs } from "@/lib/useCosts";
import SessionTrace from "./SessionTrace";

// Estimated spend over the status page's 7-day lookback — for a whole session,
// or for the single prompt that caused it. Absent when nothing priced landed in
// that window.
function CostBadge({
  totals,
  what,
}: {
  totals: { cost: number; turns: number } | undefined;
  what: "session" | "prompt";
}) {
  if (!totals || totals.cost === 0) return null;
  const scope =
    what === "prompt"
      ? "this prompt, including any agents it spawned"
      : "this session";
  return (
    <span
      className="badge cost"
      title={`Estimated spend for ${scope} · ${totals.turns.toLocaleString()} requests`}
    >
      {fmtCost(totals.cost)}
    </span>
  );
}

// Spelling out what each state means, since "idle" and "needs you" are a
// distinction the CLI's own busy/idle flag does not make.
function stateTitle(s: SessionInfo): string {
  const pid = s.pid ? ` (pid ${s.pid})` : "";
  if (s.state === "working") return `The CLI is running and generating${pid}`;
  if (s.state === "waiting")
    return `The CLI stopped with a tool call unanswered — it is blocked on a permission prompt or a question${pid}`;
  if (s.state === "idle")
    return `The CLI finished its turn and is back at the prompt${pid}`;
  return "No live process for this session";
}

function AgentRow({ agent, now }: { agent: AgentInfo; now: number }) {
  return (
    <li className={`agent ${agent.active ? "active" : "inactive"}`}>
      <span className="dot" />
      <span className="agent-type">{agent.agentType ?? "agent"}</span>
      <span className="agent-desc">
        {agent.description ?? shortId(agent.id)}
      </span>
      {agent.workflowId && (
        <span className="badge workflow">{agent.workflowId}</span>
      )}
      <span className="time">{timeAgo(agent.lastActivity, now)}</span>
    </li>
  );
}

// One row per prompt: the same session can appear many times, once for each
// thing you asked it. Expanding jumps the trace to that turn.
function PromptCard({
  session,
  prompt,
  total,
  now,
  provider,
  costs,
  expanded,
  onToggle,
}: {
  session: SessionInfo;
  prompt: Prompt;
  total: number;
  now: number;
  provider: Provider;
  costs: Costs;
  expanded: boolean;
  onToggle: () => void;
}) {
  const officeHref = provider === "codex" ? "/codex/visual" : "/visual";
  const statusHref = provider === "codex" ? "/codex/status" : "/status";
  const target = `session=${encodeURIComponent(session.id)}&prompt=${prompt.n}`;
  // "Working" and "needs you" describe what the session is doing *now*, which
  // is only ever its newest prompt. Older prompts in the same session finished
  // long ago and shouldn't inherit its state.
  const isLatest = prompt.n === total;
  const rowState = isLatest ? stateClass(session) : "ended";
  return (
    <div
      id={`prompt-${session.id}-${prompt.n}`}
      className={`session prompt-row state-${rowState}`}
    >
      <div className="session-header clickable" onClick={onToggle}>
        <span className="dot" />
        <span className="prompt-n">
          {prompt.n}/{total}
        </span>
        <span className="session-prompt">{prompt.text}</span>
        <span className={`chevron ${expanded ? "open" : ""}`}>▸</span>
      </div>
      <div className="session-meta">
        <span className="mono">{shortId(session.id)}</span>
        {session.model && (
          <span className="badge model" title={session.model}>
            {modelLabel(session.model)}
          </span>
        )}
        {session.gitBranch && <span className="badge">{session.gitBranch}</span>}
        <CostBadge
          totals={prompt.id ? costs.byPrompt.get(prompt.id) : undefined}
          what="prompt"
        />
        {isLatest && session.state && session.state !== "ended" && (
          <span
            className={`badge state ${session.state}`}
            title={stateTitle(session)}
          >
            {STATE_LABEL[session.state]}
          </span>
        )}
        <span className="time">
          {prompt.ts ? timeAgo(prompt.ts, now) : timeAgo(session.lastActivity, now)}
        </span>
        <Link
          className="nav-btn sm"
          href={`${officeHref}?${target}`}
          title="Open this prompt's session in the Office View"
        >
          🏢 Office
        </Link>
        <Link
          className="nav-btn sm"
          href={`${statusHref}?${target}`}
          title="Show this session's usage and cost in Status"
        >
          📊 Status
        </Link>
      </div>
      {expanded && (
        <SessionTrace
          project={session.project}
          sessionId={session.id}
          provider={provider}
          focusText={prompt.text}
        />
      )}
    </div>
  );
}

function SessionCard({
  session,
  now,
  provider,
  costs,
  expanded,
  onToggle,
}: {
  session: SessionInfo;
  now: number;
  provider: Provider;
  costs: Costs;
  expanded: boolean;
  onToggle: () => void;
}) {
  const activeAgents = session.agents.filter((a) => a.active).length;
  const officeHref = provider === "codex" ? "/codex/visual" : "/visual";
  const statusHref = provider === "codex" ? "/codex/status" : "/status";
  const target = `session=${encodeURIComponent(session.id)}`;
  return (
    <div
      id={`session-${session.id}`}
      className={`session state-${stateClass(session)}`}
    >
      <div className="session-header clickable" onClick={onToggle}>
        <span className="dot" />
        <span className="session-prompt">
          {session.title ?? session.firstPrompt ?? "(no prompt yet)"}
        </span>
        <span className={`chevron ${expanded ? "open" : ""}`}>▸</span>
      </div>
      {/* Only worth a second line when the title isn't already the prompt. */}
      {session.title && session.firstPrompt && (
        <div className="session-subprompt" title={session.firstPrompt}>
          {session.firstPrompt}
        </div>
      )}
      <div className="session-meta">
        <span className="mono">{shortId(session.id)}</span>
        {session.model && (
          <span className="badge model" title={session.model}>
            {modelLabel(session.model)}
          </span>
        )}
        {session.gitBranch && <span className="badge">{session.gitBranch}</span>}
        <CostBadge totals={costs.bySession.get(session.id)} what="session" />
        {/* Only stated when the process registry actually knows; "ended" is
            the resting state of most rows and would just be noise. */}
        {session.state && session.state !== "ended" && (
          <span
            className={`badge state ${session.state}`}
            title={stateTitle(session)}
          >
            {STATE_LABEL[session.state]}
          </span>
        )}
        <span className="time">{timeAgo(session.lastActivity, now)}</span>
        {session.agents.length > 0 && (
          <span className="agent-count">
            {activeAgents > 0 ? `${activeAgents} active / ` : ""}
            {session.agents.length} agents
          </span>
        )}
        <Link
          className="nav-btn sm"
          href={`${officeHref}?${target}`}
          title="Open this session in the Office View"
        >
          🏢 Office
        </Link>
        <Link
          className="nav-btn sm"
          href={`${statusHref}?${target}`}
          title="Show this session's usage and cost in Status"
        >
          📊 Status
        </Link>
      </div>
      {session.agents.length > 0 && (
        <ul className="agents">
          {session.agents.map((a) => (
            <AgentRow key={a.id} agent={a} now={now} />
          ))}
        </ul>
      )}
      {expanded && (
        <SessionTrace
          project={session.project}
          sessionId={session.id}
          provider={provider}
        />
      )}
    </div>
  );
}

// Does a session's description (prompt, project, branch, model, id, agent name)
// contain the query? The cheap client-side half of the search.
function matchesDescription(
  s: SessionInfo,
  projectName: string,
  q: string
): boolean {
  if (!q) return true;
  return [
    s.title,
    s.firstPrompt,
    s.gitBranch,
    s.model,
    s.agentName,
    s.id,
    projectName,
  ].some((v) => v?.toLowerCase().includes(q));
}

export default function SessionLogView({ provider }: { provider: Provider }) {
  const { snapshot, connected, now } = useSnapshot(10_000, provider);
  const costs = useCosts(provider);
  const alerts = useAlerts(snapshot);
  const [mode, setMode] = useViewMode();
  const { prompts, loaded: promptsLoaded } = usePrompts(
    provider,
    mode === "prompts"
  );
  const [filter, setFilter] = useState<"all" | "needs" | "working">("all");
  // In prompts mode this holds "<sessionId>#<n>" so each prompt row expands
  // independently; in sessions mode it is just the session id.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Element id to scroll to once it renders, set when arriving via ?session=…
  // from the Office View. Cleared after the one-time scroll so manual expands
  // don't yank the viewport.
  const pendingScroll = useRef<string | null>(null);
  // What that link pointed at, held until the mode and prompt list are known.
  const [deepLink, setDeepLink] = useState<{
    session: string;
    prompt: number | null;
  } | null>(null);
  const deepLinkDone = useRef(false);
  const [searchContent, setSearchContent] = useState(false);
  // Session ids whose transcript body matched, from the content-search endpoint.
  const [contentIds, setContentIds] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);

  const q = query.trim().toLowerCase();

  // Read ?session=… (and optionally &prompt=…) once on arrival from the Office
  // View. Resolving it is deferred: `mode` is still the pre-localStorage
  // default during this first pass, and prompts load asynchronously.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("session");
    if (!id) return;
    const n = Number(params.get("prompt"));
    setDeepLink({ session: id, prompt: n > 0 ? n : null });
  }, []);

  // Expand what the link named. A session id alone can't address a row in
  // prompts mode — rows are keyed "<id>#<n>" — so wait for that session's
  // prompts and fall back to its most recent one.
  useEffect(() => {
    if (!deepLink || deepLinkDone.current) return;
    if (mode === "sessions") {
      setExpandedId(deepLink.session);
      pendingScroll.current = `session-${deepLink.session}`;
      deepLinkDone.current = true;
      return;
    }
    const list = prompts[deepLink.session];
    if (!list?.length) {
      // Nothing to expand for a session with no typed prompts — stop waiting
      // once we know the list is complete rather than retrying forever.
      if (promptsLoaded) deepLinkDone.current = true;
      return;
    }
    const n = deepLink.prompt ?? list[list.length - 1].n;
    setExpandedId(`${deepLink.session}#${n}`);
    pendingScroll.current = `prompt-${deepLink.session}-${n}`;
    deepLinkDone.current = true;
  }, [deepLink, mode, prompts, promptsLoaded]);

  // Once the focused row has rendered, scroll it into view exactly once.
  useEffect(() => {
    const elId = pendingScroll.current;
    if (!elId) return;
    const el = document.getElementById(elId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      pendingScroll.current = null;
    }
  });

  // Content search hits the server (it greps the transcript files), so debounce
  // it and only run when the box is ticked and the query is at least 2 chars.
  useEffect(() => {
    if (!searchContent || q.length < 2) {
      setContentIds(new Set());
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/search?provider=${provider}&q=${encodeURIComponent(q)}`
        );
        const data = await res.json();
        if (!cancelled) setContentIds(new Set<string>(data.sessions ?? []));
      } catch {
        if (!cancelled) setContentIds(new Set());
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, searchContent, provider]);

  const passesFilter = (s: SessionInfo) =>
    filter === "all"
      ? true
      : filter === "needs"
        ? needsYou(s)
        : isWorking(s);

  const projects = (snapshot?.projects ?? [])
    .map((p) => ({
      ...p,
      sessions: p.sessions.filter(
        (s) =>
          passesFilter(s) &&
          (matchesDescription(s, p.displayName, q) ||
            (searchContent && contentIds.has(s.id)))
      ),
    }))
    .filter((p) => p.sessions.length > 0);

  // Prompts mode: one row per prompt, newest first within each project. The
  // search box matches the prompt itself here, which is more useful than
  // matching the session it happens to live in.
  const promptProjects = (snapshot?.projects ?? [])
    .map((p) => ({
      ...p,
      rows: p.sessions
        .filter(passesFilter)
        .flatMap((s) => {
          const list = prompts[s.id] ?? [];
          // A session's live state belongs to its newest prompt — the earlier
          // ones already finished — so filtering on that state shows just that
          // row rather than dragging the session's whole history along.
          const scoped = filter === "all" ? list : list.slice(-1);
          return scoped
            .filter(
              (pr) =>
                !q ||
                pr.text.toLowerCase().includes(q) ||
                matchesDescription(s, p.displayName, q)
            )
            .map((pr) => ({ session: s, prompt: pr, total: list.length }));
        })
        .sort(
          (a, b) =>
            (b.prompt.ts || b.session.lastActivity) -
            (a.prompt.ts || a.session.lastActivity)
        ),
    }))
    .filter((p) => p.rows.length > 0);

  const totalPrompts = promptProjects.reduce((n, p) => n + p.rows.length, 0);

  const allSessions = (snapshot?.projects ?? []).flatMap((p) => p.sessions);
  const totalWorking = allSessions.filter(isWorking).length;
  const totalNeedsYou = allSessions.filter(needsYou).length;

  // Seven-day spend for a project heading, or "" when nothing priced landed in
  // that window (an archive of old sessions shouldn't claim it cost $0.00).
  const projectCost = (name: string): string => {
    const totals = costs.byProject.get(name);
    return totals && totals.cost > 0 ? `${fmtCost(totals.cost)} · 7d` : "";
  };

  return (
    <main>
      <header>
        <h1>
          Session Log <span className="provider-tag">{provider}</span>
        </h1>
        <div className="header-right">
          <div className="seg" role="group" aria-label="List mode">
            {(["prompts", "sessions"] as const).map((m) => (
              <button
                key={m}
                className={`seg-btn ${mode === m ? "on" : ""}`}
                aria-pressed={mode === m}
                onClick={() => {
                  setMode(m);
                  setExpandedId(null);
                }}
                title={
                  m === "sessions"
                    ? "One row per session"
                    : "One row per prompt — a session appears once for each thing you asked it"
                }
              >
                {m === "sessions" ? "Sessions" : "Prompts"}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Filter sessions">
            {(["all", "needs", "working"] as const).map((f) => (
              <button
                key={f}
                className={`seg-btn ${filter === f ? "on" : ""} ${
                  f === "needs" && totalNeedsYou > 0 ? "alert" : ""
                }`}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                title={
                  f === "needs"
                    ? "Sessions whose CLI has finished its turn and is waiting for you"
                    : f === "working"
                      ? "Sessions whose CLI is running and busy"
                      : "Every session"
                }
              >
                {f === "all"
                  ? "All"
                  : f === "working"
                    ? "Working"
                    : `Needs you${totalNeedsYou > 0 ? ` ${totalNeedsYou}` : ""}`}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`icon-toggle ${alerts.enabled ? "on" : ""}`}
            onClick={alerts.toggle}
            aria-pressed={alerts.enabled}
            title={
              alerts.permission === "unsupported"
                ? "This browser has no notification support — the tab title still counts finished sessions"
                : alerts.enabled
                  ? alerts.permission === "granted"
                    ? "Notifying when a session finishes its turn"
                    : "Counting finished sessions in the tab title (notifications were blocked)"
                  : "Tell me when a session finishes its turn"
            }
          >
            {alerts.enabled ? "🔔" : "🔕"}
          </button>
          <span className={`conn ${connected ? "ok" : "down"}`}>
            <span className="dot" />
            {connected
              ? mode === "prompts"
                ? `live · ${totalPrompts} prompts`
                : `live · ${totalWorking} working${
                    totalNeedsYou > 0 ? ` · ${totalNeedsYou} needs you` : ""
                  }`
              : "reconnecting…"}
          </span>
        </div>
      </header>

      <div className="search-bar">
        <input
          type="search"
          className="search-input"
          placeholder={
            mode === "prompts"
              ? "Search prompts…"
              : "Search sessions by prompt, project, branch, model…"
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="filter">
          <input
            type="checkbox"
            checked={searchContent}
            onChange={(e) => setSearchContent(e.target.checked)}
          />
          Search in content
        </label>
        {searchContent && searching && (
          <span className="search-status">searching…</span>
        )}
      </div>

      {!snapshot && <p className="empty">Loading sessions…</p>}
      {snapshot && mode === "prompts" && !promptsLoaded && (
        <p className="empty">Reading prompts…</p>
      )}
      {snapshot &&
        (mode === "sessions"
          ? projects.length === 0
          : promptsLoaded && promptProjects.length === 0) && (
          <p className="empty">
            {q
              ? `No ${mode === "prompts" ? "prompts" : "sessions"} match “${query.trim()}”.`
              : filter === "needs"
                ? "Nothing is waiting on you."
                : filter === "working"
                  ? "Nothing is running right now."
                  : `No ${mode === "prompts" ? "prompts" : "sessions"} found.`}
          </p>
        )}

      {mode === "sessions" &&
        projects.map((project) => (
          <section key={project.name}>
            <h2>
              {project.displayName}
              <span className="section-count">
                {projectCost(project.name)}
              </span>
            </h2>
            {project.sessions.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                now={now}
                provider={provider}
                costs={costs}
                expanded={expandedId === s.id}
                onToggle={() =>
                  setExpandedId((cur) => (cur === s.id ? null : s.id))
                }
              />
            ))}
          </section>
        ))}

      {mode === "prompts" &&
        promptProjects.map((project) => (
          <section key={project.name}>
            <h2>
              {project.displayName}
              <span className="section-count">
                {project.rows.length} prompts
                {projectCost(project.name) && ` · ${projectCost(project.name)}`}
              </span>
            </h2>
            {project.rows.map(({ session, prompt, total }) => {
              const key = `${session.id}#${prompt.n}`;
              return (
                <PromptCard
                  key={key}
                  session={session}
                  prompt={prompt}
                  total={total}
                  now={now}
                  provider={provider}
                  costs={costs}
                  expanded={expandedId === key}
                  onToggle={() =>
                    setExpandedId((cur) => (cur === key ? null : key))
                  }
                />
              );
            })}
          </section>
        ))}
    </main>
  );
}
