import fs from "fs";
import path from "path";
import os from "os";
import { listRolloutFiles } from "./codex";

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const CONFIG_FILE = path.join(os.homedir(), ".claude.json");

// Claude's usage limits run on a rolling 5-hour session window: the window
// opens on the first request and a new one opens on the first request after it
// expires.
const WINDOW_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Turns older than this are never aggregated.
const LOOKBACK_MS = 7 * DAY_MS;

// Transcripts are read whole; past this size only the tail is scanned.
//
// This is a safety valve against a pathological file, not a performance knob:
// a partial read silently under-reports spend, and it is invisible in the UI.
// At 8 MB it was firing on an ordinary long session here and hiding 15% of the
// total. Reading every byte of this machine's corpus costs ~50 ms more than the
// capped read and is cached per file+mtime, so only a file being actively
// written is ever re-read. The bound stays well under V8's ~512 MB string
// limit, above which `toString` would throw.
const MAX_READ_BYTES = 256 * 1024 * 1024;

// First-party Anthropic list prices, USD per million tokens. cacheRead is 0.1x
// input; cache writes are billed by TTL — 1.25x input for the 5-minute cache and
// 2x for the 1-hour one, per Anthropic's published caching multipliers. Only
// Claude models are priced; anything not matched here (Codex/OpenAI models,
// retired Opus/Sonnet tiers with different rates) is left unpriced rather than
// guessed at.
interface Rate {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

function rate(input: number, output: number): Rate {
  return {
    input,
    output,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheRead: input * 0.1,
  };
}

const OPUS = rate(5, 25);
const SONNET = rate(3, 15);
const HAIKU = rate(1, 5);
const FABLE = rate(10, 50);

export const COST_ASSUMPTIONS =
  "First-party Anthropic list prices. Cache writes are split by TTL from usage.cache_creation and billed at 1.25x input (5-minute) or 2x (1-hour); transcripts that predate that field are billed at the 5-minute rate. Excludes batch (50%) and any intro/tier discounts. Codex/OpenAI models are unpriced. An estimate, not a bill.";

// Match a transcript model id (which may carry a "[1m]" tag or a date suffix)
// to a rate. Only versions with confirmed $5/$25-class pricing are matched;
// older Opus/Sonnet tiers priced differently return null.
function rateFor(model: string | null): Rate | null {
  if (!model) return null;
  const m = model.toLowerCase().replace(/\[[^\]]*\]/g, "").replace(/-\d{8}$/, "");
  // Opus 5 is priced the same as the 4.5–4.8 tier.
  if (/opus-(5|4-[5678])/.test(m)) return OPUS;
  if (/sonnet-(5|4-[56])/.test(m)) return SONNET;
  if (/haiku-4-5/.test(m)) return HAIKU;
  if (/(fable|mythos)-5/.test(m)) return FABLE;
  return null;
}

// Dollar cost of one turn, or null when the model has no known price.
function turnCost(turn: Turn): number | null {
  const r = rateFor(turn.model);
  if (!r) return null;
  return (
    (turn.input * r.input +
      turn.output * r.output +
      turn.cacheWrite5m * r.cacheWrite5m +
      turn.cacheWrite1h * r.cacheWrite1h +
      turn.cacheRead * r.cacheRead) /
    1_000_000
  );
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // The 1-hour-TTL share of cacheWrite, billed at 2x input instead of 1.25x.
  cacheWrite1h: number;
  total: number;
  turns: number;
  // Estimated USD across the priced turns only.
  cost: number;
  // Turns whose model had no known price, so they contribute tokens but no cost.
  unpricedTurns: number;
}

export interface ModelTotals extends TokenTotals {
  model: string;
}

// Spend rolled up by working directory. `project` is the same key the session
// snapshot uses (the transcript directory for Claude, the cwd for Codex), so
// the two can be joined in the UI.
export interface ProjectTotals extends TokenTotals {
  project: string;
  label: string;
  sessions: number;
  lastActivity: number;
}

