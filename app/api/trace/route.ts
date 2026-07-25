import fs from "fs";
import path from "path";
import os from "os";
import type { TraceItem } from "@/lib/scanner";
import { codexSessionPath, makeCodexParser } from "@/lib/codex";
import {
  MAX_SUMMARY,
  MAX_TEXT,
  detailSummary,
  inputDetail,
  resultDetail,
  toolSummary,
} from "@/lib/traceDetail";

export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 1500;

// A tool result names the call it answers (`tool_use_id`) but not the tool, so
// remember the names as the stream goes by. Stateful across polls, hence a
// factory: one parser per open connection.
function makeClaudeParser(): (lines: string[]) => TraceItem[] {
  const toolNames = new Map<string, string>();

  return (lines: string[]): TraceItem[] => {
    const items: TraceItem[] = [];
    for (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = entry?.timestamp ? Date.parse(entry.timestamp) : 0;
      const content = entry?.message?.content;

      if (entry?.type === "user") {
        if (typeof content === "string") {
          items.push({ kind: "user", text: content.slice(0, MAX_TEXT), ts });
        } else if (Array.isArray(content)) {
          // `toolUseResult` sits on the entry rather than inside the block, so
          // it belongs to the first tool_result here — in practice the only one.
          let detail = resultDetail(entry.toolUseResult);
          for (const c of content) {
            if (c?.type === "text" && c.text?.trim()) {
              items.push({ kind: "user", text: c.text.slice(0, MAX_TEXT), ts });
            } else if (c?.type === "tool_result") {
              const raw =
                typeof c.content === "string"
                  ? c.content
                  : Array.isArray(c.content)
                    ? c.content.map((p: any) => p?.text ?? "").join(" ")
                    : "";
              const flat = raw.replace(/\s+/g, " ").trim();
              const d = detail;
              detail = undefined;
              const text = (d ? detailSummary(d) : flat).slice(0, MAX_SUMMARY);
              if (!text && !d) continue;
              items.push({
                kind: "tool_result",
                name: toolNames.get(c.tool_use_id),
                text,
                ts,
                ...(d ? { detail: d } : {}),
                ...(c.is_error ? { error: true } : {}),
              });
            }
          }
        }
      } else if (entry?.type === "assistant" && Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === "text" && c.text?.trim()) {
            items.push({ kind: "assistant", text: c.text.slice(0, MAX_TEXT), ts });
          } else if (c?.type === "tool_use") {
            if (c.id) toolNames.set(c.id, c.name);
            const summary = toolSummary(c.input).slice(0, MAX_SUMMARY);
            const detail = inputDetail(c.input, summary);
            items.push({
              kind: "tool",
              name: c.name,
              text: summary,
              ts,
              ...(detail ? { detail } : {}),
            });
          }
        }
      }
    }
    return items;
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") === "codex" ? "codex" : "claude";
  const session = url.searchParams.get("session") ?? "";
  if (!/^[\w-]+$/.test(session)) {
    return new Response("bad request", { status: 400 });
  }

  let filePath: string;
  if (provider === "codex") {
    const found = codexSessionPath(session);
    if (!found) return new Response("not found", { status: 404 });
    filePath = found;
  } else {
    const project = url.searchParams.get("project") ?? "";
    if (!/^[\w-]+$/.test(project)) {
      return new Response("bad request", { status: 400 });
    }
    filePath = path.join(
      os.homedir(),
      ".claude",
      "projects",
      project,
      `${session}.jsonl`
    );
  }
  if (!fs.existsSync(filePath)) {
    return new Response("not found", { status: 404 });
  }
  const parseLines =
    provider === "codex" ? makeCodexParser() : makeClaudeParser();

  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | null = null;
  let offset = 0;

  // Read newly appended complete lines since the last offset.
  const readNewLines = (): string[] => {
    const size = fs.statSync(filePath).size;
    if (size <= offset) return [];
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(size - offset);
    const read = fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const text = buf.toString("utf8", 0, read);
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) return []; // no complete line yet
    offset += Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8");
    return text.slice(0, lastNewline).split("\n");
  };

  const stream = new ReadableStream({
    start(controller) {
      const cleanup = () => {
        if (interval) clearInterval(interval);
        interval = null;
        try {
          controller.close();
        } catch {}
      };

      const push = () => {
        try {
          const items = parseLines(readNewLines());
          if (items.length === 0) return;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(items)}\n\n`)
          );
        } catch {
          cleanup();
        }
      };

      push(); // full history on connect
      interval = setInterval(push, POLL_INTERVAL_MS);
      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      if (interval) clearInterval(interval);
      interval = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
