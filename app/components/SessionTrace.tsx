"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ToolDetail, TraceItem } from "@/lib/scanner";

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

// Flatten a detail back to plain text — what the copy button puts on the
// clipboard, and what the filter box searches.
function detailText(d: ToolDetail): string {
  switch (d.type) {
    case "diff":
      return d.hunks
        .map(
          (h) =>
            `@@ -${h.oldStart} +${h.newStart} @@\n${h.lines.join("\n")}`
        )
        .join("\n");
    case "file":
      return d.content;
    case "bash":
      return [d.stdout, d.stderr].filter(Boolean).join("\n");
    case "agent":
      return d.prompt;
    case "list":
      return d.items.join("\n");
    case "text":
      return d.text;
  }
}

// What the expand toggle advertises, so it is worth clicking (or not).
function detailLabel(d: ToolDetail): string {
  switch (d.type) {
    case "diff":
      return `diff +${d.added} −${d.removed}`;
    case "file":
      return d.totalLines ? `${d.totalLines} lines` : "contents";
    case "bash":
      return d.stderr ? "output + stderr" : "output";
    case "agent":
      return "prompt";
    case "list":
      return `${d.total} paths`;
    case "text": {
      const lines = d.text.split("\n").length;
      return lines > 1 ? `${lines} lines` : "details";
    }
  }
}

// Copy is cheap to offer and was missing everywhere; keep the confirmation
// inline so it never moves the row.
function CopyButton({ text, title }: { text: string; title: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API needs a secure context; fall back to a scratch textarea.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {}
      ta.remove();
    }
    setDone(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1200);
  };

  return (
    <button
      type="button"
      className={`icon-btn ${done ? "ok" : ""}`}
      onClick={copy}
      title={title}
      aria-label={title}
    >
      {done ? "✓" : "⧉"}
    </button>
  );
}

function DiffView({ d, q }: { d: Extract<ToolDetail, { type: "diff" }>; q: string }) {
  return (
    <div className="diff">
      {d.hunks.map((h, i) => {
        let oldN = h.oldStart;
        let newN = h.newStart;
        return (
          <div key={i} className="diff-hunk">
            <div className="diff-line meta">
              <span className="ln" />
              <span className="ln" />
              <code>{`@@ -${h.oldStart} +${h.newStart} @@`}</code>
            </div>
            {h.lines.map((line, j) => {
              const sign = line[0];
              const cls = sign === "+" ? "add" : sign === "-" ? "del" : "ctx";
              const o = sign === "+" ? "" : oldN++;
              const n = sign === "-" ? "" : newN++;
              return (
                <div key={j} className={`diff-line ${cls}`}>
                  <span className="ln">{o}</span>
                  <span className="ln">{n}</span>
                  <code>{highlight(line, q)}</code>
                </div>
              );
            })}
          </div>
        );
      })}
      {d.truncated && <div className="detail-note">…diff truncated</div>}
    </div>
  );
}

function DetailView({ d, q }: { d: ToolDetail; q: string }) {
  switch (d.type) {
    case "diff":
      return <DiffView d={d} q={q} />;
    case "file":
      return (
        <div className="detail-body">
          <pre className="out">{highlight(d.content, q)}</pre>
          {d.truncated && <div className="detail-note">…truncated</div>}
        </div>
      );
    case "bash":
      return (
        <div className="detail-body">
          {d.interrupted && <div className="detail-note warn">interrupted</div>}
          {d.stdout && <pre className="out">{highlight(d.stdout, q)}</pre>}
          {d.stderr && (
            <>
              <div className="detail-note">stderr</div>
              <pre className="err">{highlight(d.stderr, q)}</pre>
            </>
          )}
          {!d.stdout && !d.stderr && (
            <div className="detail-note">(no output)</div>
          )}
          {d.truncated && <div className="detail-note">…truncated</div>}
        </div>
      );
    case "agent":
      return (
        <div className="detail-body">
          <div className="detail-meta">
            <span className="badge">{d.agentId}</span>
            {d.model && <span className="badge model">{d.model}</span>}
            {d.status && <span className="badge">{d.status}</span>}
          </div>
          <pre className="out">{highlight(d.prompt, q)}</pre>
          {d.truncated && <div className="detail-note">…truncated</div>}
        </div>
      );
    case "list":
      return (
        <div className="detail-body">
          <pre className="out">{highlight(d.items.join("\n"), q)}</pre>
          {d.truncated && (
            <div className="detail-note">…{d.total - d.items.length} more</div>
          )}
        </div>
      );
    case "text":
      return (
        <div className="detail-body">
          <pre className="out">{highlight(d.text, q)}</pre>
          {d.truncated && <div className="detail-note">…truncated</div>}
        </div>
      );
  }
}

// A short text result whose summary already is the whole payload has nothing
// left to expand into — don't offer a toggle that reveals the same line.
function expandable(item: TraceItem): ToolDetail | undefined {
  const d = item.detail;
  if (d?.type === "text" && d.text.trim() === item.text.trim()) return undefined;
  return d;
}

