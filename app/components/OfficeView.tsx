"use client";

import { useEffect, useRef, useState } from "react";
import type { SessionInfo, CommEvent } from "@/lib/scanner";
import {
  useSnapshot,
  timeAgo,
  shortId,
  fmtDuration,
  modelLabel,
  type Provider,
} from "@/lib/useSnapshot";
import SessionTrace from "./SessionTrace";

const MAX_DESKS = 12;
const COLS = 3;
const WIDTH = 760;

interface DeskOccupant {
  key: string;
  label: string;
  active: boolean;
  title: string;
  startedAt: number;
  lastActivity: number;
  sub: string; // running-time line under the icon
  // arrow labels; null = no arrow in that direction
  toDesk: string | null; // main → occupant
  toMain: string | null; // occupant → main
}

function sessionLabel(s: SessionInfo, maxPrompt = 48): string {
  return (
    s.agentName ??
    (s.firstPrompt
      ? s.firstPrompt.slice(0, maxPrompt) +
        (s.firstPrompt.length > maxPrompt ? "…" : "")
      : shortId(s.id))
  );
}

function runningTime(
  active: boolean,
  startedAt: number,
  lastActivity: number,
  now: number
): string {
  return active
    ? `⏱ ${fmtDuration(now - startedAt)}`
    : `ran ${fmtDuration(Math.max(0, lastActivity - startedAt))}`;
}

