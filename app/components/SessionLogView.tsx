"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { SessionInfo, AgentInfo } from "@/lib/scanner";
import {
  useSnapshot,
  timeAgo,
  shortId,
  modelLabel,
  type Provider,
} from "@/lib/useSnapshot";
import SessionTrace from "./SessionTrace";

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

function SessionCard({
  session,
  now,
  provider,
  expanded,
  onToggle,
}: {
  session: SessionInfo;
  now: number;
  provider: Provider;
  expanded: boolean;
  onToggle: () => void;
}) {
  const activeAgents = session.agents.filter((a) => a.active).length;
  const officeHref = provider === "codex" ? "/codex/visual" : "/visual";
  return (
    <div
      id={`session-${session.id}`}
      className={`session ${session.active ? "active" : ""}`}
    >
      <div className="session-header clickable" onClick={onToggle}>
        <span className="dot" />
        <span className="session-prompt">
          {session.firstPrompt ?? "(no prompt yet)"}
        </span>
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
        <span className="time">{timeAgo(session.lastActivity, now)}</span>
        {session.agents.length > 0 && (
          <span className="agent-count">
            {activeAgents > 0 ? `${activeAgents} active / ` : ""}
            {session.agents.length} agents
          </span>
        )}
        <Link
          className="nav-btn sm"
          href={`${officeHref}?session=${encodeURIComponent(session.id)}`}
          title="Open this session in the Office View"
        >
          🏢 Office
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
  const [activeOnly, setActiveOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Session to scroll to once it renders, set when arriving via ?session=… from
  // the Office View. Cleared after the one-time scroll so manual expands don't
  // yank the viewport.
  const pendingScroll = useRef<string | null>(null);
  const [searchContent, setSearchContent] = useState(false);
  // Session ids whose transcript body matched, from the content-search endpoint.
  const [contentIds, setContentIds] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);

  const q = query.trim().toLowerCase();

  // Expand the session named in ?session=… when arriving from the Office View.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("session");
    if (id) {
      setExpandedId(id);
      pendingScroll.current = id;
    }
  }, []);

  // Once that focused session has rendered, scroll it into view exactly once.
  useEffect(() => {
    const id = pendingScroll.current;
    if (!id) return;
    const el = document.getElementById(`session-${id}`);
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

  const projects = (snapshot?.projects ?? [])
    .map((p) => ({
      ...p,
      sessions: p.sessions.filter(
        (s) =>
          (!activeOnly || s.active) &&
          (matchesDescription(s, p.displayName, q) ||
            (searchContent && contentIds.has(s.id)))
      ),
    }))
    .filter((p) => p.sessions.length > 0);

  const totalActive = (snapshot?.projects ?? []).reduce(
    (n, p) => n + p.sessions.filter((s) => s.active).length,
    0
  );

  return (
    <main>
      <header>
        <h1>
          Session Log <span className="provider-tag">{provider}</span>
        </h1>
        <div className="header-right">
          <label className="filter">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            Active only
          </label>
          <span className={`conn ${connected ? "ok" : "down"}`}>
            <span className="dot" />
            {connected ? `live · ${totalActive} active` : "reconnecting…"}
          </span>
        </div>
      </header>

      <div className="search-bar">
        <input
          type="search"
          className="search-input"
          placeholder="Search sessions by prompt, project, branch, model…"
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
      {snapshot && projects.length === 0 && (
        <p className="empty">
          {q
            ? `No sessions match “${query.trim()}”.`
            : activeOnly
              ? "No active sessions right now."
              : "No sessions found."}
        </p>
      )}

      {projects.map((project) => (
        <section key={project.name}>
          <h2>{project.displayName}</h2>
          {project.sessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              now={now}
              provider={provider}
              expanded={expandedId === s.id}
              onToggle={() =>
                setExpandedId((cur) => (cur === s.id ? null : s.id))
              }
            />
          ))}
        </section>
      ))}
    </main>
  );
}