// Spend rolled up by session, subagent transcripts included: an agent burns
// tokens on behalf of the session that spawned it.
export interface SessionTotals extends TokenTotals {
  session: string;
  project: string;
  projectLabel: string;
  models: string[];
  lastActivity: number;
}

// Spend rolled up by the individual prompt that caused it. Assistant turns
// carry no prompt id of their own, so each is traced back to one — see
// `resolvePrompts`. Subagent spend lands on the prompt whose `Agent` call
// spawned it, so a prompt's cost is everything it set in motion.
export interface PromptTotals extends TokenTotals {
  prompt: string; // Claude Code's promptId
  session: string;
  project: string;
  projectLabel: string;
  models: string[];
  lastActivity: number;
}

export interface LastTurn {
  at: number;
  model: string | null;
  project: string | null;
  tokens: TokenTotals;
}

export interface PlanInfo {
  label: string;
  tier: string | null;
  billingType: string | null;
  email: string | null;
  subscriptionCreatedAt: number | null;
  extraUsageEnabled: boolean | null;
}

// Where a real quota reading isn't available, `known` is false and `note`
// explains why rather than the UI implying a limit is being tracked.
export interface QuotaInfo {
  known: boolean;
  usedPercent: number | null;
  windowLabel: string | null;
  resetsAt: number | null;
  limitName: string | null;
  creditsNote: string | null;
  note: string | null;
}

export interface WindowInfo {
  startedAt: number;
  resetsAt: number;
  totals: TokenTotals;
  byModel: ModelTotals[];
}

export interface StatusInfo {
  provider: "claude" | "codex";
  generatedAt: number;
  plan: PlanInfo | null;
  quota: QuotaInfo;
  window: WindowInfo | null;
  today: TokenTotals;
  sevenDay: TokenTotals;
  byModel: ModelTotals[];
  // Same seven-day turns as byModel, re-keyed: "which project/session is
  // burning money" rather than "which model did I spend on".
  byProject: ProjectTotals[];
  bySession: SessionTotals[];
  byPrompt: PromptTotals[];
  lastTurn: LastTurn | null;
  // Tracked separately from lastTurn: Codex records which model ran even when
  // it records no token counts for the request.
  lastModel: { model: string; at: number } | null;
  // Model requests observed in the lookback, counted even when the transcript
  // carries no token accounting — lets the UI tell "idle" apart from
  // "active, but usage was never recorded".
  requests: number;
  usageAvailable: boolean;
  filesScanned: number;
  // Human-readable caveats behind the dollar figures.
  costNote: string;
}

// One billable request pulled out of a transcript.
interface Turn {
  ts: number;
  model: string | null;
  project: string | null;
  projectLabel: string | null;
  session: string | null;
  // The prompt this turn belongs to, when it could be resolved from the
  // transcript itself (main-session turns).
  prompt: string | null;
  // Subagent turns instead carry the id of the `Agent` tool call that spawned
  // their transcript; the owning prompt is looked up from it after every file
  // has been parsed, since it lives in a different file.
  viaToolUse: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

function emptyTotals(): TokenTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    total: 0,
    turns: 0,
    cost: 0,
    unpricedTurns: 0,
  };
}

function addTurn(t: TokenTotals, turn: Turn): TokenTotals {
  const cacheWrite = turn.cacheWrite5m + turn.cacheWrite1h;
  t.input += turn.input;
  t.output += turn.output;
  t.cacheRead += turn.cacheRead;
  t.cacheWrite += cacheWrite;
  t.cacheWrite1h += turn.cacheWrite1h;
  t.total += turn.input + turn.output + turn.cacheRead + cacheWrite;
  t.turns += 1;
  const cost = turnCost(turn);
  if (cost === null) t.unpricedTurns += 1;
  else t.cost += cost;
  return t;
}

function sumTurns(turns: Turn[]): TokenTotals {
  return turns.reduce(addTurn, emptyTotals());
}

