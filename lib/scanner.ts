import fs from "fs";
import path from "path";
import os from "os";

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// A file written within this window is considered "active" (being worked on right now).
const ACTIVE_WINDOW_MS = 60_000;

// Communication events (teammate messages, agent spawns) stay visible this long.
const COMM_WINDOW_MS = 90_000;

// One rendered line of a session's conversation trace.
export interface TraceItem {
  kind: "user" | "assistant" | "tool" | "tool_result";
  name?: string;
  text: string;
  ts: number;
}

export interface CommEvent {
  peer: string;
  direction: "in" | "out";
  timestamp: number;
  label: string | null;
}

export interface AgentInfo {
  id: string;
  agentType: string | null;
  description: string | null;
  workflowId: string | null;
  startedAt: number;
  lastActivity: number;
  active: boolean;
  // Direction of the most recent transcript entry, only set while active:
  // "toAgent" = main sent the agent input, "toMain" = agent produced output.
  flow: "toAgent" | "toMain" | null;
  flowLabel: string | null;
}

export interface SessionInfo {
  id: string;
  project: string;
  firstPrompt: string | null;
  gitBranch: string | null;
  cwd: string | null;
  agentName: string | null; // set when this session IS a named teammate agent
  teamName: string | null; // "session-<shortid>" of the spawning session
  model: string | null; // model of the most recent assistant turn
  startedAt: number;
  lastActivity: number;
  active: boolean;
  agents: AgentInfo[];
  comms: CommEvent[];
}

export interface ProjectInfo {
  name: string;
  displayName: string;
  lastActivity: number;
  sessions: SessionInfo[];
}

export interface Snapshot {
  generatedAt: number;
  projects: ProjectInfo[];
}

// The first user prompt / branch / cwd of a session never change — cache per session file.
const headerCache = new Map<
  string,
  {
    firstPrompt: string | null;
    gitBranch: string | null;
    cwd: string | null;
    agentName: string | null;
    teamName: string | null;
  }
>();

function readSessionHeader(filePath: string) {
  const cached = headerCache.get(filePath);
  if (cached) return cached;

  let firstPrompt: string | null = null;
  let gitBranch: string | null = null;
  let cwd: string | null = null;
  let agentName: string | null = null;
  let teamName: string | null = null;

  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);

    for (const line of buf.toString("utf8", 0, bytes).split("\n")) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // last line may be truncated by our fixed-size read
      }
      if (entry?.type !== "user" || !entry.message) continue;

      gitBranch = entry.gitBranch ?? null;
      cwd = entry.cwd ?? null;
      agentName = entry.agentName ?? null;
      teamName = entry.teamName ?? null;

      const content = entry.message.content;
      if (typeof content === "string") {
        firstPrompt = content;
      } else if (Array.isArray(content)) {
        const text = content.find((c: any) => c?.type === "text");
        firstPrompt = text?.text ?? null;
      }
      if (firstPrompt) {
        firstPrompt = firstPrompt.replace(/\s+/g, " ").trim().slice(0, 200);
      }
      break;
    }
  } catch {
    // unreadable file — leave everything null
  }

  const header = { firstPrompt, gitBranch, cwd, agentName, teamName };
  // Only cache once we found the prompt; a brand-new session file may not have it yet.
  if (firstPrompt !== null) headerCache.set(filePath, header);
  return header;
}

// Read the last `bytes` of a file and return its complete JSONL lines.
function readTailLines(filePath: string, bytes: number): string[] {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(Math.min(bytes, stat.size));
    const read = fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString("utf8", 0, read).split("\n");
    if (start > 0) lines.shift(); // first line is almost certainly truncated
    return lines;
  } catch {
    return [];
  }
}

// A session can switch models mid-run (/model), so the model shown is the one
// from the latest assistant turn. Cached per file+mtime: an idle transcript is
// read once, an active one only re-read after it grows.
const modelCache = new Map<string, { mtime: number; model: string | null }>();

function readSessionModel(filePath: string, mtime: number): string | null {
  const cached = modelCache.get(filePath);
  if (cached && cached.mtime === mtime) return cached.model;

  let model: string | null = null;
  for (const line of readTailLines(filePath, 64 * 1024)) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const m = entry.message?.model;
    // "<synthetic>" marks locally-generated messages (API errors, notices)
    if (typeof m === "string" && m && m !== "<synthetic>") model = m;
  }
  // A tail made up entirely of tool results holds no assistant entry — in that
  // case keep the last model we saw rather than flickering back to unknown.
  if (model === null && cached) model = cached.model;

  modelCache.set(filePath, { mtime, model });
  return model;
}

// Recent teammate/agent communication events in a session transcript:
// incoming <teammate-message teammate_id="X"> entries and outgoing
// SendMessage / Agent-spawn tool calls.
function readRecentComms(filePath: string, now: number): CommEvent[] {
  const comms: CommEvent[] = [];
  for (const line of readTailLines(filePath, 128 * 1024)) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = entry?.timestamp ? Date.parse(entry.timestamp) : 0;
    if (!ts || now - ts > COMM_WINDOW_MS) continue;

    const content = entry.message?.content;
    if (entry.type === "user") {
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((c: any) => c?.text ?? "").join(" ")
            : "";
      const m = text.match(/<teammate-message teammate_id="([^"]+)"([^>]*)>/);
      if (m) {
        let label = m[2].match(/summary="([^"]*)"/)?.[1] ?? null;
        if (!label) {
          const inner = text
            .replace(/[\s\S]*?<teammate-message[^>]*>/, "")
            .replace(/<\/teammate-message>[\s\S]*/, "")
            .replace(/\s+/g, " ")
            .trim();
          label = inner.includes('"idle_notification"')
            ? "went idle"
            : inner.slice(0, 60) || null;
        }
        comms.push({ peer: m[1], direction: "in", timestamp: ts, label });
      }
    } else if (entry.type === "assistant" && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== "tool_use") continue;
        if (c.name === "SendMessage" && c.input?.to) {
          const label =
            c.input.summary ??
            (typeof c.input.message === "string"
              ? c.input.message.replace(/\s+/g, " ").slice(0, 60)
              : null);
          comms.push({ peer: String(c.input.to), direction: "out", timestamp: ts, label });
        } else if (c.name === "Agent" && c.input?.name) {
          comms.push({
            peer: String(c.input.name),
            direction: "out",
            timestamp: ts,
            label: c.input.description ?? "spawn agent",
          });
        }
      }
    }
  }
  return comms;
}

