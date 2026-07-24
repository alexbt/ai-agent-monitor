"use client";

import { useEffect, useState } from "react";
import type { Prompt } from "@/lib/prompts";
import type { Provider } from "@/lib/useSnapshot";

export type { Prompt };

// How the list is broken up: one row per prompt (the default), or one row per
// session.
export type ViewMode = "prompts" | "sessions";

const MODE_KEY = "aam:viewMode";

// Kept in localStorage so the choice follows you between the Session Log and
// the Office View, and across reloads.
export function useViewMode(): [ViewMode, (m: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>("prompts");

  useEffect(() => {
    const saved = window.localStorage.getItem(MODE_KEY);
    if (saved === "prompts" || saved === "sessions") setMode(saved);
  }, []);

  const update = (m: ViewMode) => {
    setMode(m);
    try {
      window.localStorage.setItem(MODE_KEY, m);
    } catch {
      // private mode / storage disabled — the choice just won't persist
    }
  };

  return [mode, update];
}

// Prompts for every session, keyed by session id. Only polls while `enabled`,
// since building it walks whole transcripts on the server.
export function usePrompts(provider: Provider, enabled: boolean, pollMs = 5000) {
  const [prompts, setPrompts] = useState<Record<string, Prompt[]>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`/api/prompts?provider=${provider}`);
        const data = await res.json();
        if (!cancelled) {
          setPrompts(data.sessions ?? {});
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };

    load();
    const timer = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [provider, enabled, pollMs]);

  // Switching provider invalidates what we hold.
  useEffect(() => {
    setPrompts({});
    setLoaded(false);
  }, [provider]);

  return { prompts, loaded };
}