// Cost first: the whole point of these breakdowns is "what is expensive". Turns
// on unpriced models still sort by tokens among themselves.
function byCost(a: TokenTotals, b: TokenTotals): number {
  return b.cost - a.cost || b.total - a.total;
}

function groupByModel(turns: Turn[]): ModelTotals[] {
  const byModel = new Map<string, ModelTotals>();
  for (const turn of turns) {
    const model = turn.model ?? "unknown";
    const entry = byModel.get(model) ?? { model, ...emptyTotals() };
    addTurn(entry, turn);
    byModel.set(model, entry);
  }
  return [...byModel.values()].sort((a, b) => b.total - a.total);
}

function groupByProject(turns: Turn[]): ProjectTotals[] {
  const byProject = new Map<string, ProjectTotals & { ids: Set<string> }>();
  for (const turn of turns) {
    const project = turn.project ?? "unknown";
    let entry = byProject.get(project);
    if (!entry) {
      entry = {
        project,
        label: turn.projectLabel ?? project,
        sessions: 0,
        lastActivity: 0,
        ids: new Set<string>(),
        ...emptyTotals(),
      };
      byProject.set(project, entry);
    }
    // The directory name flattens "/" and "-" identically, so a real cwd from
    // any turn beats the key we grouped on.
    if (turn.projectLabel) entry.label = turn.projectLabel;
    if (turn.session) entry.ids.add(turn.session);
    entry.lastActivity = Math.max(entry.lastActivity, turn.ts);
    addTurn(entry, turn);
  }
  return [...byProject.values()]
    .map(({ ids, ...rest }) => ({ ...rest, sessions: ids.size }))
    .sort(byCost);
}

function groupByPrompt(turns: Turn[]): PromptTotals[] {
  const byPrompt = new Map<string, PromptTotals & { seen: Set<string> }>();
  for (const turn of turns) {
    // Turns that resolve to no prompt are left out rather than lumped into an
    // "unknown" row — a prompt breakdown that invents a bucket is worse than
    // one that is visibly incomplete. On this machine there are none.
    if (!turn.prompt) continue;
    let entry = byPrompt.get(turn.prompt);
    if (!entry) {
      entry = {
        prompt: turn.prompt,
        session: turn.session ?? "unknown",
        project: turn.project ?? "unknown",
        projectLabel: turn.projectLabel ?? turn.project ?? "unknown",
        models: [],
        lastActivity: 0,
        seen: new Set<string>(),
        ...emptyTotals(),
      };
      byPrompt.set(turn.prompt, entry);
    }
    if (turn.projectLabel) entry.projectLabel = turn.projectLabel;
    if (turn.model) entry.seen.add(turn.model);
    entry.lastActivity = Math.max(entry.lastActivity, turn.ts);
    addTurn(entry, turn);
  }
  return [...byPrompt.values()]
    .map(({ seen, ...rest }) => ({ ...rest, models: [...seen] }))
    .sort(byCost);
}

function groupBySession(turns: Turn[]): SessionTotals[] {
  const bySession = new Map<string, SessionTotals & { seen: Set<string> }>();
  for (const turn of turns) {
    const session = turn.session ?? "unknown";
    let entry = bySession.get(session);
    if (!entry) {
      entry = {
        session,
        project: turn.project ?? "unknown",
        projectLabel: turn.projectLabel ?? turn.project ?? "unknown",
        models: [],
        lastActivity: 0,
        seen: new Set<string>(),
        ...emptyTotals(),
      };
      bySession.set(session, entry);
    }
    if (turn.projectLabel) entry.projectLabel = turn.projectLabel;
    if (turn.model) entry.seen.add(turn.model);
    entry.lastActivity = Math.max(entry.lastActivity, turn.ts);
    addTurn(entry, turn);
  }
  return [...bySession.values()]
    .map(({ seen, ...rest }) => ({ ...rest, models: [...seen] }))
    .sort(byCost);
}

