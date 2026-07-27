"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "./scanner";
import { needsYou, sessionLabel } from "./useSnapshot";

const STORAGE_KEY = "ai-agent-monitor:alerts";

// A monitor you have to look at only gets opened once you already suspect
// something is wrong. This watches the snapshot for sessions finishing their
// turn and says so — a desktop notification if you allowed one, and a count in
// the tab title either way, so it reads from a background tab.
//
// Opt-in: permission is requested when you switch it on, never on page load.
export function useAlerts(snapshot: Snapshot | null, enabledDefault = false) {
  const [enabled, setEnabled] = useState(enabledDefault);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "default"
  );
  // Sessions that have gone quiet since you last looked at the page.
  const [pending, setPending] = useState<string[]>([]);
  // Previous state per session, so only transitions fire — not every poll.
  const wasWaiting = useRef<Map<string, boolean> | null>(null);

  useEffect(() => {
    if (typeof Notification === "undefined") {
      setPermission("unsupported");
    } else {
      setPermission(Notification.permission);
    }
    try {
      setEnabled(localStorage.getItem(STORAGE_KEY) === "on");
    } catch {
      // private mode / storage disabled — stay off
    }
  }, []);

  const toggle = useCallback(async () => {
    if (enabled) {
      setEnabled(false);
      setPending([]);
      try {
        localStorage.setItem(STORAGE_KEY, "off");
      } catch {}
      return;
    }
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      // Only ever asked in response to this click.
      setPermission(await Notification.requestPermission());
    }
    setEnabled(true);
    try {
      localStorage.setItem(STORAGE_KEY, "on");
    } catch {}
  }, [enabled]);

  useEffect(() => {
    if (!snapshot) return;
    const now = new Map<string, boolean>();
    const justFinished: { id: string; label: string }[] = [];
    for (const project of snapshot.projects) {
      for (const s of project.sessions) {
        const waiting = needsYou(s);
        now.set(s.id, waiting);
        // First snapshot only establishes a baseline: everything already
        // waiting when you opened the page is not news.
        if (wasWaiting.current && waiting && wasWaiting.current.get(s.id) === false) {
          justFinished.push({ id: s.id, label: sessionLabel(s) });
        }
      }
    }
    wasWaiting.current = now;
    if (!enabled || justFinished.length === 0) return;

    setPending((prev) => [
      ...prev,
      ...justFinished.map((f) => f.id).filter((id) => !prev.includes(id)),
    ]);
    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      return; // the title badge still carries the signal
    }
    for (const f of justFinished) {
      try {
        // Tagging by session id means a session that finishes twice replaces
        // its own notification rather than stacking.
        new Notification("Waiting on you", { body: f.label, tag: f.id });
      } catch {}
    }
  }, [snapshot, enabled]);

  // Clear the badge as soon as the page is actually looked at.
  useEffect(() => {
    const seen = () => {
      if (document.visibilityState === "visible") setPending([]);
    };
    document.addEventListener("visibilitychange", seen);
    window.addEventListener("focus", seen);
    return () => {
      document.removeEventListener("visibilitychange", seen);
      window.removeEventListener("focus", seen);
    };
  }, []);

  // Prefix the tab title so a background tab still reports.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = pending.length > 0 ? `(${pending.length}) ${base}` : base;
  }, [pending]);

  return { enabled, toggle, permission, pending: pending.length };
}
