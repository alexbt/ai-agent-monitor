import fs from "fs";
import path from "path";
import os from "os";
import type {
  Snapshot,
  ProjectInfo,
  SessionInfo,
  ToolDetail,
  TraceItem,
} from "./scanner";
import { typedPromptText } from "./prompts";
import {
  MAX_SUMMARY,
  MAX_TEXT,
  detailSummary,
  inputDetail,
  resultDetail,
  toolSummary,
} from "./traceDetail";

const CODEX_DIR = path.join(os.homedir(), ".codex");
const SESSIONS_DIR = path.join(CODEX_DIR, "sessions");
const INDEX_FILE = path.join(CODEX_DIR, "session_index.jsonl");

const ACTIVE_WINDOW_MS = 60_000;

// rollout-2026-04-23T06-33-49-<uuid>.jsonl
const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

// session id → rollout file path, refreshed on every scan
const pathById = new Map<string, string>();

// session_index.jsonl gives curated thread titles; reload when it changes
let indexCache: { mtime: number; titles: Map<string, string> } | null = null;

function threadTitles(): Map<string, string> {
  let mtime = 0;
  try {
    mtime = fs.statSync(INDEX_FILE).mtimeMs;
  } catch {
    return new Map();
  }
  if (indexCache && indexCache.mtime === mtime) return indexCache.titles;
  const titles = new Map<string, string>();
  try {
    for (const line of fs.readFileSync(INDEX_FILE, "utf8").split("\n")) {
      try {
        const e = JSON.parse(line);
        if (e?.id && e?.thread_name) titles.set(e.id, e.thread_name);
      } catch {}
    }
  } catch {}
  indexCache = { mtime, titles };
  return titles;
}

interface CodexHeader {
  id: string;
  cwd: string | null;
  prompt: string | null;
  model: string | null;
}

// cwd / first prompt never change once written — cache per file
const headerCache = new Map<string, CodexHeader>();

function readHeader(filePath: string): CodexHeader | null {
  const cached = headerCache.get(filePath);
  if (cached) return cached;

  let id: string | null = null;
  let cwd: string | null = null;
  let prompt: string | null = null;
  let model: string | null = null;
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString("utf8", 0, read).split("\n")) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type === "session_meta") {
        id = entry.payload?.id ?? null;
        cwd = entry.payload?.cwd ?? null;
        model = entry.payload?.model ?? model;
      } else if (entry?.type === "turn_context") {
        // each turn records the model it ran with
        model = entry.payload?.model ?? model;
      } else if (entry?.type === "event_msg" && entry.payload?.type === "user_message") {
        prompt ??=
          String(entry.payload.message ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
      }
      if (prompt !== null && model !== null) break;
    }
  } catch {
    return null;
  }
  if (!id) {
    id = path.basename(filePath).match(ROLLOUT_RE)?.[1] ?? null;
  }
  if (!id) return null;

  const header = { id, cwd, prompt, model };
  if (prompt !== null) headerCache.set(filePath, header);
  return header;
}

// The model can be switched mid-session, so the header's first turn_context is
// only a starting point — the newest one in the tail wins.
const modelCache = new Map<string, { mtime: number; model: string | null }>();

function readLatestModel(filePath: string, mtime: number, fallback: string | null): string | null {
  const cached = modelCache.get(filePath);
  if (cached && cached.mtime === mtime) return cached.model;

  let model: string | null = null;
  try {
    const stat = fs.statSync(filePath);
    const size = Math.min(64 * 1024, stat.size);
    const start = stat.size - size;
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(size);
    const read = fs.readSync(fd, buf, 0, size, start);
    fs.closeSync(fd);
    const lines = buf.toString("utf8", 0, read).split("\n");
    if (start > 0) lines.shift(); // first line is almost certainly truncated
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry?.type === "turn_context" && entry.payload?.model) {
          model = String(entry.payload.model);
        }
      } catch {
        continue;
      }
    }
  } catch {
    // unreadable — fall through to the header value
  }

  model ??= cached?.model ?? fallback;
  modelCache.set(filePath, { mtime, model });
  return model;
}

export function listRolloutFiles(dir = SESSIONS_DIR, depth = 0): string[] {
  if (depth > 4) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...listRolloutFiles(full, depth + 1));
    else if (ROLLOUT_RE.test(e.name)) files.push(full);
  }
  return files;
}