// The active window is the last one opened: walk forward, restarting whenever a
// turn lands past the previous window's expiry.
function currentWindow(turns: Turn[], now: number): WindowInfo | null {
  if (turns.length === 0) return null;
  let startedAt = turns[0].ts;
  for (const turn of turns) {
    if (turn.ts >= startedAt + WINDOW_MS) startedAt = turn.ts;
  }
  // The last window may already have lapsed with no traffic since.
  if (now >= startedAt + WINDOW_MS) return null;
  const inWindow = turns.filter((t) => t.ts >= startedAt);
  return {
    startedAt,
    resetsAt: startedAt + WINDOW_MS,
    totals: sumTurns(inWindow),
    byModel: groupByModel(inWindow),
  };
}

function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function buildStatus(opts: {
  provider: "claude" | "codex";
  turns: Turn[];
  plan: PlanInfo | null;
  quota: QuotaInfo;
  lastModel: { model: string; at: number } | null;
  requests: number;
  filesScanned: number;
  now: number;
}): StatusInfo {
  const { turns, now } = opts;
  turns.sort((a, b) => a.ts - b.ts);
  const midnight = startOfToday(now);
  const last = turns[turns.length - 1];
  const lastTurn: LastTurn | null = last
    ? { at: last.ts, model: last.model, project: last.project, tokens: sumTurns([last]) }
    : null;
  // fall back to the newest priced turn when nothing else reported a model
  const lastModel =
    opts.lastModel ??
    (lastTurn?.model ? { model: lastTurn.model, at: lastTurn.at } : null);

  return {
    provider: opts.provider,
    generatedAt: now,
    plan: opts.plan,
    quota: opts.quota,
    window: currentWindow(turns, now),
    today: sumTurns(turns.filter((t) => t.ts >= midnight)),
    sevenDay: sumTurns(turns),
    byModel: groupByModel(turns),
    byProject: groupByProject(turns),
    bySession: groupBySession(turns),
    byPrompt: groupByPrompt(turns),
    lastTurn,
    lastModel,
    requests: Math.max(opts.requests, turns.length),
    usageAvailable: turns.length > 0,
    filesScanned: opts.filesScanned,
    costNote: COST_ASSUMPTIONS,
  };
}

function readCapped(filePath: string, size: number): string {
  if (size <= MAX_READ_BYTES) return fs.readFileSync(filePath, "utf8");
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(MAX_READ_BYTES);
  const read = fs.readSync(fd, buf, 0, MAX_READ_BYTES, size - MAX_READ_BYTES);
  fs.closeSync(fd);
  // first line is almost certainly truncated
  return buf.toString("utf8", 0, read).split("\n").slice(1).join("\n");
}

// Parse output per transcript, keyed by file+mtime: only the transcript being
// written right now is ever re-parsed.
const parseCache = new Map<string, { mtime: number; value: unknown }>();

function cachedParse<T>(
  filePath: string,
  mtime: number,
  size: number,
  parse: (text: string) => T,
  onError: T
): T {
  const cached = parseCache.get(filePath);
  if (cached && cached.mtime === mtime) return cached.value as T;
  let value: T;
  try {
    value = parse(readCapped(filePath, size));
  } catch {
    value = onError;
  }
  parseCache.set(filePath, { mtime, value });
  return value;
}

// Every *.jsonl under a project dir, including subagent transcripts — agents
// burn tokens against the same limit as the main session.
function walkJsonl(dir: string, out: string[], depth = 0): string[] {
  if (depth > 5) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out, depth + 1);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

// Cache writes are billed per TTL. `usage.cache_creation` splits the total into
// 5-minute and 1-hour buckets; transcripts written before that field existed
// only have the total, which falls back to the cheaper 5-minute rate.
function splitCacheWrite(usage: any): { m5: number; h1: number } {
  const total = usage.cache_creation_input_tokens ?? 0;
  const c = usage.cache_creation;
  if (!c || typeof c !== "object") return { m5: total, h1: 0 };
  const h1 = c.ephemeral_1h_input_tokens ?? 0;
  const m5 = c.ephemeral_5m_input_tokens ?? 0;
  // Trust the total; give any unattributed remainder the cheaper rate.
  return { m5: Math.max(m5, total - h1), h1 };
}

