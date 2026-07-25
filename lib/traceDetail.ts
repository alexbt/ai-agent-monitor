import type { DiffHunk, ToolDetail } from "./scanner";

// Transcripts store a lot behind each tool call — `structuredPatch` for edits,
// `stdout`/`stderr` for shell commands, launch metadata for subagents. The
// trace panel shows a one-line summary and expands into the real payload, so
// the summary stays short while the detail is generous.
export const MAX_TEXT = 4000; // user / assistant message body
export const MAX_SUMMARY = 300; // collapsed one-line summary
export const MAX_DETAIL = 20_000; // expandable payload
const MAX_DIFF_LINES = 600;
const MAX_LIST = 300;

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function safeJson(v: unknown, indent = 0): string {
  try {
    return JSON.stringify(v, null, indent) ?? "";
  } catch {
    return "";
  }
}

function cut(s: string, max = MAX_DETAIL) {
  return { text: s.slice(0, max), truncated: s.length > max };
}

// The one field that best names what a tool call is doing, in priority order.
// Generic on purpose: MCP tools use their own input shapes and still tend to
// lead with one of these.
const SUMMARY_KEYS = [
  "command",
  "file_path",
  "filePath",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
  "path",
  "skill",
  "name",
];

export function toolSummary(input: unknown): string {
  if (typeof input === "string") return oneLine(input);
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return oneLine(v);
  }
  return oneLine(safeJson(o));
}

// Tool inputs carry multi-line strings (a file's contents, a subagent brief).
// Pretty-printed JSON escapes those into one unreadable line, so lay the keys
// out as a block instead.
export function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return safeJson(input, 2);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const val = typeof v === "string" ? v : safeJson(v, 2);
    if (!val) continue;
    parts.push(val.includes("\n") ? `${k}:\n${val}` : `${k}: ${val}`);
  }
  return parts.join("\n\n");
}

// A tool call's own input, as an expandable detail — only worth attaching when
// it holds more than the summary line already shows.
export function inputDetail(input: unknown, summary: string): ToolDetail | undefined {
  const full = formatInput(input);
  if (!full || oneLine(full) === summary) return undefined;
  return { type: "text", ...cut(full) };
}

function diffDetail(filePath: string, patch: any[]): ToolDetail {
  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let budget = MAX_DIFF_LINES;
  let truncated = false;
  for (const h of patch) {
    const all: string[] = Array.isArray(h?.lines)
      ? h.lines.map((l: unknown) => String(l))
      : [];
    for (const l of all) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
    if (budget <= 0) {
      truncated = true;
      continue;
    }
    const lines = all.slice(0, budget);
    if (lines.length < all.length) truncated = true;
    budget -= lines.length;
    hunks.push({
      oldStart: Number(h?.oldStart) || 1,
      newStart: Number(h?.newStart) || 1,
      lines,
    });
  }
  return { type: "diff", filePath, hunks, added, removed, truncated };
}

// Turn a transcript's `toolUseResult` into something renderable. Falls back to
// pretty JSON for shapes we don't know (MCP tools, future built-ins).
export function resultDetail(result: unknown): ToolDetail | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") {
    return result.trim() ? { type: "text", ...cut(result) } : undefined;
  }
  if (typeof result !== "object") return undefined;

  if (Array.isArray(result)) {
    const json = safeJson(result, 2);
    return json ? { type: "text", ...cut(json) } : undefined;
  }

  const r = result as Record<string, any>;

  // Edit / Write / NotebookEdit — the diff the tool applied.
  if (Array.isArray(r.structuredPatch) && r.structuredPatch.length > 0) {
    return diffDetail(String(r.filePath ?? ""), r.structuredPatch);
  }

  // Write creating a new file: no patch to show, so show what landed.
  if (r.type === "create" && typeof r.content === "string") {
    const body = cut(r.content);
    return {
      type: "file",
      filePath: String(r.filePath ?? ""),
      content: body.text,
      truncated: body.truncated,
      startLine: 1,
      totalLines: r.content.split("\n").length,
    };
  }

  // Read — the file slice that was pulled into context.
  if (r.file && typeof r.file === "object") {
    const f = r.file as Record<string, any>;
    if (typeof f.content === "string") {
      const body = cut(f.content);
      return {
        type: "file",
        filePath: String(f.filePath ?? ""),
        content: body.text,
        truncated: body.truncated,
        startLine: Number(f.startLine) || 1,
        totalLines: Number(f.totalLines) || null,
      };
    }
    if (f.base64) {
      const w = f.dimensions?.originalWidth;
      const h = f.dimensions?.originalHeight;
      const parts = [
        f.type ? String(f.type) : "image",
        w && h ? `${w}×${h}` : null,
        f.originalSize ? `${Math.round(Number(f.originalSize) / 1024)} KB` : null,
      ].filter(Boolean);
      return { type: "text", text: `[${parts.join(" · ")}]`, truncated: false };
    }
  }

  // Bash — stdout and stderr kept apart instead of concatenated.
  if (typeof r.stdout === "string" || typeof r.stderr === "string") {
    const out = cut(String(r.stdout ?? ""));
    const err = cut(String(r.stderr ?? ""));
    return {
      type: "bash",
      stdout: out.text,
      stderr: err.text,
      interrupted: r.interrupted === true,
      truncated: out.truncated || err.truncated,
    };
  }

  // Async subagent launch — the trace only ever showed the acknowledgement.
  if (typeof r.agentId === "string") {
    const brief = cut(String(r.prompt ?? ""));
    return {
      type: "agent",
      agentId: r.agentId,
      status: r.status ? String(r.status) : null,
      model: r.resolvedModel ? String(r.resolvedModel) : null,
      description: r.description ? String(r.description) : null,
      prompt: brief.text,
      truncated: brief.truncated,
    };
  }

  // Glob / Grep file lists.
  if (Array.isArray(r.filenames)) {
    const items = r.filenames.slice(0, MAX_LIST).map((f: unknown) => String(f));
    return {
      type: "list",
      items,
      total: Number(r.numFiles) || r.filenames.length,
      truncated: r.truncated === true || items.length < r.filenames.length,
    };
  }

  if (typeof r.content === "string" && r.content.trim()) {
    return { type: "text", ...cut(r.content) };
  }

  const json = safeJson(r, 2);
  return json && json !== "{}" ? { type: "text", ...cut(json) } : undefined;
}

function firstLine(s: string): string {
  for (const line of s.split("\n")) {
    if (line.trim()) return oneLine(line);
  }
  return "";
}

// The collapsed line for a row that has a detail: a purpose-built summary beats
// the first 300 characters of a flattened file dump.
export function detailSummary(d: ToolDetail): string {
  switch (d.type) {
    case "diff":
      return `${d.filePath} · +${d.added} −${d.removed}`;
    case "file": {
      const n = d.totalLines ? `${d.totalLines} lines` : "read";
      return `${d.filePath} · ${n}`;
    }
    case "bash": {
      const out = firstLine(d.stdout) || firstLine(d.stderr);
      const lines = d.stdout ? d.stdout.split("\n").length : 0;
      if (!out) return d.interrupted ? "interrupted" : "(no output)";
      return lines > 1 ? `${out} … (${lines} lines)` : out;
    }
    case "agent":
      return [d.description, d.model, d.status].filter(Boolean).join(" · ");
    case "list":
      return `${d.total} file${d.total === 1 ? "" : "s"} · ${d.items.slice(0, 3).join(", ")}`;
    case "text":
      return oneLine(d.text).slice(0, MAX_SUMMARY);
  }
}
