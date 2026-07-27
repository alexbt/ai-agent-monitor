# AI Agent Monitor

A real-time dashboard for watching [Claude Code](https://claude.com/claude-code) and [OpenAI Codex CLI](https://github.com/openai/codex) sessions and their agents work.


## Getting started

```bash
git clone https://github.com/alexbt/ai-agent-monitor
cd ai-agent-monitor
make start          # installs, builds, and serves at http://localhost:3000
```

`make start` pulls in whatever is missing, so that one command is enough from a
fresh clone. Dependencies are installed only when `node_modules` is absent or
`package.json` has changed since, so re-running it doesn't reinstall.

Then open **http://localhost:3000**. Start a Claude Code or Codex session (or spawn agents/teammates) in any terminal and watch it appear within a couple of seconds.

## Overview

Claude Code writes every session, subagent, and teammate transcript to `~/.claude/projects/` (Codex writes rollouts to `~/.codex/sessions/`). This app watches those files and turns them into live views. The sidebar has a **Claude** and a **Codex** section, each offering the same three views:

- **Session Log** — all sessions grouped by project, with their agents nested under them. Active sessions/agents pulse green; every session is expandable to show its full conversation trace (user messages, assistant replies, tool calls) streaming in real time, with tool results expanding into rendered diffs and command output.

  ![Session Log](docs/session-log.png)

- **Office View** — pick a session and see it as a small office: the main agent at the front desk, every teammate and subagent at their own desk with a live running clock. Animated, labeled arrows show communication flowing between them (messages, spawns, tool activity) as it happens.

  ![Office View](docs/office-view.png)

- **Status** — plan, the current 5-hour window, and token/dollar usage over the last 7 days, broken down by **prompt**, **session**, **project**, or **model**, newest first in every case (cost breaks ties, so the order is stable). Prompt and session answer "which of these is burning money"; rows are listed by their text or title and link straight into the other views. Spend also shows up where you browse: a cost badge on every prompt row and session card in the Session Log, the same in the Office View, and a 7-day total on each project heading.

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

### Makefile targets

| Target | What it does |
|---|---|
| `make install` | install dependencies (implied by the targets below) |
| `make dev` | run in development mode with hot reload (port 3000) |
| `make build` | production build |
| `make start` | install if needed, build, then serve it in production mode |
| `make stop` | stop a server started by `dev` or `start` (`make stop PORT=3001` for another port) |

Ctrl-C stops `make dev` / `make start` cleanly. It needs help to do so: make's recipe
shell swallows the interrupt, and `next` then shuts down *gracefully* — draining open
connections, which never completes because an open dashboard tab holds SSE streams
indefinitely. Both targets therefore trap the interrupt and stop the server outright,
clearing the `next-server` worker that would otherwise be orphaned and keep the port.
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
- `lib/status.ts` is the usage/cost pass: plan details from `~/.claude.json` (or the Codex `auth.json` id_token), quota from Codex's `rate_limits` events, and seven days of `usage` blocks aggregated by model, project, session and prompt. Parse output is cached per file+mtime, so an idle transcript is read once. `lib/useCosts.ts` is the client half — it polls `/api/status` so the other views can show spend inline.
- `lib/codex.ts` does the same for Codex rollouts, mapping them into the identical snapshot shape (sessions grouped by working directory, titles from Codex's `session_index.jsonl`), so the whole UI is provider-agnostic.
- `app/api/stream/route.ts` polls the selected provider's scanner every 2s and pushes snapshots to the browser over Server-Sent Events (only when something changed; one shared scan across all clients).
- `app/api/trace/route.ts` streams a session's full conversation, then tails the file by byte offset for live updates; it parses whichever transcript format the provider uses into the same trace items. `lib/traceDetail.ts` turns each entry's `toolUseResult` into a typed payload the panel can render properly (see below).
- Named Claude teammate agents run as sibling sessions; they are linked back to their spawning session via the `teamName` field in the transcript, which is how the office view seats them together.
- The two views live in `app/components/SessionLogView.tsx` and `app/components/OfficeView.tsx`, rendered by thin pages at `/` and `/visual` (Claude) and `/codex` and `/codex/visual` (Codex).


## Notes & limitations

- **Session state** — Claude Code writes a file per running CLI process to `~/.claude/sessions/<pid>.json` naming the session it drives and whether it is `busy` or `idle`. That plus the transcript gives four honest states:

  | state | means | how it's derived |
  |---|---|---|
  | **working** | running and generating | registry says `busy` |
  | **needs you** | stopped and *blocked* — a permission prompt or a question | registry says `idle` **and** the newest assistant turn left a tool call unanswered |
  | **idle** | finished its turn (`✻ Crunched for …`) and back at the prompt | registry says `idle` and nothing is outstanding |
  | **ended** | no live process — the CLI exited or was killed | no registry entry, or its pid is dead |

  The registry's `busy`/`idle` alone conflates the middle two, which is the difference between "it wants something from you" and "it's done". Only the first is worth interrupting you for, so only it counts toward the "Needs you" filter and the notifications. The Session Log filters on these, the header counts them, and the Office View colours its dots by them.

  Liveness comes from the pid (`kill(pid, 0)`, treating `EPERM` as alive), never from a timestamp: `statusUpdatedAt` records when the status last *changed* and ages steadily while a session sits busy, so freshness would be a bad proxy. A killed CLI can leave its file behind, which is why a dead pid reports `ended` regardless of what the file says.

  The bell toggle opts into a desktop notification when a session transitions to *needs you*, plus a count in the tab title so a background tab still reports. Permission is only ever requested on that click. This stays read-only — nothing is written to `~/.claude`.

  In Prompts mode the state belongs to the session's **newest** prompt only — the earlier ones finished long ago and don't inherit it. That holds in both views: the Session Log's rows and its state filter, and the Office View's picker, panel header and scene. Selecting an older turn shows the state it ended in, not what the session is doing now.

  Codex publishes no such registry, so its sessions report an unknown state and fall back to the file-mtime heuristic below.
- Where no state is available, activity is inferred from file writes: a session idle at the prompt shows as **inactive** after ~60 seconds even though its process is alive. This is what the registry replaces for Claude.
- **Session titles** come from the `ai-title` record Claude Code writes into its own transcript (`{"type":"ai-title","aiTitle":…}`) — a short LLM-written summary of what the session is about, which beats labelling a multi-hour session by whatever was typed first. The opening prompt is still shown, on a second line beneath the title.

  It's read from both ends of the file, no extra I/O: the tail pass that already tracks the model takes the newest one, and the header read covers long sessions whose last 64 KB happens to contain none (the record repeats only every few turns — as little as once per 64 KB on the transcripts here). Whichever is found is sticky, so the title can't flicker back to unknown. Sessions ending before Claude Code generates a title, and all Codex sessions (no equivalent record), keep falling back to the first prompt.
- **Moving between views** — every view links to the other two for whatever it is currently showing, carrying `?session=…` and, where one is selected, `&prompt=…`. The Session Log's rows have **Office** and **Status** buttons, the Office View puts **Log** and **Status** in the office panel's title row (so the picker dropdown spans the full column), and each session row in Status has **Office** and **Log**. Arriving at Status this way keeps the mode you were in: a link carrying `&prompt=` (only ever attached in Prompts mode) opens the **Prompt** breakdown and highlights that prompt, one without it opens **Session**. Either way it expands past the top-12 cut if the row is below it, scrolls to and highlights the row, or says so plainly when there is no row because nothing priced landed in the lookback. Absent a link, the breakdown follows the Prompts/Sessions choice shared with the other two views until you pick one on the page itself.
- **Prompts / Sessions mode** — a toggle in the header of both views, defaulting to Prompts. A session is a sequence of many prompts, and labelling it by its first one goes stale fast, so Prompts mode breaks the list apart: one row per prompt, newest first, tagged `n/total` with the session it belongs to. Picking one opens that session's trace scrolled to that exact turn. Sessions mode is the one-row-per-session view. The choice is remembered and shared by both views.

  Only prompts you actually typed are listed. Claude Code marks them with `promptSource: "typed"`, which separates them from the background-task reports, hook output and slash-command wrappers that arrive through the same `user` channel (on this machine, a third of them). Older transcripts predate that field, so they fall back to filtering on the wrapping tag.

  Prompts come from `/api/prompts`, not from the 2-second snapshot scan: collecting them means walking a transcript end to end, while the scanners only ever read a 64 KB head and tail. `lib/prompts.ts` parses each file incrementally — transcripts are append-only, so only bytes added since the last pass are re-read — and it only runs while you are in Prompts mode.
- **Tool results in the trace** — transcripts store far more per tool call than a flattened string. Each entry carries a `toolUseResult`: `structuredPatch` for edits, `stdout`/`stderr`/`interrupted` for shell commands, the file slice a `Read` pulled in, and `agentId`/`status`/`resolvedModel` for subagent launches. `lib/traceDetail.ts` maps those shapes to a `ToolDetail` union; unknown ones (MCP tools, new built-ins) fall back to pretty-printed JSON rather than being dropped.

  Each row therefore shows a purpose-built one-line summary (`lib/scanner.ts · +14 −46`, the command itself, the first line of output) and expands into the real thing: a coloured diff with old/new line numbers, stdout and stderr kept apart, the file contents. Results are paired back to the call that produced them via `tool_use_id`, so a result row is labelled with its tool name, and failures (`is_error`) are marked in red. The filter box searches inside collapsed payloads too. Rows carry a timestamp and a copy button, and the panel has a fullscreen mode (Esc to leave).
- **Cost estimation** — `lib/status.ts` walks every transcript in the last 7 days and pulls the `usage` block off each assistant turn, then aggregates the same turns three ways: by model, by project, and by session. Regrouping is the only difference between them, so "which project cost the most" is as cheap as "which model".

  Cache writes are billed by TTL, and `usage.cache_creation` splits the total into `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`. The 1-hour share costs 2x input rather than 1.25x, and on the transcripts here it is about two thirds of all cache writes — so pricing it as 5-minute under-counted materially. Both buckets are priced separately and the table shows the 1h share per row. Transcripts predating that field fall back to the cheaper rate.

  Only models with confirmed pricing are priced (Opus 5 and 4.5–4.8, Sonnet 5 and 4.5/4.6, Haiku 4.5, Fable/Mythos 5); anything else — Codex/OpenAI models, older tiers on different rates — contributes tokens but no dollars, and the count of those requests is surfaced rather than silently folded into the total. Costs come from `/api/status` on a 30-second poll, not the 2-second snapshot scan, because collecting them means reading every transcript end to end.

  **One response, not one line.** A single API response is written to the transcript as several JSONL lines — one per content block (thinking, text, each tool call) — and every one repeats the same response-level `usage`. Counting per line multiplied real spend by 2.8x here, so turns are deduplicated on `message.id`, which is present on every assistant entry carrying usage and never spans files.

  **Per-prompt attribution.** Assistant turns carry no prompt id of their own, but every `user` entry does (`promptId`), and each turn reaches one by walking `parentUuid` — on this machine every turn resolves, in at most a handful of hops. Subagent spend is attributed through a second hop: `agent-*.meta.json` names the `Agent` tool call that spawned the transcript, and that call belongs to a prompt. Because an agent can spawn an agent, the resolve is a fixpoint rather than a single pass. The check that it is complete is that the per-prompt costs sum to exactly the seven-day total.

  A session's subagent transcripts count against the session that spawned them: an agent burns tokens on the session's behalf, so `<session>/subagents/agent-*.jsonl` rolls up into `<session>`. The same tokens roll up into the prompt that asked for the work, which is why an agent-spawning prompt costs far more than its own handful of turns suggests.

  Usage aggregates carry no session title — the snapshot already does, so the Status table names its rows from that rather than making the cost pass re-read every transcript header. `sessionLabel()` in `lib/useSnapshot.ts` is the shared naming rule (teammate name → LLM title → opening prompt → id), so a session reads the same everywhere it appears.
- **Friction** — the moments worth going back to, kept deliberately rare. A prompt row is chipped only when **you declined a tool call** (`toolDenialKind: "user-rejected"`), **you interrupted it** (`interruptedMessageId`), or **a command was killed for running too long** (`toolUseResult.timedOutAfterMs`). Two of the three are you; the third is time lost.

  What is *not* counted is `is_error`. Ordinary tool errors — a stale string in an edit, a failed grep, a typo in a command — are retried and fixed on the next call, and they are common: on this machine they appear in **31% of prompts and 5 of 6 sessions**, which would make the badge wallpaper. The three signals above land on **17%** of prompts and name what actually happened (`1 rejected`, `1 timed out`) rather than implying the prompt failed. Sessions get no chip at all — over hundreds of turns something always goes wrong, so that granularity can only ever be noise.

  Inside the trace, failed tool calls are still marked — a red left border and role label on the row, with `is_error` carried through from the transcript — but they get no counter or jump control in the toolbar.
- **Walking a session** — the trace toolbar reads `7/25 prompts`, with arrows either side that step between them (wrapping at both ends). A long session is mostly tool traffic, so turn-to-turn is the only practical way to move through it.

  The current index tracks scrolling as well as the arrows: it is the last prompt whose turn begins at or above the **middle** of the box, recomputed from live geometry (one frame at most) rather than remembered, so expanding a diff or streaming new rows can't desynchronise it. The middle rather than the top because that is where a focused prompt gets scrolled to — measuring at the top reports the previous prompt for the very row being highlighted. Centring the jump target also guarantees every later prompt sits below the middle, so the counter lands on exactly the prompt you asked for. Scrolling re-anchors the arrows too, so *next* means the prompt after the one you are reading.

  Opening the trace from a prompt row jumps to that turn **by number** (`promptN`), not by matching its text. The old text match compared a 60-character prefix and took the first hit, which lands on the wrong turn whenever two prompts open the same way — and in practice they often do.

  The trace stream numbers those turns using `typedPromptText()` from `lib/prompts.ts` — the same test the prompt list uses. Sharing it matters: the trace's "24 prompts" and the list's row count are the same claim, and injected `user` traffic (task notifications, hook output) arrives through the same channel and must not be counted as something you said. Numbered turns render as `user · prompt 3` so a jump lands somewhere recognisable.

  Friction is attributed by file order rather than by walking `parentUuid` as cost does — transcripts are written in sequence, so an event belongs to the most recent prompt seen, which `lib/prompts.ts` already tracks as it parses incrementally.
- Communication arrows and labels come from transcript tails within a ~90-second window — they visualize recent flow, not the full message history (the trace panel has that).
- The office view shows up to 12 desks per session; extras are counted below the scene.
- Codex sessions are single-agent (no subagent transcripts), so their Office View shows the main agent working alone; traces and activity work the same as for Claude.