// What one transcript yields: its billable turns, plus the mapping needed to
// attribute any subagent it spawned back to the right prompt.
interface FileTurns {
  turns: Turn[];
  // tool_use id → owning promptId, for the `Agent` calls made in this file.
  toolPrompts: Record<string, string>;
  // Every tool_use id in this file. Only used for subagent transcripts: once
  // the file's own prompt is known, every call it made inherits it, which is
  // how an agent that spawns another agent resolves.
  toolIds: string[];
}

function parseClaudeTurns(
  text: string,
  project: string,
  session: string,
  cutoff: number,
  // Set for `<session>/subagents/agent-*.jsonl`: the tool call that spawned it.
  viaToolUse: string | null
): FileTurns {
  const turns: Turn[] = [];
  const toolPrompts: Record<string, string> = {};
  const toolIds: string[] = [];
  // uuid → (parent, prompt) for this file. Only the two strings are kept, not
  // whole entries, so indexing an 18 MB transcript stays cheap.
  const chain = new Map<string, { parent: string | null; prompt: string | null }>();
  for (const line of text.split("\n")) {
    if (!line.includes('"uuid"')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e?.uuid !== "string") continue;
    chain.set(e.uuid, {
      parent: typeof e.parentUuid === "string" ? e.parentUuid : null,
      prompt: typeof e.promptId === "string" ? e.promptId : null,
    });
  }

  // Climb parentUuid until an entry that names its prompt. Measured on this
  // machine: every assistant turn resolves, in at most a handful of hops.
  const promptFor = (uuid: string | null): string | null => {
    let at = uuid;
    for (let hops = 0; at && hops < 500; hops++) {
      const node = chain.get(at);
      if (!node) return null;
      if (node.prompt) return node.prompt;
      at = node.parent;
    }
    return null;
  };

  // One API response is written as several JSONL lines — one per content block
  // (thinking, text, each tool_use) — and every one of them repeats the same
  // response-level `usage`. Counting per line therefore multiplies real spend
  // (2.8x on the transcripts here). `message.id` is the response id: it is on
  // every assistant entry that carries usage and never spans files, so a
  // per-file set is enough to count each response exactly once.
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    // cheap pre-filter — only assistant entries carry a usage block
    if (!line.includes('"usage"')) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    // A subagent transcript belongs wholesale to the prompt that spawned it, so
    // its own internal prompt ids are ignored in favour of `viaToolUse`.
    const owner = viaToolUse ? null : promptFor(entry.uuid ?? null);
    for (const c of entry.message?.content ?? []) {
      if (c?.type !== "tool_use" || typeof c.id !== "string") continue;
      toolIds.push(c.id);
      if (owner) toolPrompts[c.id] = owner;
    }
    const usage = entry.message?.usage;
    if (!usage || typeof usage !== "object") continue;
    const id = entry.message?.id;
    // No id (older transcripts): fall back to counting the line, which is what
    // this did before — over-counting a rare entry beats dropping it.
    if (typeof id === "string") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : 0;
    if (!ts || ts < cutoff) continue;
    const model = entry.message?.model;
    const cache = splitCacheWrite(usage);
    turns.push({
      ts,
      model: typeof model === "string" && model !== "<synthetic>" ? model : null,
      project,
      projectLabel: typeof entry.cwd === "string" ? entry.cwd : null,
      session,
      prompt: owner,
      viaToolUse,
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite5m: cache.m5,
      cacheWrite1h: cache.h1,
    });
  }
  return { turns, toolPrompts, toolIds };
}

// A subagent transcript has a sibling meta naming the `Agent` tool call that
// spawned it, which is the thread back to the prompt that asked for the work.
// Null for ordinary session transcripts.
const metaCache = new Map<string, { mtime: number; toolUseId: string | null }>();

