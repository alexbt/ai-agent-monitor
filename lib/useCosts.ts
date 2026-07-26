"use client";

import { useEffect, useState } from "react";
import type {
  ProjectTotals,
  PromptTotals,
  SessionTotals,
  StatusInfo,
} from "./status";
import type { Provider } from "./useSnapshot";

// Costs come from /api/status, which walks every transcript end to end — much
// heavier than the 2-second snapshot scan, and they barely move between polls.
const POLL_MS = 30_000;

export interface Costs {
  bySession: Map<string, SessionTotals>;
  byProject: Map<string, ProjectTotals>;
  /** Keyed by `promptId`, which `Prompt.id` carries for the join. */
  byPrompt: Map<string, PromptTotals>;
  /** Seven days — anything older than the status lookback has no entry. */
  loaded: boolean;
}

const EMPTY: Costs = {
  bySession: new Map(),
  byProject: new Map(),
  byPrompt: new Map(),
  loaded: false,
};

export function useCosts(provider: Provider): Costs {
  const [costs, setCosts] = useState<Costs>(EMPTY);

  useEffect(() => {
    setCosts(EMPTY);
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`/api/status?provider=${provider}`);
        if (!res.ok) throw new Error(String(res.status));
        const data: StatusInfo = await res.json();
        if (cancelled) return;
        setCosts({
          bySession: new Map(data.bySession.map((s) => [s.session, s])),
          byProject: new Map(data.byProject.map((p) => [p.project, p])),
          byPrompt: new Map((data.byPrompt ?? []).map((p) => [p.prompt, p])),
          loaded: true,
        });
      } catch {
        // leave whatever we had; the next poll retries
      }
    };

    load();
    const poll = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [provider]);

  return costs;
}

// Shared with the status page's tiles and tables.
export function fmtCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
