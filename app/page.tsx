import { redirect } from "next/navigation";
import { scanCached, type Snapshot } from "@/lib/scanner";
import { scanCodexCached } from "@/lib/codex";

export const dynamic = "force-dynamic";

function lastActivity(snapshot: Snapshot): number {
  return snapshot.projects.reduce((n, p) => Math.max(n, p.lastActivity), 0);
}

// Opening the app lands on the Office View of whichever provider was used most
// recently. A provider with nothing on disk scores 0; if neither has been used,
// this falls through to Claude.
export default function Page() {
  let claude = 0;
  let codex = 0;
  try {
    claude = lastActivity(scanCached());
  } catch {
    // no ~/.claude/projects — leave at 0
  }
  try {
    codex = lastActivity(scanCodexCached());
  } catch {
    // no ~/.codex/sessions — leave at 0
  }
  // redirect() signals by throwing, so it has to stay outside the try blocks
  redirect(codex > claude ? "/codex/visual" : "/visual");
}
