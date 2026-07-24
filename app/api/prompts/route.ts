import { scanCached } from "@/lib/scanner";
import { scanCodexCached } from "@/lib/codex";
import { claudePrompts, codexPrompts, type Prompt } from "@/lib/prompts";

export const dynamic = "force-dynamic";

// Every session's list of human-typed prompts, keyed by session id.
//
// This is deliberately its own endpoint rather than part of the 2s snapshot
// scan: collecting prompts means walking a transcript end to end, and the
// scanners only ever read a 64 KB head and tail. lib/prompts.ts parses each
// file incrementally (append-only, so only new bytes are read), but the first
// pass over a large session is still real work — so it happens only while the
// user is actually in Prompts mode.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") === "codex" ? "codex" : "claude";

  const bySession: Record<string, Prompt[]> = {};

  if (provider === "codex") {
    for (const project of scanCodexCached().projects) {
      for (const s of project.sessions) {
        bySession[s.id] = codexPrompts(s.id);
      }
    }
  } else {
    for (const project of scanCached().projects) {
      for (const s of project.sessions) {
        bySession[s.id] = claudePrompts(s.project, s.id);
      }
    }
  }

  return Response.json(
    { sessions: bySession },
    { headers: { "Cache-Control": "no-store" } }
  );
}
