import { claudeStatus, codexStatus } from "@/lib/status";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const provider =
    new URL(request.url).searchParams.get("provider") === "codex"
      ? "codex"
      : "claude";
  const status = provider === "codex" ? codexStatus() : claudeStatus();
  return Response.json(status, {
    headers: { "Cache-Control": "no-store" },
  });
}