function agentToolUseId(transcript: string): string | null {
  if (!/[/\\]subagents[/\\]agent-[^/\\]+\.jsonl$/.test(transcript)) return null;
  const metaPath = transcript.replace(/\.jsonl$/, ".meta.json");
  let mtime = 0;
  try {
    mtime = fs.statSync(metaPath).mtimeMs;
  } catch {
    return null;
  }
  const hit = metaCache.get(metaPath);
  if (hit && hit.mtime === mtime) return hit.toolUseId;
  let toolUseId: string | null = null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (typeof meta?.toolUseId === "string") toolUseId = meta.toolUseId;
  } catch {
    toolUseId = null;
  }
  metaCache.set(metaPath, { mtime, toolUseId });
  return toolUseId;
}

// Attribute subagent turns to the prompt that spawned them. An agent can spawn
// another agent, so this is a fixpoint rather than a single pass: once a
// subagent's own prompt is known, every tool call it made inherits it, which
// lets the next level down resolve. Converges in as many rounds as there are
// nesting levels; the loop is bounded in case a meta points at a call whose
// transcript has aged out of the lookback.
function resolveAgentPrompts(
  turns: Turn[],
  toolPrompts: Record<string, string>,
  pending: { viaToolUse: string; toolIds: string[] }[]
): void {
  for (let round = 0; round < 8 && pending.length > 0; round++) {
    const stuck: typeof pending = [];
    let progressed = false;
    for (const file of pending) {
      const prompt = toolPrompts[file.viaToolUse];
      if (!prompt) {
        stuck.push(file);
        continue;
      }
      progressed = true;
      for (const id of file.toolIds) toolPrompts[id] ??= prompt;
    }
    pending = stuck;
    if (!progressed) break;
  }
  for (const turn of turns) {
    if (!turn.prompt && turn.viaToolUse) {
      turn.prompt = toolPrompts[turn.viaToolUse] ?? null;
    }
  }
}

function readPlan(): PlanInfo | null {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const account = config?.oauthAccount;
    if (!account) return null;
    const tier: string | null =
      account.organizationRateLimitTier ?? account.userRateLimitTier ?? null;
    const raw = (tier ?? account.organizationType ?? "").replace(/^default_/, "");
    const label = raw
      ? raw
          .split("_")
          .map((w: string) =>
            /^\d+x$/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)
          )
          .join(" ")
      : "Unknown plan";
    const since = account.subscriptionCreatedAt
      ? Date.parse(account.subscriptionCreatedAt)
      : NaN;
    return {
      label,
      tier,
      billingType: account.billingType ?? null,
      email: account.emailAddress ?? null,
      subscriptionCreatedAt: Number.isNaN(since) ? null : since,
      extraUsageEnabled: account.hasExtraUsageEnabled ?? null,
    };
  } catch {
    return null;
  }
}

export function claudeStatus(): StatusInfo {
  const now = Date.now();
  const cutoff = now - LOOKBACK_MS;
  const turns: Turn[] = [];
  let filesScanned = 0;

  let projectDirs: fs.Dirent[] = [];
  try {
    projectDirs = fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory());
  } catch {
    projectDirs = [];
  }

  // tool_use id → owning prompt, merged across every transcript, plus the
  // subagent files still waiting on it.
  const toolPrompts: Record<string, string> = {};
  const pending: { viaToolUse: string; toolIds: string[] }[] = [];
  const empty: FileTurns = { turns: [], toolPrompts: {}, toolIds: [] };

  for (const dir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, dir.name);
    for (const file of walkJsonl(projectPath, [])) {
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      // a transcript untouched since the cutoff holds nothing in range
      if (st.mtimeMs < cutoff) continue;
      filesScanned++;
      // "<session>.jsonl" for a session, "<session>/subagents/agent-<id>.jsonl"
      // for one of its agents — either way the first path segment names the
      // session whose budget the tokens came out of.
      const session = path
        .relative(projectPath, file)
        .split(path.sep)[0]
        .replace(/\.jsonl$/, "");
      const viaToolUse = agentToolUseId(file);
      const parsed = cachedParse(
        file,
        st.mtimeMs,
        st.size,
        (text) => parseClaudeTurns(text, dir.name, session, cutoff, viaToolUse),
        empty
      );
      turns.push(...parsed.turns);
      Object.assign(toolPrompts, parsed.toolPrompts);
      if (viaToolUse) pending.push({ viaToolUse, toolIds: parsed.toolIds });
    }
  }

  resolveAgentPrompts(turns, toolPrompts, pending);

  const quota: QuotaInfo = {
    known: false,
    usedPercent: null,
    windowLabel: null,
    resetsAt: null,
    limitName: null,
    creditsNote: null,
    note: "Claude Code never writes quota or reset data to disk — it comes from API response headers at runtime. Run /usage inside Claude Code for the authoritative numbers.",
  };

  return buildStatus({
    provider: "claude",
    turns,
    plan: readPlan(),
    quota,
    lastModel: null,
    requests: turns.length,
    filesScanned,
    now,
  });
}

