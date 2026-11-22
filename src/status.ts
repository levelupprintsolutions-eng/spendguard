import fs from "node:fs";
import path from "node:path";
import { matchProject, resolveSessionCap } from "./budget.js";
import { formatPct, formatTokens, formatUsd, usdToNano } from "./money.js";
import { dayKey, pathUnder } from "./paths.js";
import { loadPriceTable, type PriceTable } from "./pricing.js";
import { pictureFor, type SpendPicture } from "./rollup.js";
import { emptySession, loadConfig, loadKills, loadLedger, saveLedger } from "./store.js";
import { parseTranscript } from "./transcript.js";
import type { Cap, Config, Ledger, SessionRecord } from "./types.js";

export interface AgentSummary {
  id: string;
  type?: string;
  nanoUsd: number;
  tokens: number;
  cap: Cap | null;
}

export interface SessionSummary {
  id: string;
  adapter: string;
  cwd: string;
  projectKey: string;
  updatedAt: string;
  usageKnown: boolean;
  nanoUsd: number;
  tokens: number;
  estimated: boolean;
  cap: Cap | null;
  agents: AgentSummary[];
  models: SpendPicture["models"];
}

export interface StatusReport {
  day: string;
  thresholds: number[];
  blockAtRatio: number;
  strict: boolean;
  defaultSession: Cap | null;
  killGlobal: string | null;
  killedSessions: string[];
  killedProjects: string[];
  dailyGlobal: { nanoUsd: number; tokens: number; cap: Cap | null; incomplete: boolean };
  sessions: SessionSummary[];
}

export function buildStatus(options: {
  home: string;
  now?: Date;
  sessionId?: string;
  scan?: boolean;
  claudeProjects?: string;
  maxFiles?: number;
  maxAgeMs?: number;
}): StatusReport {
  const now = options.now ?? new Date();
  const config = loadConfig(options.home);
  const kills = loadKills(options.home);
  const ledger = loadLedger(options.home);
  if (options.scan && options.claudeProjects) {
    const found = discoverClaude(ledger, options.claudeProjects, now, options.maxFiles ?? 200, options.maxAgeMs ?? 7 * 86_400_000);
    if (found) saveLedger(ledger, options.home);
  }
  const table = loadPriceTable({ home: options.home });
  const day = dayKey(now);
  const sessions = Object.values(ledger.sessions)
    .map((session) => summarize(session, ledger, config, table, day))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const visible = options.sessionId ? sessions.filter((session) => session.id === options.sessionId) : sessions;
  const daily = pictureFor({
    ledger,
    sessionId: visible[0]?.id ?? "",
    projectKey: "",
    day,
    table,
  });
  return {
    day,
    thresholds: config.thresholds,
    blockAtRatio: config.blockAtRatio,
    strict: config.blockWhenSpendUnknown,
    defaultSession: config.global.session,
    killGlobal: kills.global?.reason ?? null,
    killedSessions: Object.keys(kills.sessions),
    killedProjects: Object.keys(kills.projects),
    dailyGlobal: {
      nanoUsd: daily.dailyGlobal.nanoUsd,
      tokens: daily.dailyGlobal.tokens,
      cap: config.global.daily,
      incomplete: daily.dailyGlobal.incomplete,
    },
    sessions: visible,
  };
}

export function formatStatus(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`Day ${report.day}`);
  lines.push(
    `Thresholds ${report.thresholds.map((item) => formatPct(item)).join(", ")} · block at ${formatPct(report.blockAtRatio)}${report.strict ? " · strict unknown spend" : ""}`,
  );
  if (report.killGlobal) lines.push(`Global kill switch: ON (${report.killGlobal})`);
  const fallback = report.defaultSession;
  const fallbackUsd = fallback?.usd !== undefined ? formatUsd(usdToNano(fallback.usd)) : "none";
  const fallbackTokens = fallback?.tokens !== undefined ? ` and ${formatTokens(fallback.tokens)} tokens` : "";
  lines.push(`Default session cap: ${fallbackUsd}${fallbackTokens}`);
  lines.push(capLine("Global daily", report.dailyGlobal.nanoUsd, report.dailyGlobal.tokens, report.dailyGlobal.cap));
  if (report.dailyGlobal.incomplete) {
    lines.push("Daily total omits sessions whose host has not reported usage.");
  }
  if (report.sessions.length === 0) {
    lines.push("No sessions recorded yet. Install hooks, then start an agent, or run `spendguard demo`.");
    return lines.join("\n");
  }
  for (const session of report.sessions) {
    lines.push("");
    const killed =
      report.killedSessions.includes(session.id) ||
      report.killedProjects.some((project) => session.projectKey && pathUnder(project, session.projectKey))
        ? " · KILLED"
        : "";
    const known = session.usageKnown ? "" : " · usage unknown";
    const estimated = session.estimated ? " · estimated price" : "";
    lines.push(`${session.id}  ${session.adapter}${killed}${known}${estimated}`);
    if (session.cwd) lines.push(`  cwd ${session.cwd}`);
    lines.push(`  ${capLine("session", session.nanoUsd, session.tokens, session.cap)}`);
    for (const model of session.models) {
      lines.push(`  ${model.modelId}  ${formatUsd(model.nanoUsd)}  ${formatTokens(model.tokens)} tokens`);
    }
    for (const agent of session.agents) {
      const cap = agent.cap?.usd !== undefined ? ` / ${formatUsd(usdToNano(agent.cap.usd))}` : "";
      lines.push(`  subagent ${agent.id}${agent.type ? ` (${agent.type})` : ""}  ${formatUsd(agent.nanoUsd)}${cap}`);
    }
  }
  return lines.join("\n");
}