// For an actively-writing agent transcript: direction of the latest entry and
// a short description of what the agent is doing (tool in use / text snippet).
function readAgentActivity(filePath: string): {
  flow: "toAgent" | "toMain" | null;
  label: string | null;
} {
  let flow: "toAgent" | "toMain" | null = null;
  let label: string | null = null;
  for (const line of readTailLines(filePath, 32 * 1024)) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "user") {
      flow = "toAgent";
      label = null;
    } else if (entry?.type === "assistant") {
      flow = "toMain";
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === "tool_use") label = `using ${c.name}`;
          else if (c?.type === "text" && c.text?.trim()) {
            label = c.text.replace(/\s+/g, " ").trim().slice(0, 50);
          }
        }
      }
    }
  }
  return { flow, label };
}

function scanAgents(sessionDir: string, now: number): AgentInfo[] {
  const agents: AgentInfo[] = [];

  const collect = (dir: string, workflowId: string | null) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "workflows") {
          for (const wf of fs.readdirSync(full, { withFileTypes: true })) {
            if (wf.isDirectory()) collect(path.join(full, wf.name), wf.name);
          }
        }
        continue;
      }
      if (!entry.name.startsWith("agent-") || !entry.name.endsWith(".jsonl")) continue;

      const id = entry.name.slice("agent-".length, -".jsonl".length);
      let mtime = 0;
      let birth = 0;
      try {
        const st = fs.statSync(full);
        mtime = st.mtimeMs;
        birth = st.birthtimeMs || st.mtimeMs;
      } catch {
        continue;
      }

      let agentType: string | null = null;
      let description: string | null = null;
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(dir, `agent-${id}.meta.json`), "utf8")
        );
        agentType = meta.agentType ?? null;
        description = meta.description ?? null;
      } catch {
        // meta file may not exist (yet)
      }

      const active = now - mtime < ACTIVE_WINDOW_MS;
      const activity = active
        ? readAgentActivity(full)
        : { flow: null, label: null };
      agents.push({
        id,
        agentType,
        description,
        workflowId,
        startedAt: birth,
        lastActivity: mtime,
        active,
        flow: activity.flow,
        flowLabel: activity.label,
      });
    }
  };

  collect(path.join(sessionDir, "subagents"), null);
  agents.sort((a, b) => b.lastActivity - a.lastActivity);
  return agents;
}

// Share one scan across all connected SSE clients instead of one per tab.
let lastScan: { at: number; snapshot: Snapshot } | null = null;

export function scanCached(maxAgeMs = 1000): Snapshot {
  const now = Date.now();
  if (lastScan && now - lastScan.at < maxAgeMs) return lastScan.snapshot;
  const snapshot = scan();
  lastScan = { at: now, snapshot };
  return snapshot;
}

export function scan(): Snapshot {
  const now = Date.now();
  const projects: ProjectInfo[] = [];

  let projectDirs: fs.Dirent[] = [];
  try {
    projectDirs = fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory());
  } catch {
    return { generatedAt: now, projects: [] };
  }

  for (const projectDir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, projectDir.name);
    const sessions: SessionInfo[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = entry.name.slice(0, -".jsonl".length);
      const filePath = path.join(projectPath, entry.name);

      let mtime = 0;
      let birth = 0;
      try {
        const st = fs.statSync(filePath);
        mtime = st.mtimeMs;
        birth = st.birthtimeMs || st.mtimeMs;
      } catch {
        continue;
      }

      const header = readSessionHeader(filePath);
      const agents = scanAgents(path.join(projectPath, sessionId), now);
      const lastActivity = Math.max(mtime, ...agents.map((a) => a.lastActivity));

      sessions.push({
        id: sessionId,
        project: projectDir.name,
        firstPrompt: header.firstPrompt,
        gitBranch: header.gitBranch,
        cwd: header.cwd,
        agentName: header.agentName,
        teamName: header.teamName,
        model: readSessionModel(filePath, mtime),
        startedAt: birth,
        lastActivity,
        active: now - lastActivity < ACTIVE_WINDOW_MS,
        agents,
        // Only recently-written transcripts can contain in-window comm events.
        comms:
          now - mtime < COMM_WINDOW_MS ? readRecentComms(filePath, now) : [],
      });
    }

    if (sessions.length === 0) continue;
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    // The directory name flattens "/" and "-" identically, so prefer the real
    // cwd recorded inside a session transcript.
    const cwd = sessions.find((s) => s.cwd)?.cwd ?? null;
    projects.push({
      name: projectDir.name,
      displayName: cwd ?? projectDir.name,
      lastActivity: sessions[0].lastActivity,
      sessions,
    });
  }

  projects.sort((a, b) => b.lastActivity - a.lastActivity);
  return { generatedAt: now, projects };
}