// --- Codex -----------------------------------------------------------------
// Codex emits a token_count event when a turn completes. Verified against real
// rollouts: `info` carries token accounting but is frequently null, and
// `rate_limits` always exists while its `primary`/`secondary` windows are only
// filled in once the server reports them. Everything here degrades to null
// rather than to a zero that would read as "no usage".

const CODEX_AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json");

interface CodexParse {
  turns: Turn[];
  quota: QuotaInfo | null;
  lastModel: { model: string; at: number } | null;
  requests: number;
}

function parseRateLimitWindow(win: any, at: number): Partial<QuotaInfo> | null {
  if (!win || typeof win !== "object") return null;
  const minutes = typeof win.window_minutes === "number" ? win.window_minutes : null;
  return {
    known: typeof win.used_percent === "number",
    usedPercent: typeof win.used_percent === "number" ? win.used_percent : null,
    windowLabel:
      minutes === null
        ? null
        : minutes % 60 === 0
          ? `${minutes / 60}h window`
          : `${minutes}m window`,
    resetsAt:
      typeof win.resets_in_seconds === "number" ? at + win.resets_in_seconds * 1000 : null,
  };
}

function parseCodexFile(text: string, fallbackId: string, cutoff: number): CodexParse {
  const turns: Turn[] = [];
  let quota: QuotaInfo | null = null;
  let lastModel: { model: string; at: number } | null = null;
  let model: string | null = null;
  let requests = 0;
  // Rollouts open with a session_meta record naming the session and its cwd;
  // both are stamped onto the turns once the file has been read.
  let session: string | null = null;
  let cwd: string | null = null;

  for (const line of text.split("\n")) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = entry?.timestamp ? Date.parse(entry.timestamp) : 0;

    if (entry?.type === "session_meta") {
      session ??= entry.payload?.id ? String(entry.payload.id) : null;
      cwd ??= entry.payload?.cwd ? String(entry.payload.cwd) : null;
      continue;
    }

    // the model can change from turn to turn — the newest one wins
    if (entry?.type === "turn_context" && entry.payload?.model) {
      model = String(entry.payload.model);
      if (ts && (!lastModel || ts >= lastModel.at)) lastModel = { model, at: ts };
      continue;
    }
    if (entry?.type !== "event_msg" || entry.payload?.type !== "token_count") continue;

    requests++;

    // `info` is null whenever Codex ran the turn without token accounting
    const used = entry.payload.info?.last_token_usage;
    if (used && ts && ts >= cutoff) {
      turns.push({
        ts,
        model,
        // filled in below, once session_meta has been seen
        project: null,
        projectLabel: null,
        session: null,
        // Codex rollouts have no prompt id, so there is nothing to group on.
        prompt: null,
        viaToolUse: null,
        input: used.input_tokens ?? 0,
        output: used.output_tokens ?? 0,
        cacheRead: used.cached_input_tokens ?? 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      });
    }

    const limits = entry.payload.rate_limits;
    if (limits && ts) {
      const window =
        parseRateLimitWindow(limits.primary, ts) ??
        parseRateLimitWindow(limits.secondary, ts);
      const credits = limits.credits;
      quota = {
        known: window?.known ?? false,
        usedPercent: window?.usedPercent ?? null,
        windowLabel: window?.windowLabel ?? null,
        resetsAt: window?.resetsAt ?? null,
        limitName: limits.limit_name ?? limits.limit_id ?? null,
        creditsNote: credits?.unlimited
          ? "unlimited credits"
          : credits?.has_credits
            ? `credits: ${credits.balance ?? "available"}`
            : credits
              ? "no credits"
              : null,
        note: window?.known
          ? null
          : "Codex recorded a rate-limit entry but no usage window — the server had not reported one yet.",
      };
    }
  }

  // Codex groups sessions by working directory, matching what the session
  // snapshot uses as a project key.
  const project = cwd ?? "(unknown)";
  for (const turn of turns) {
    turn.project = project;
    turn.projectLabel = project;
    turn.session = session ?? fallbackId;
  }
  return { turns, quota, lastModel, requests };
}