export function scanCodex(): Snapshot {
  const now = Date.now();
  const titles = threadTitles();
  const byCwd = new Map<string, SessionInfo[]>();

  for (const filePath of listRolloutFiles()) {
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch {
      continue;
    }
    const header = readHeader(filePath);
    if (!header) continue;
    pathById.set(header.id, filePath);

    const cwd = header.cwd ?? "(unknown)";
    const mtime = st.mtimeMs;
    const session: SessionInfo = {
      id: header.id,
      project: cwd,
      // Codex writes no LLM-generated title, so sessions fall back to the prompt.
      title: null,
      firstPrompt: titles.get(header.id) ?? header.prompt,
      gitBranch: null,
      cwd,
      agentName: null,
      teamName: null,
      model: readLatestModel(filePath, mtime, header.model),
      startedAt: st.birthtimeMs || mtime,
      lastActivity: mtime,
      active: now - mtime < ACTIVE_WINDOW_MS,
      // Codex publishes no process registry, so there is no truthful busy/idle
      // to report — null, not a guess. `active` is all this provider has.
      state: null,
      pid: null,
      agents: [], // Codex sessions are single-agent: no subagent transcripts
      comms: [],
    };
    const list = byCwd.get(cwd) ?? [];
    list.push(session);
    byCwd.set(cwd, list);
  }

  const projects: ProjectInfo[] = [];
  for (const [cwd, sessions] of byCwd) {
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    projects.push({
      name: cwd,
      displayName: cwd,
      lastActivity: sessions[0].lastActivity,
      sessions,
    });
  }
  projects.sort((a, b) => b.lastActivity - a.lastActivity);
  return { generatedAt: now, projects };
}

let lastScan: { at: number; snapshot: Snapshot } | null = null;

export function scanCodexCached(maxAgeMs = 1000): Snapshot {
  const now = Date.now();
  if (lastScan && now - lastScan.at < maxAgeMs) return lastScan.snapshot;
  const snapshot = scanCodex();
  lastScan = { at: now, snapshot };
  return snapshot;
}

export function codexSessionPath(id: string): string | null {
  if (!pathById.has(id)) scanCodex();
  return pathById.get(id) ?? null;
}

// Codex writes tool arguments and output as JSON strings; unwrap them so the
// shared detail formatter sees objects rather than one escaped line.
function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

// A shell call's output arrives as { output, metadata: { exit_code, … } }.
function codexResultDetail(output: unknown): ToolDetail | undefined {
  const parsed = parseMaybeJson(output);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, any>;
    if (typeof o.output === "string") {
      const exit = Number(o.metadata?.exit_code ?? 0);
      return resultDetail({
        stdout: exit === 0 ? o.output : "",
        stderr: exit === 0 ? "" : o.output,
        interrupted: o.metadata?.interrupted === true,
      });
    }
  }
  return resultDetail(parsed);
}

// Parse rollout lines into the same TraceItem shape the Claude trace uses.
// Stateful (it pairs outputs back to the call that produced them), so callers
// take a fresh parser per connection.
export function makeCodexParser(): (lines: string[]) => TraceItem[] {
  const toolNames = new Map<string, string>();
  // Same numbering the Claude parser applies, so the panel behaves identically.
  let promptCount = 0;

  return (lines: string[]): TraceItem[] => {
    const items: TraceItem[] = [];
    for (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "response_item") continue;
      const p = entry.payload;
      if (!p) continue;
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : 0;

      if (p.type === "message") {
        // system/developer-injected context also appears as messages — skip it
        if (p.role !== "user" && p.role !== "assistant") continue;
        const text = (Array.isArray(p.content) ? p.content : [])
          .map((c: any) => c?.text ?? "")
          .join("\n")
          .trim();
        if (!text || /^<(permissions|environment_context|user_instructions)/.test(text)) {
          continue;
        }
        const isPrompt =
          p.role === "user" && typedPromptText(entry, "codex") !== null;
        items.push({
          kind: p.role === "user" ? "user" : "assistant",
          text: text.slice(0, MAX_TEXT),
          ts,
          ...(isPrompt ? { promptN: ++promptCount } : {}),
        });
      } else if (p.type === "function_call") {
        const name = p.name ?? "tool";
        if (p.call_id) toolNames.set(String(p.call_id), name);
        const input = parseMaybeJson(p.arguments);
        const summary = toolSummary(input).slice(0, MAX_SUMMARY);
        const detail = inputDetail(input, summary);
        items.push({
          kind: "tool",
          name,
          text: summary,
          ts,
          ...(detail ? { detail } : {}),
        });
      } else if (p.type === "function_call_output") {
        const detail = codexResultDetail(p.output);
        const text = detail
          ? detailSummary(detail).slice(0, MAX_SUMMARY)
          : String(p.output ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY);
        if (!text && !detail) continue;
        items.push({
          kind: "tool_result",
          name: toolNames.get(String(p.call_id)),
          text,
          ts,
          ...(detail ? { detail } : {}),
        });
      }
    }
    return items;
  };
}
