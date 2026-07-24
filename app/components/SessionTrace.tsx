"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TraceItem } from "@/lib/scanner";

// Wrap every case-insensitive occurrence of `q` in the text with <mark>.
function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  let idx = lower.indexOf(needle);
  while (idx !== -1) {
    if (idx > from) out.push(text.slice(from, idx));
    out.push(
      <mark key={idx} className="hl">
        {text.slice(idx, idx + needle.length)}
      </mark>
    );
    from = idx + needle.length;
    idx = lower.indexOf(needle, from);
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

export default function SessionTrace({
  project,
  sessionId,
  provider = "claude",
  focusText,
}: {
  project: string;
  sessionId: string;
  provider?: "claude" | "codex";
  // When the trace is opened from a specific prompt, scroll to that turn
  // instead of tailing the bottom.
  focusText?: string | null;
}) {
  const [items, setItems] = useState<TraceItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true); // auto-scroll unless the user scrolled up
  // Which item the focused prompt resolved to, so it can be scrolled to once
  // and highlighted while the user reads.
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const focusDone = useRef<string | null>(null);

  useEffect(() => {
    setItems([]);
    setFailed(false);
    followRef.current = true;
    const es = new EventSource(
      provider === "codex"
        ? `/api/trace?provider=codex&session=${encodeURIComponent(sessionId)}`
        : `/api/trace?project=${encodeURIComponent(project)}&session=${encodeURIComponent(sessionId)}`
    );
    es.onmessage = (e) => setItems((prev) => [...prev, ...JSON.parse(e.data)]);
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setFailed(true);
    };
    return () => es.close();
  }, [project, sessionId, provider]);

  // A new focus target means: stop tailing and go find that turn.
  useEffect(() => {
    if (focusText && focusDone.current !== focusText) {
      followRef.current = false;
      setFocusIdx(null);
    }
  }, [focusText]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  // Locate the focused prompt once its turn has streamed in. Prompt text is
  // whitespace-collapsed and truncated for display, so match on a prefix of it.
  useEffect(() => {
    if (!focusText || focusDone.current === focusText || items.length === 0) {
      return;
    }
    const needle = focusText.replace(/…$/, "").slice(0, 60).toLowerCase();
    if (!needle) return;
    const idx = items.findIndex(
      (it) =>
        it.kind === "user" &&
        it.text.replace(/\s+/g, " ").toLowerCase().includes(needle)
    );
    if (idx === -1) return;
    focusDone.current = focusText;
    setFocusIdx(idx);
    // Wait for the row to render before scrolling to it. Only the trace box
    // scrolls: scrollIntoView would also scroll every ancestor, which in the
    // Office View drags the page down and pushes the scene out of view.
    requestAnimationFrame(() => {
      const box = boxRef.current;
      const row = box?.querySelector(`[data-idx="${idx}"]`);
      if (!box || !row) return;
      const delta = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
      box.scrollTop += delta - (box.clientHeight - row.clientHeight) / 2;
    });
  }, [items, focusText]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const q = filter.trim();
  // When filtering, show only the items that contain the keyword. Each entry
  // keeps its index in `items` so the focus target survives filtering.
  const shown = useMemo(() => {
    const all = items.map((item, idx) => ({ item, idx }));
    if (!q) return all;
    const needle = q.toLowerCase();
    return all.filter(({ item }) =>
      `${item.text} ${item.name ?? ""}`.toLowerCase().includes(needle)
    );
  }, [items, q]);

  return (
    <>
      <div className="trace-search">
        <input
          type="search"
          className="search-input sm"
          placeholder="Filter this session's content…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {q && (
          <span className="search-status">
            {shown.length} match{shown.length === 1 ? "" : "es"}
          </span>
        )}
      </div>
      <div className="trace" ref={boxRef} onScroll={onScroll}>
        {items.length === 0 && (
          <div className="trace-empty">
            {failed ? "Could not load trace." : "Loading trace…"}
          </div>
        )}
        {items.length > 0 && shown.length === 0 && (
          <div className="trace-empty">No lines match “{q}”.</div>
        )}
        {shown.map(({ item, idx }) => (
          <div
            key={idx}
            data-idx={idx}
            className={`trace-item ${item.kind} ${idx === focusIdx ? "focused" : ""}`}
          >
            <span className="trace-role">
              {item.kind === "tool" ? `🔧 ${item.name}` : item.kind}
            </span>
            <span className="trace-text">{highlight(item.text, q)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