// ~/.codex/auth.json holds live OAuth credentials. Only the plan claims are
// read out of the id_token; no token material leaves this function.
function readCodexPlan(): PlanInfo | null {
  let claims: any;
  let authMode: string | null = null;
  try {
    const auth = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, "utf8"));
    const idToken = auth?.tokens?.id_token;
    if (typeof idToken !== "string") return null;
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    authMode = auth?.auth_mode ?? null;
  } catch {
    return null;
  }

  const scoped = claims?.["https://api.openai.com/auth"] ?? {};
  const planType: string | null = scoped.chatgpt_plan_type ?? null;
  const since = scoped.chatgpt_subscription_active_start
    ? Date.parse(scoped.chatgpt_subscription_active_start)
    : NaN;

  return {
    label: planType
      ? `ChatGPT ${planType.charAt(0).toUpperCase() + planType.slice(1)}`
      : "Unknown plan",
    tier: planType,
    billingType: authMode,
    email: claims?.email ?? null,
    subscriptionCreatedAt: Number.isNaN(since) ? null : since,
    extraUsageEnabled: null,
  };
}

export function codexStatus(): StatusInfo {
  const now = Date.now();
  const cutoff = now - LOOKBACK_MS;
  const turns: Turn[] = [];
  let quota: QuotaInfo | null = null;
  let quotaAt = 0;
  let lastModel: { model: string; at: number } | null = null;
  let requests = 0;
  let filesScanned = 0;

  const empty: CodexParse = { turns: [], quota: null, lastModel: null, requests: 0 };

  for (const file of listRolloutFiles()) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) continue;
    filesScanned++;
    const parsed = cachedParse(
      file,
      st.mtimeMs,
      st.size,
      // rollout-<ts>-<uuid>.jsonl — the uuid is the session id, used only if
      // the file's session_meta record is missing or truncated away
      (text) =>
        parseCodexFile(
          text,
          path.basename(file, ".jsonl").split("-").slice(-5).join("-"),
          cutoff
        ),
      empty
    );
    turns.push(...parsed.turns);
    requests += parsed.requests;
    if (parsed.lastModel && (!lastModel || parsed.lastModel.at > lastModel.at)) {
      lastModel = parsed.lastModel;
    }
    // the live rate-limit reading is whichever transcript was written last
    if (parsed.quota && st.mtimeMs > quotaAt) {
      quota = parsed.quota;
      quotaAt = st.mtimeMs;
    }
  }

  const fallback: QuotaInfo = {
    known: false,
    usedPercent: null,
    windowLabel: null,
    resetsAt: null,
    limitName: null,
    creditsNote: null,
    note: "No rate-limit entry found in the Codex rollout files. Codex only writes one once the server reports it.",
  };

  return buildStatus({
    provider: "codex",
    turns,
    plan: readCodexPlan(),
    quota: quota ?? fallback,
    lastModel,
    requests,
    filesScanned,
    now,
  });
}