export function resolveSessionPrefix(ledger: Ledger, input: string): string {
  if (ledger.sessions[input]) return input;
  if (input.length < 4) return input;
  const matches = Object.keys(ledger.sessions).filter((id) => id.startsWith(input));
  if (matches.length === 1) return matches[0] ?? input;
  if (matches.length > 1) {
    throw new Error(`Session prefix "${input}" matches ${matches.join(", ")}. Pass a longer id.`);
  }
  return input;
}

function summarize(
  session: SessionRecord,
  ledger: Ledger,
  config: Config,
  table: PriceTable,
  day: string,
): SessionSummary {
  const picture = pictureFor({
    ledger,
    sessionId: session.id,
    projectKey: session.projectKey,
    day,
    table,
  });
  const matched = session.projectKey ? matchProject(config, session.projectKey) : null;
  const agents = Object.entries(session.agents).map(([id, meta]) => {
    const agentPicture = pictureFor({
      ledger,
      sessionId: session.id,
      agentId: id,
      projectKey: matched?.key ?? session.projectKey,
      day,
      table,
    });
    return {
      id,
      ...(meta.type ? { type: meta.type } : {}),
      nanoUsd: agentPicture.agent?.nanoUsd ?? 0,
      tokens: agentPicture.agent?.tokens ?? 0,
      cap: config.subagents[`${session.id}:${id}`] ?? null,
    };
  });
  return {
    id: session.id,
    adapter: session.adapter,
    cwd: session.cwd,
    projectKey: session.projectKey,
    updatedAt: session.updatedAt,
    usageKnown: session.usageKnown,
    nanoUsd: picture.session.nanoUsd,
    tokens: picture.session.tokens,
    estimated: picture.session.estimated,
    cap: resolveSessionCap(config, session.id, session.projectKey),
    agents,
    models: picture.models,
  };
}

function capLine(label: string, nano: number, tokens: number, cap: Cap | null): string {
  const usd = cap?.usd !== undefined ? `${formatUsd(nano)} / ${formatUsd(usdToNano(cap.usd))} (${formatPct(cap.usd === 0 ? 1 : nano / usdToNano(cap.usd))})` : formatUsd(nano);
  const tokenText =
    cap?.tokens !== undefined
      ? `${formatTokens(tokens)} / ${formatTokens(cap.tokens)} tokens`
      : `${formatTokens(tokens)} tokens`;
  return `${label}  ${usd}  ${tokenText}`;
}

function discoverClaude(ledger: Ledger, root: string, now: Date, maxFiles: number, maxAgeMs: number): boolean {
  if (!fs.existsSync(root)) return false;
  const files: Array<{ file: string; mtime: number }> = [];
  walk(root, files, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  let changed = false;
  const cutoff = now.getTime() - maxAgeMs;
  for (const entry of files.slice(0, maxFiles)) {
    if (entry.mtime < cutoff) continue;
    const id = path.basename(entry.file, ".jsonl");
    if (!id) continue;
    let session = ledger.sessions[id];
    if (!session) {
      session = emptySession({
        id,
        adapter: "claude-code",
        cwd: "",
        projectKey: path.basename(path.dirname(entry.file)),
        now: new Date(entry.mtime),
      });
      ledger.sessions[id] = session;
      changed = true;
    }
    const before = JSON.stringify(session.transcripts[entry.file] ?? null);
    const stat = fs.statSync(entry.file);
    const previous = session.transcripts[entry.file];
    if (!previous || previous.mtimeMs !== stat.mtimeMs || previous.size !== stat.size) {
      const parsed = parseTranscript(fs.readFileSync(entry.file, "utf8"), now);
      session.transcripts[entry.file] = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        agentId: previous?.agentId ?? null,
        usageFound: parsed.usageFound,
        messages: parsed.messages,
      };
      session.usageKnown = true;
      session.updatedAt = new Date(entry.mtime).toISOString();
      changed = true;
    }
    if (before !== JSON.stringify(session.transcripts[entry.file] ?? null)) changed = true;
  }
  return changed;
}

function walk(dir: string, acc: Array<{ file: string; mtime: number }>, depth: number): void {
  if (depth > 4 || acc.length > 5000) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const stat = fs.statSync(full);
        acc.push({ file: full, mtime: stat.mtimeMs });
      } catch {
        // Skip unreadable files.
      }
    }
  }
}