function roleLabel(item: TraceItem): string {
  if (item.kind === "tool") return `🔧 ${item.name ?? "tool"}`;
  if (item.kind === "tool_result") return `↳ ${item.name ?? "result"}`;
  // Numbering the turns you typed makes a jump land somewhere recognisable, and
  // tells the injected "user" traffic apart from the things you actually said.
  if (item.promptN) return `user · prompt ${item.promptN}`;
  return item.kind;
}

function clockTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// Everything the filter box should look through, including detail bodies the
// collapsed summary hides. Cached per item — items are immutable once streamed.
const searchCache = new WeakMap<TraceItem, string>();

function searchable(item: TraceItem): string {
  let s = searchCache.get(item);
  if (s === undefined) {
    s = `${item.text} ${item.name ?? ""} ${item.detail ? detailText(item.detail) : ""}`
      .toLowerCase();
    searchCache.set(item, s);
  }
  return s;
}

function TraceRow({
  item,
  idx,
  q,
  focused,
  open,
  onToggle,
}: {
  item: TraceItem;
  idx: number;
  q: string;
  focused: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const detail = expandable(item);
  const copyText = detail ? `${item.text}\n${detailText(detail)}` : item.text;
  return (
    <div
      data-idx={idx}
      className={`trace-item ${item.kind} ${focused ? "focused" : ""} ${
        item.error ? "errored" : ""
      }`}
    >
      <span className="trace-role">{roleLabel(item)}</span>
      <div className="trace-body">
        <div className="trace-line">
          <span className="trace-text">{highlight(item.text, q)}</span>
          {detail && (
            <button
              type="button"
              className={`detail-toggle ${open ? "open" : ""}`}
              onClick={onToggle}
              aria-expanded={open}
            >
              <span className="chevron">▸</span>
              {detailLabel(detail)}
            </button>
          )}
        </div>
        {detail && open && <DetailView d={detail} q={q} />}
      </div>
      <span className="trace-side">
        {item.ts > 0 && (
          <time
            className="trace-time"
            dateTime={new Date(item.ts).toISOString()}
            title={new Date(item.ts).toLocaleString()}
          >
            {clockTime(item.ts)}
          </time>
        )}
        <CopyButton text={copyText} title="Copy this entry" />
      </span>
    </div>
  );
}

export default function SessionTrace({
  project,
  sessionId,
  provider = "claude",
  focusText,
  focusPromptN,
}: {
  project: string;
  sessionId: string;
  provider?: "claude" | "codex";
  // When the trace is opened from a specific prompt, scroll to that turn
  // instead of tailing the bottom. The number is exact; the text is the
  // fallback for a transcript whose turns could not be numbered.
  focusText?: string | null;
  focusPromptN?: number | null;
}) {
  const [items, setItems] = useState<TraceItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  // Indices whose structured detail the user has expanded.
  const [openIdx, setOpenIdx] = useState<Set<number>>(new Set());
  const boxRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true); // auto-scroll unless the user scrolled up
  // Which item the focused prompt resolved to, so it can be scrolled to once
  // and highlighted while the user reads.
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const focusDone = useRef<string | null>(null);
  // Where the prompt walker last stopped, so next/prev resume from there.
  const promptCursor = useRef(-1);
  const [currentPrompt, setCurrentPrompt] = useState<number | null>(null);
  const scrollTick = useRef<number | null>(null);

  useEffect(() => {
    setItems([]);
    setFailed(false);
    setOpenIdx(new Set());
    setCurrentPrompt(null);
    promptCursor.current = -1;
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

  // Escape leaves fullscreen — the only way out that doesn't need the mouse.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Locate the focused prompt once its turn has streamed in.
  //
  // By number when the turns could be numbered — the text fallback matches on a
  // 60-character prefix and takes the first hit, which lands on the wrong turn
  // whenever two prompts open the same way ("address: ...", "in office view,
  // ..."), and that is common.
  useEffect(() => {
    const key = focusPromptN != null ? `#${focusPromptN}` : focusText;
    if (!key || focusDone.current === key || items.length === 0) return;
    let idx = -1;
    if (focusPromptN != null) {
      idx = items.findIndex((it) => it.promptN === focusPromptN);
    }
    if (idx === -1 && focusText) {
      const needle = focusText.replace(/…$/, "").slice(0, 60).toLowerCase();
      if (needle) {
        idx = items.findIndex(
          (it) =>
            it.kind === "user" &&
            it.text.replace(/\s+/g, " ").toLowerCase().includes(needle)
        );
      }
    }
    if (idx === -1) return;
    focusDone.current = key;
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
  }, [items, focusText, focusPromptN]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // One recompute per frame: scroll fires far faster than it can be useful.
    if (scrollTick.current !== null) return;
    scrollTick.current = requestAnimationFrame(() => {
      scrollTick.current = null;
      syncCurrent();
    });
  };

  const toggle = useCallback((idx: number) => {
    setOpenIdx((prev) => {
      const next = new Set(prev);
      if (!next.delete(idx)) next.add(idx);
      return next;
    });
  }, []);

  const q = filter.trim();
  // When filtering, show only the items that contain the keyword — including
  // matches inside a collapsed detail. Each entry keeps its index in `items`
  // so the focus target survives filtering.
  const shown = useMemo(() => {
    const all = items.map((item, idx) => ({ item, idx }));
    if (!q) return all;
    const needle = q.toLowerCase();
    return all.filter(({ item }) => searchable(item).includes(needle));
  }, [items, q]);

  const withDetail = useMemo(
    () => shown.filter(({ item }) => expandable(item)).map(({ idx }) => idx),
    [shown]
  );
  const allOpen = withDetail.length > 0 && withDetail.every((i) => openIdx.has(i));

  // Every turn you typed, in order. A long session is mostly tool traffic, so
  // stepping prompt to prompt is the only practical way to move through it.
  const promptRows = useMemo(
    () =>
      shown
        .filter(({ item }) => item.promptN)
        .map(({ idx, item }) => ({ idx, n: item.promptN as number })),
    [shown]
  );

  // Which prompt you are currently reading: the last one whose turn begins at
  // or above the middle of the box. The middle rather than the top because that
  // is where a focused prompt gets scrolled to — measuring at the top would
  // report the previous prompt for the very row being highlighted.
  //
  // Recomputed from live geometry rather than tracked, so expanding a diff or
  // streaming new rows can't desynchronise it.
  const syncCurrent = useCallback(() => {
    const box = boxRef.current;
    if (!box || promptRows.length === 0) return;
    const middle = box.getBoundingClientRect().top + box.clientHeight / 2;
    let cur = promptRows[0]; // above the first prompt you are still in its turn
    for (const p of promptRows) {
      const row = box.querySelector(`[data-idx="${p.idx}"]`);
      if (!row) continue;
      if (row.getBoundingClientRect().top > middle) break; // rows are in order
      cur = p;
    }
    setCurrentPrompt(cur.n);
    // Keep the walker anchored to what you are looking at, so "next" from a
    // scrolled position means the prompt after this one — not the one after
    // wherever the arrows last left off.
    promptCursor.current = cur.idx;
  }, [promptRows]);

  // Geometry moves under the counter for reasons other than scrolling: rows
  // stream in, the filter narrows the list, a diff expands. Recompute after any
  // of those, and drop a pending frame on unmount.
  useEffect(() => {
    const id = requestAnimationFrame(syncCurrent);
    return () => cancelAnimationFrame(id);
  }, [syncCurrent, items, openIdx]);

  useEffect(
    () => () => {
      if (scrollTick.current !== null) cancelAnimationFrame(scrollTick.current);
    },
    []
  );


  const jumpToPrompt = useCallback(
    (dir: 1 | -1) => {
      if (promptRows.length === 0) return;
      const from = promptCursor.current;
      // Wraps at both ends, so holding one arrow cycles the whole session.
      const next =
        dir === 1
          ? (promptRows.find((p) => p.idx > from) ?? promptRows[0])
          : ([...promptRows].reverse().find((p) => p.idx < from) ??
            promptRows[promptRows.length - 1]);
      promptCursor.current = next.idx;
      setFocusIdx(next.idx);
      setCurrentPrompt(next.n);
      followRef.current = false; // stop tailing, you're reading now
      const box = boxRef.current;
      const row = box?.querySelector(`[data-idx="${next.idx}"]`);
      if (!box || !row) return;
      // Centred, matching both how a focused prompt is scrolled to and how
      // `syncCurrent` measures. Centring the target also guarantees every later
      // prompt sits below the middle, so the counter lands on exactly this one.
      const delta =
        row.getBoundingClientRect().top - box.getBoundingClientRect().top;
      box.scrollTop += delta - (box.clientHeight - row.clientHeight) / 2;
    },
    [promptRows]
  );

  return (
    <div className={`trace-wrap ${fullscreen ? "fullscreen" : ""}`}>
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
        {promptRows.length > 0 && (
          <span className="prompt-nav">
            <button
              type="button"
              className="nav-btn sm"
              onClick={() => jumpToPrompt(-1)}
              title="Previous prompt"
              aria-label="Previous prompt"
            >
              ↑
            </button>
            <span
              className="prompt-count"
              title="Prompt you are currently reading, of the session's total"
            >
              {currentPrompt ?? promptRows[0].n}/{promptRows.length} prompt
              {promptRows.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              className="nav-btn sm"
              onClick={() => jumpToPrompt(1)}
              title="Next prompt"
              aria-label="Next prompt"
            >
              ↓
            </button>
          </span>
        )}
        {withDetail.length > 0 && (
          <button
            type="button"
            className="nav-btn sm"
            onClick={() =>
              setOpenIdx(allOpen ? new Set() : new Set(withDetail))
            }
            title={allOpen ? "Collapse every tool output" : "Expand every tool output"}
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
        <button
          type="button"
          className="nav-btn sm"
          onClick={() => setFullscreen((v) => !v)}
          title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
        >
          {fullscreen ? "✕ Close" : "⛶ Fullscreen"}
        </button>
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
          <TraceRow
            key={idx}
            item={item}
            idx={idx}
            q={q}
            focused={idx === focusIdx}
            open={openIdx.has(idx)}
            onToggle={() => toggle(idx)}
          />
        ))}
      </div>
    </div>
  );
}
