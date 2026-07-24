import { NextResponse, type NextRequest } from "next/server";

// This app serves local Claude/Codex transcripts — prompts, source code, and
// any secret that passed through a session — with no authentication. It is only
// ever meant to be reached from the same machine. The `-H 127.0.0.1` bind in
// package.json is the primary control; this middleware is defense-in-depth so a
// stray `next start -H 0.0.0.0` (or a Docker/proxy setup) can't silently expose
// everything to the LAN.

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// Strip a port and unwrap an IPv6 literal so "[::1]:3000" / "127.0.0.1:3000"
// compare cleanly against the allowlist.
function hostname(host: string | null): string | null {
  if (!host) return null;
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) return trimmed.slice(1, trimmed.indexOf("]"));
  const colon = trimmed.lastIndexOf(":");
  // only treat a trailing :NNNN as a port; bare IPv6 has multiple colons
  if (colon !== -1 && !trimmed.slice(colon + 1).includes(":") && trimmed.indexOf(":") === colon) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
}

export function middleware(request: NextRequest) {
  const host = hostname(request.headers.get("host"));
  const isLocal =
    host === "localhost" || (host !== null && LOOPBACK.has(host));

  if (!isLocal) {
    return new NextResponse("Forbidden: this monitor is local-only.", {
      status: 403,
    });
  }
  return NextResponse.next();
}

// Guard everything, including the API routes that expose transcript data.
export const config = {
  matcher: "/:path*",
};
