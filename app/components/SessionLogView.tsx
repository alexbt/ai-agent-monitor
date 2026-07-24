"use client";

import { useState } from "react";
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
  return (
    <div className={`session ${session.active ? "active" : ""}`}>
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

export default function SessionLogView({ provider }: { provider: Provider }) {
  const { snapshot, connected, now } = useSnapshot(10_000, provider);
  const [activeOnly, setActiveOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const projects = (snapshot?.projects ?? [])
    .map((p) => ({
      ...p,
      sessions: activeOnly ? p.sessions.filter((s) => s.active) : p.sessions,
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

      {!snapshot && <p className="empty">Loading sessions…</p>}
      {snapshot && projects.length === 0 && (
        <p className="empty">
          {activeOnly ? "No active sessions right now." : "No sessions found."}
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
