import fs from "fs";
import path from "path";
import os from "os";
import { scanCached } from "@/lib/scanner";
import { scanCodexCached, codexSessionPath } from "@/lib/codex";

export const dynamic = "force-dynamic";

// Content search reads whole transcripts; past this only the tail is scanned.
const MAX_READ_BYTES = 8 * 1024 * 1024;

// Lower-cased transcript text, cached by file+mtime so searching as the user
// types re-reads a file only after it grows.
const contentCache = new Map<string, { mtime: number; lower: string }>();

function loweredContent(filePath: string): string {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return "";
  }
  const cached = contentCache.get(filePath);
  if (cached && cached.mtime === st.mtimeMs) return cached.lower;

  let text = "";
  try {
    if (st.size <= MAX_READ_BYTES) {
      text = fs.readFileSync(filePath, "utf8");
    } else {
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(MAX_READ_BYTES);
      const read = fs.readSync(fd, buf, 0, MAX_READ_BYTES, st.size - MAX_READ_BYTES);
      fs.closeSync(fd);
      text = buf.toString("utf8", 0, read);
    }
  } catch {
    text = "";
  }
  const lower = text.toLowerCase();
  contentCache.set(filePath, { mtime: st.mtimeMs, lower });
  return lower;
}

// Returns the session ids whose raw transcript contains the query. Enumerates
// sessions through the same scanners the rest of the app uses, then greps each
// session's file — the transcript body is never sent to the client, only the
// ids of matching sessions.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") === "codex" ? "codex" : "claude";
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  if (q.length < 2) return Response.json({ sessions: [] });

  const matches: string[] = [];

  if (provider === "codex") {
    for (const project of scanCodexCached().projects) {
      for (const s of project.sessions) {
        const fp = codexSessionPath(s.id);
        if (fp && loweredContent(fp).includes(q)) matches.push(s.id);
      }
    }
  } else {
    const base = path.join(os.homedir(), ".claude", "projects");
    for (const project of scanCached().projects) {
      for (const s of project.sessions) {
        const fp = path.join(base, s.project, `${s.id}.jsonl`);
        if (loweredContent(fp).includes(q)) matches.push(s.id);
      }
    }
  }

  return Response.json({ sessions: matches }, { headers: { "Cache-Control": "no-store" } });
}
