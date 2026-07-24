"use client";

import { useEffect, useState } from "react";
import type { Snapshot } from "@/lib/scanner";

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

// "claude-opus-4-8" → "opus-4-8", "gpt-5-codex" → "gpt-5-codex".
// The vendor prefix and trailing release date are noise in a badge.
export function modelLabel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
