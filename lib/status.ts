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

// Transcripts are read whole; past this size only the tail is worth scanning.
const MAX_READ_BYTES = 8 * 1024 * 1024;

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  turns: number;
}

export interface ModelTotals extends TokenTotals {
  model: string;
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
}

// One billable request pulled out of a transcript.
interface Turn {
  ts: number;
  model: string | null;
  project: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 };
}

function addTurn(t: TokenTotals, turn: Turn): TokenTotals {
  t.input += turn.input;
  t.output += turn.output;
  t.cacheRead += turn.cacheRead;
  t.cacheWrite += turn.cacheWrite;
  t.total += turn.input + turn.output + turn.cacheRead + turn.cacheWrite;
  t.turns += 1;
  return t;
}

function sumTurns(turns: Turn[]): TokenTotals {
  return turns.reduce(addTurn, emptyTotals());
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
    lastTurn,
    lastModel,
    requests: Math.max(opts.requests, turns.length),
    usageAvailable: turns.length > 0,
    filesScanned: opts.filesScanned,
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

function parseClaudeTurns(text: string, project: string, cutoff: number): Turn[] {
  const turns: Turn[] = [];
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
    const usage = entry.message?.usage;
    if (!usage || typeof usage !== "object") continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : 0;
    if (!ts || ts < cutoff) continue;
    const model = entry.message?.model;
    turns.push({
      ts,
      model: typeof model === "string" && model !== "<synthetic>" ? model : null,
      project,
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    });
  }
  return turns;
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

  for (const dir of projectDirs) {
    for (const file of walkJsonl(path.join(PROJECTS_DIR, dir.name), [])) {
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      // a transcript untouched since the cutoff holds nothing in range
      if (st.mtimeMs < cutoff) continue;
      filesScanned++;
      turns.push(
        ...cachedParse(
          file,
          st.mtimeMs,
          st.size,
          (text) => parseClaudeTurns(text, dir.name, cutoff),
          []
        )
      );
    }
  }

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

function parseCodexFile(text: string, project: string, cutoff: number): CodexParse {
  const turns: Turn[] = [];
  let quota: QuotaInfo | null = null;
  let lastModel: { model: string; at: number } | null = null;
  let model: string | null = null;
  let requests = 0;

  for (const line of text.split("\n")) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = entry?.timestamp ? Date.parse(entry.timestamp) : 0;

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
        project,
        input: used.input_tokens ?? 0,
        output: used.output_tokens ?? 0,
        cacheRead: used.cached_input_tokens ?? 0,
        cacheWrite: 0,
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
      (text) => parseCodexFile(text, path.basename(file), cutoff),
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
