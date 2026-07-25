# AI Agent Monitor

A real-time dashboard for watching [Claude Code](https://claude.com/claude-code) and [OpenAI Codex CLI](https://github.com/openai/codex) sessions and their agents work.

> Formerly known as *Claude Agent Monitor* / *claude-ui* — the repo was renamed to **ai-agent-monitor** when Codex support was added.

Claude Code writes every session, subagent, and teammate transcript to `~/.claude/projects/` (Codex writes rollouts to `~/.codex/sessions/`). This app watches those files and turns them into live views. The sidebar has a **Claude** and a **Codex** section, each offering the same two views:

- **Session Log** — all sessions grouped by project, with their agents nested under them. Active sessions/agents pulse green; every session is expandable to show its full conversation trace (user messages, assistant replies, tool calls) streaming in real time, with tool results expanding into rendered diffs and command output.

  ![Session Log](docs/session-log.png)

- **Office View** — pick a session and see it as a small office: the main agent at the front desk, every teammate and subagent at their own desk with a live running clock. Animated, labeled arrows show communication flowing between them (messages, spawns, tool activity) as it happens.

  ![Office View](docs/office-view.png)

Everything is read-only: the app never talks to Claude or Codex and never modifies any files — it only tails transcripts.


## Requirements

- **Node.js 18.18+** (Node 20+ recommended) and **npm**
- **Claude Code** installed and used at least once (the app reads `~/.claude/projects/`; without it there is simply nothing to show)
- optionally **Codex CLI** — if `~/.codex/sessions/` exists, the Codex section of the sidebar lights up with the same two views
- macOS or Linux (any platform where `~/.claude/projects` exists)

Runtime dependencies are just Next.js and React (installed via npm):

| Package | Version |
|---|---|
| next | ^15.3 |
| react / react-dom | ^19 |
| typescript (dev) | ^5 |

## Getting started

```bash
git clone https://github.com/alexbt/ai-agent-monitor
cd ai-agent-monitor
make install        # npm install
make dev            # launch at http://localhost:3000
```

Then open **http://localhost:3000**. Start a Claude Code or Codex session (or spawn agents/teammates) in any terminal and watch it appear within a couple of seconds.

### Makefile targets

| Target | What it does |
|---|---|
| `make install` | install dependencies |
| `make dev` | run in development mode with hot reload (port 3000) |
| `make build` | production build |
| `make start` | serve the production build (`make build` first) |
| `make clean` | remove build artifacts (`.next`, TS build cache) |

Without make: `npm install`, then `npm run dev`.


## How it works

```
~/.claude/projects/<project>/<session-id>.jsonl          ← Claude session transcripts
~/.claude/projects/<project>/<session-id>/subagents/     ← Claude subagent transcripts
        agent-<id>.jsonl + agent-<id>.meta.json
~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl   ← Codex session rollouts
```

- `lib/scanner.ts` scans the Claude tree and builds a snapshot: projects → sessions (first prompt, git branch, teammate name/team) → agents (type, description, activity). "Active" means the transcript was written in the last 60 seconds. Recent transcript tails are parsed for communication events (teammate messages, `SendMessage`/`Agent` tool calls, current tool usage).
- `lib/codex.ts` does the same for Codex rollouts, mapping them into the identical snapshot shape (sessions grouped by working directory, titles from Codex's `session_index.jsonl`), so the whole UI is provider-agnostic.
- `app/api/stream/route.ts` polls the selected provider's scanner every 2s and pushes snapshots to the browser over Server-Sent Events (only when something changed; one shared scan across all clients).
- `app/api/trace/route.ts` streams a session's full conversation, then tails the file by byte offset for live updates; it parses whichever transcript format the provider uses into the same trace items. `lib/traceDetail.ts` turns each entry's `toolUseResult` into a typed payload the panel can render properly (see below).
- Named Claude teammate agents run as sibling sessions; they are linked back to their spawning session via the `teamName` field in the transcript, which is how the office view seats them together.
- The two views live in `app/components/SessionLogView.tsx` and `app/components/OfficeView.tsx`, rendered by thin pages at `/` and `/visual` (Claude) and `/codex` and `/codex/visual` (Codex).


## Notes & limitations

- Activity is inferred from file writes: a session idle at the prompt (waiting for user input) shows as **inactive** after ~60 seconds even though its process is alive.
- **Session titles** come from the `ai-title` record Claude Code writes into its own transcript (`{"type":"ai-title","aiTitle":…}`) — a short LLM-written summary of what the session is about, which beats labelling a multi-hour session by whatever was typed first. The opening prompt is still shown, on a second line beneath the title.

  It's read from both ends of the file, no extra I/O: the tail pass that already tracks the model takes the newest one, and the header read covers long sessions whose last 64 KB happens to contain none (the record repeats only every few turns — as little as once per 64 KB on the transcripts here). Whichever is found is sticky, so the title can't flicker back to unknown. Sessions ending before Claude Code generates a title, and all Codex sessions (no equivalent record), keep falling back to the first prompt.
- **Prompts / Sessions mode** — a toggle in the header of both views, defaulting to Prompts. A session is a sequence of many prompts, and labelling it by its first one goes stale fast, so Prompts mode breaks the list apart: one row per prompt, newest first, tagged `n/total` with the session it belongs to. Picking one opens that session's trace scrolled to that exact turn. Sessions mode is the one-row-per-session view. The choice is remembered and shared by both views.

  Only prompts you actually typed are listed. Claude Code marks them with `promptSource: "typed"`, which separates them from the background-task reports, hook output and slash-command wrappers that arrive through the same `user` channel (on this machine, a third of them). Older transcripts predate that field, so they fall back to filtering on the wrapping tag.

  Prompts come from `/api/prompts`, not from the 2-second snapshot scan: collecting them means walking a transcript end to end, while the scanners only ever read a 64 KB head and tail. `lib/prompts.ts` parses each file incrementally — transcripts are append-only, so only bytes added since the last pass are re-read — and it only runs while you are in Prompts mode.
- **Tool results in the trace** — transcripts store far more per tool call than a flattened string. Each entry carries a `toolUseResult`: `structuredPatch` for edits, `stdout`/`stderr`/`interrupted` for shell commands, the file slice a `Read` pulled in, and `agentId`/`status`/`resolvedModel` for subagent launches. `lib/traceDetail.ts` maps those shapes to a `ToolDetail` union; unknown ones (MCP tools, new built-ins) fall back to pretty-printed JSON rather than being dropped.

  Each row therefore shows a purpose-built one-line summary (`lib/scanner.ts · +14 −46`, the command itself, the first line of output) and expands into the real thing: a coloured diff with old/new line numbers, stdout and stderr kept apart, the file contents. Results are paired back to the call that produced them via `tool_use_id`, so a result row is labelled with its tool name, and failures (`is_error`) are marked in red. The filter box searches inside collapsed payloads too. Rows carry a timestamp and a copy button, and the panel has a fullscreen mode (Esc to leave).
- Communication arrows and labels come from transcript tails within a ~90-second window — they visualize recent flow, not the full message history (the trace panel has that).
- The office view shows up to 12 desks per session; extras are counted below the scene.
- Codex sessions are single-agent (no subagent transcripts), so their Office View shows the main agent working alone; traces and activity work the same as for Claude.
