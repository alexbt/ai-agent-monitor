"use client";

import { useEffect, useState } from "react";
import type { SessionInfo, SessionState, Snapshot } from "@/lib/scanner";

export type Provider = "claude" | "codex";

export function useSnapshot(tickMs = 10_000, provider: Provider = "claude") {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setSnapshot(null);
    const es = new EventSource(`/api/stream?provider=${provider}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => setSnapshot(JSON.parse(e.data));
    const tick = setInterval(() => setNow(Date.now()), tickMs);
    return () => {
      es.close();
      clearInterval(tick);
    };
  }, [tickMs, provider]);

  return { snapshot, connected, now };
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

// Is the CLI actually doing something right now? Providers that publish no
// process registry (Codex) have only the mtime heuristic to fall back on.
export function isWorking(s: SessionInfo): boolean {
  return s.state ? s.state === "working" : s.active;
}

// Blocked: it stopped with a tool call unanswered and cannot continue without
// you. Deliberately narrower than "not generating" — a session that finished
// its turn is `idle`, not something demanding attention. Never true without an
// authoritative signal; guessing this one would be worse than staying quiet.
export function needsYou(s: SessionInfo): boolean {
  return s.state === "waiting";
}

// Running but not generating: either blocked on you, or finished and sitting at
// the prompt. Both mean "you could type into this terminal right now".
export function isLive(s: SessionInfo): boolean {
  return s.state === "working" || s.state === "waiting" || s.state === "idle";
}

// Class suffix for the row, dot and badge. Kept in one place so the Session Log
// and Office View can't drift apart on what a colour means.
export function stateClass(s: SessionInfo): SessionState | "unknown" {
  if (s.state) return s.state;
  return s.active ? "working" : "unknown";
}

export const STATE_LABEL: Record<SessionState, string> = {
  working: "working",
  waiting: "needs you",
  idle: "idle",
  ended: "ended",
};

// What to call a session in a list. Claude Code's own title when it has written
// one — it stays accurate for a long session in a way the opening prompt does
// not — then the opening prompt, then the id as a last resort.
export function sessionLabel(s: SessionInfo): string {
  return s.agentName ?? s.title ?? s.firstPrompt ?? shortId(s.id);
}

// "claude-opus-4-8" → "opus-4-8", "gpt-5-codex" → "gpt-5-codex".
// The vendor prefix and trailing release date are noise in a badge.
export function modelLabel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