function SessionDropdown({
  sessions,
  selected,
  onSelect,
  now,
}: {
  sessions: (SessionInfo & { projectName: string })[];
  selected: SessionInfo & { projectName: string };
  onSelect: (id: string) => void;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={ref}>
      <button
        className="dropdown-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`dot ${selected.active ? "on" : ""}`} />
        <span className="dropdown-label">{sessionLabel(selected)}</span>
        <span className="dropdown-sub">
          {selected.projectName.split("/").pop()} ·{" "}
          {selected.active
            ? "active now"
            : `active ${timeAgo(selected.lastActivity, now)}`}
        </span>
        <span className="dropdown-caret">▾</span>
      </button>
      {open && (
        <ul className="dropdown-menu" role="listbox">
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                role="option"
                aria-selected={s.id === selected.id}
                className={`dropdown-item ${s.id === selected.id ? "selected" : ""}`}
                onClick={() => {
                  onSelect(s.id);
                  setOpen(false);
                }}
                title={s.firstPrompt ?? s.id}
              >
                <span className={`dot ${s.active ? "on" : ""}`} />
                <span className="dropdown-label">{sessionLabel(s)}</span>
                <span className="dropdown-sub">
                  {s.projectName.split("/").pop()} ·{" "}
                  {s.active ? "active now" : `active ${timeAgo(s.lastActivity, now)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Person({
  x,
  y,
  active,
  label,
  sub,
  title,
}: {
  x: number;
  y: number;
  active: boolean;
  label: string;
  sub?: string;
  title?: string;
}) {
  return (
    <g
      transform={`translate(${x},${y})`}
      className={`person ${active ? "active" : "inactive"}`}
    >
      {title && <title>{title}</title>}
      <circle cx="0" cy="-16" r="9" className="head" />
      <path d="M -14 12 A 14 14 0 0 1 14 12 L 14 14 L -14 14 Z" className="body" />
      <text x="0" y="32" textAnchor="middle" className="person-label">
        {label.length > 20 ? label.slice(0, 19) + "…" : label}
      </text>
      {sub && (
        <text x="0" y="46" textAnchor="middle" className="person-time">
          {sub}
        </text>
      )}
    </g>
  );
}

function Desk({
  x,
  y,
  w = 130,
  h = 34,
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
}) {
  return (
    <g className="desk">
      <rect x={x - w / 2} y={y} width={w} height={h} rx="6" className="desk-top" />
      <rect x={x - w / 2 + 8} y={y + h} width="8" height="14" className="desk-leg" />
      <rect x={x + w / 2 - 16} y={y + h} width="8" height="14" className="desk-leg" />
    </g>
  );
}

function FlowArrow({
  id,
  fromX,
  fromY,
  toX,
  toY,
  kind,
  label,
}: {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  kind: "toDesk" | "toMain";
  label: string;
}) {
  const midX = (fromX + toX) / 2;
  const midY = (fromY + toY) / 2;
  // bow the curve sideways so opposite directions don't overlap
  const bend = kind === "toDesk" ? -26 : 26;
  const text = label.length > 32 ? label.slice(0, 31) + "…" : label;
  // keep the label upright: textPath renders along path direction, so draw
  // right-to-left paths reversed for the label copy
  const leftToRight = fromX <= toX;
  const d = `M ${fromX} ${fromY} Q ${midX + bend} ${midY} ${toX} ${toY}`;
  const dReversed = `M ${toX} ${toY} Q ${midX + bend} ${midY} ${fromX} ${fromY}`;
  return (
    <g>
      <path
        id={id}
        d={d}
        className={`flow ${kind === "toDesk" ? "flow-out" : "flow-in"}`}
        markerEnd={`url(#${kind === "toDesk" ? "arrow-out" : "arrow-in"})`}
      />
      <path id={`${id}-label`} d={leftToRight ? d : dReversed} fill="none" stroke="none" />
      <text className={`flow-label ${kind === "toDesk" ? "out" : "in"}`} dy="-5">
        <textPath href={`#${id}-label`} startOffset="50%" textAnchor="middle">
          {text}
        </textPath>
      </text>
    </g>
  );
}

function OfficeScene({
  mainLabel,
  mainSub,
  mainActive,
  mainTitle,
  desks,
}: {
  mainLabel: string;
  mainSub: string;
  mainActive: boolean;
  mainTitle: string;
  desks: DeskOccupant[];
}) {
  const shown = desks.slice(0, MAX_DESKS);
  const hidden = desks.length - shown.length;
  const rows = Math.max(1, Math.ceil(shown.length / COLS));
  const height = 240 + rows * 164 + 40;

  const deskPos = (i: number) => {
    const row = Math.floor(i / COLS);
    const inRow = Math.min(COLS, shown.length - row * COLS);
    const col = i % COLS;
    const rowWidth = (inRow - 1) * 220;
    return { x: WIDTH / 2 - rowWidth / 2 + col * 220, y: 240 + row * 164 };
  };

  const mainX = WIDTH / 2;
  const mainDeskBottom = 152; // just below the main desk legs

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      className="office"
      role="img"
      aria-label="Office view of session agents"
    >
      <defs>
        <marker
          id="arrow-out"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="arrowhead-out" />
        </marker>
        <marker
          id="arrow-in"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="arrowhead-in" />
        </marker>
      </defs>

      {/* floor */}
      <rect x="20" y="16" width={WIDTH - 40} height={height - 32} rx="18" className="floor" />
      {/* rug under the main desk */}
      <ellipse cx={mainX} cy={130} rx="170" ry="60" className="rug" />

      {/* communication arrows (under the furniture) */}
      {shown.map((desk, i) => {
        const { x, y } = deskPos(i);
        return (
          <g key={`flow-${desk.key}`}>
            {desk.toDesk !== null && (
              <FlowArrow
                id={`fl-${i}-out`}
                fromX={mainX - 30}
                fromY={mainDeskBottom}
                toX={x - 20}
                toY={y - 10}
                kind="toDesk"
                label={desk.toDesk}
              />
            )}
            {desk.toMain !== null && (
              <FlowArrow
                id={`fl-${i}-in`}
                fromX={x + 20}
                fromY={y - 10}
                toX={mainX + 30}
                toY={mainDeskBottom}
                kind="toMain"
                label={desk.toMain}
              />
            )}
          </g>
        );
      })}

      {/* main desk first, then the main agent so their nameplate sits on the desk */}
      <Desk x={mainX} y={96} w={200} h={40} />
      <Person
        x={mainX}
        y={72}
        active={mainActive}
        label={mainLabel}
        sub={mainSub}
        title={mainTitle}
      />

      {shown.map((desk, i) => {
        const { x, y } = deskPos(i);
        return (
          <g key={desk.key}>
            <Desk x={x} y={y} />
            <Person
              x={x}
              y={y + 82}
              active={desk.active}
              label={desk.label}
              sub={desk.sub}
              title={desk.title}
            />
          </g>
        );
      })}

      {shown.length === 0 && (
        <text x={WIDTH / 2} y={height / 2 + 40} textAnchor="middle" className="office-empty">
          No agents in this session yet — the main agent works alone.
        </text>
      )}
      {hidden > 0 && (
        <text x={WIDTH / 2} y={height - 14} textAnchor="middle" className="office-empty">
          +{hidden} more agents not shown
        </text>
      )}
    </svg>
  );
}

// Most recent comm event for a peer in a given direction.
function latestComm(
  comms: CommEvent[],
  peer: string,
  direction: "in" | "out"
): CommEvent | undefined {
  return comms
    .filter((e) => e.peer === peer && e.direction === direction)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
}

export default function OfficeView({ provider }: { provider: Provider }) {
  const { snapshot, connected, now } = useSnapshot(1000, provider);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sessions: (SessionInfo & { projectName: string })[] = (
    snapshot?.projects ?? []
  ).flatMap((p) => p.sessions.map((s) => ({ ...s, projectName: p.displayName })));
  sessions.sort((a, b) => b.lastActivity - a.lastActivity);

  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null;

  let desks: DeskOccupant[] = [];
  if (selected) {
    // Named teammate agents run as sibling sessions tagged with
    // teamName = "session-<first 8 chars of the spawning session id>".
    const teamTag = `session-${selected.id.slice(0, 8)}`;
    const teammates = sessions.filter((s) => s.teamName === teamTag);

    desks = [
      ...teammates.map((tm) => {
        const name = tm.agentName ?? shortId(tm.id);
        // outbound to teammate: our SendMessage/spawn, or their inbox receipt
        const out =
          latestComm(selected.comms, name, "out") ??
          tm.comms.filter((e) => e.direction === "in").sort((a, b) => b.timestamp - a.timestamp)[0];
        // inbound from teammate: our inbox receipt, or their SendMessage
        const inn =
          latestComm(selected.comms, name, "in") ??
          tm.comms.filter((e) => e.direction === "out").sort((a, b) => b.timestamp - a.timestamp)[0];
        return {
          key: `tm-${tm.id}`,
          label: name,
          active: tm.active,
          startedAt: tm.startedAt,
          lastActivity: tm.lastActivity,
          sub: runningTime(tm.active, tm.startedAt, tm.lastActivity, now),
          title: `teammate ${name}\n${tm.firstPrompt ?? ""}\nlast activity: ${timeAgo(
            tm.lastActivity,
            now
          )}`,
          toDesk: out ? (out.label ?? "message") : null,
          toMain: inn ? (inn.label ?? "message") : null,
        };
      }),
      ...selected.agents.map((agent) => ({
        key: `ag-${agent.id}`,
        label: agent.agentType ?? shortId(agent.id),
        active: agent.active,
        startedAt: agent.startedAt,
        lastActivity: agent.lastActivity,
        sub: runningTime(agent.active, agent.startedAt, agent.lastActivity, now),
        title: `${agent.description ?? agent.id}\nlast activity: ${timeAgo(
          agent.lastActivity,
          now
        )}`,
        toDesk: agent.flow === "toAgent" ? (agent.flowLabel ?? "instructions") : null,
        toMain: agent.flow === "toMain" ? (agent.flowLabel ?? "results") : null,
      })),
    ];
  }

  return (
    <main>
      <header>
        <h1>
          Office View <span className="provider-tag">{provider}</span>
        </h1>
        <span className={`conn ${connected ? "ok" : "down"}`}>
          <span className="dot" />
          {connected ? "live" : "reconnecting…"}
        </span>
      </header>

      {!snapshot && <p className="empty">Loading sessions…</p>}

      {sessions.length > 0 && selected && (
        <>
          <div className="session-picker">
            <label>Session</label>
            <SessionDropdown
              sessions={sessions}
              selected={selected}
              onSelect={setSelectedId}
              now={now}
            />
          </div>

          <div className="office-panel">
            <div className="office-title">
              <span className="mono">{shortId(selected.id)}</span>
              <span>{selected.projectName}</span>
              {selected.model && (
                <span className="badge model" title={selected.model}>
                  {modelLabel(selected.model)}
                </span>
              )}
              {selected.gitBranch && <span className="badge">{selected.gitBranch}</span>}
              <span className="legend">
                <span className="legend-item out">→ main to agent</span>
                <span className="legend-item in">→ agent to main</span>
              </span>
              <span className="time">
                {selected.active
                  ? "working now"
                  : `idle · ${timeAgo(selected.lastActivity, now)}`}
              </span>
            </div>
            <OfficeScene
              mainLabel={
                selected.agentName ??
                (provider === "codex" ? "codex" : "team-lead")
              }
              mainSub={runningTime(
                selected.active,
                selected.startedAt,
                selected.lastActivity,
                now
              )}
              mainActive={selected.active}
              mainTitle={selected.firstPrompt ?? selected.id}
              desks={desks}
            />
            <SessionTrace
              project={selected.project}
              sessionId={selected.id}
              provider={provider}
            />
          </div>
        </>
      )}
    </main>
  );
}
