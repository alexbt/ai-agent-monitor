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
}: {
  project: string;
  sessionId: string;
  provider?: "claude" | "codex";
}) {
  const [items, setItems] = useState<TraceItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true); // auto-scroll unless the user scrolled up

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

  useEffect(() => {
    const el = boxRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const q = filter.trim();
  // When filtering, show only the items that contain the keyword.
  const shown = useMemo(() => {
    if (!q) return items;
    const needle = q.toLowerCase();
    return items.filter((it) =>
      `${it.text} ${it.name ?? ""}`.toLowerCase().includes(needle)
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
        {shown.map((item, i) => (
          <div key={i} className={`trace-item ${item.kind}`}>
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
