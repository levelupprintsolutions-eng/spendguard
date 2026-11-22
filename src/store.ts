import fs from "node:fs";
import path from "node:path";
import { isRecord } from "./jsonutil.js";
import { readJsonFile, resolveHome, withLock, writeJsonAtomic } from "./paths.js";
import type { AdapterId, Config, KillRecord, Kills, Ledger, SessionRecord } from "./types.js";

export interface StorePaths {
  home: string;
  config: string;
  kills: string;
  ledger: string;
}

export function storePaths(home?: string): StorePaths {
  const root = resolveHome(home);
  return {
    home: root,
    config: path.join(root, "config.json"),
    kills: path.join(root, "kills.json"),
    ledger: path.join(root, "ledger.json"),
  };
}

export function defaultConfig(): Config {
  return {
    version: 1,
    thresholds: [0.5, 0.8],
    blockAtRatio: 1,
    blockWhenSpendUnknown: false,
    global: { session: null, daily: null },
    projects: {},
    sessions: {},
    subagents: {},
  };
}

export function defaultKills(): Kills {
  return { version: 1, global: null, projects: {}, sessions: {} };
}

export function defaultLedger(): Ledger {
  return { version: 1, sessions: {}, warnings: [] };
}

export function loadConfig(home?: string): Config {
  const file = storePaths(home).config;
  if (!fs.existsSync(file)) return defaultConfig();
  return normalizeConfig(readJsonFile(file));
}

export function loadKills(home?: string): Kills {
  const file = storePaths(home).kills;
  if (!fs.existsSync(file)) return defaultKills();
  return normalizeKills(readJsonFile(file));
}

export function loadLedger(home?: string): Ledger {
  const file = storePaths(home).ledger;
  if (!fs.existsSync(file)) return defaultLedger();
  return normalizeLedger(readJsonFile(file));
}

export function saveConfig(config: Config, home?: string): void {
  writeJsonAtomic(storePaths(home).config, config);
}

export function saveKills(kills: Kills, home?: string): void {
  writeJsonAtomic(storePaths(home).kills, kills);
}

export function saveLedger(ledger: Ledger, home?: string): void {
  writeJsonAtomic(storePaths(home).ledger, ledger);
}

export function updateStore<T>(
  home: string | undefined,
  fn: (state: { config: Config; kills: Kills; ledger: Ledger }) => T,
): T {
  const paths = storePaths(home);
  return withLock(paths.home, () => {
    const state = {
      config: loadConfig(paths.home),
      kills: loadKills(paths.home),
      ledger: loadLedger(paths.home),
    };
    const result = fn(state);
    saveConfig(state.config, paths.home);
    saveKills(state.kills, paths.home);
    saveLedger(state.ledger, paths.home);
    return result;
  });
}

export function emptySession(input: {
  id: string;
  adapter: AdapterId;
  cwd: string;
  projectKey: string;
  now: Date;
}): SessionRecord {
  const iso = input.now.toISOString();
  return {
    id: input.id,
    adapter: input.adapter,
    cwd: input.cwd,
    projectKey: input.projectKey,
    createdAt: iso,
    updatedAt: iso,
    usageKnown: false,
    transcripts: {},
    agents: {},
    usageEvents: {},
  };
}

function normalizeConfig(raw: unknown): Config {
  const config = defaultConfig();
  if (!isRecord(raw)) return config;
  if (Array.isArray(raw.thresholds)) {
    const thresholds = raw.thresholds.filter((item): item is number => typeof item === "number");
    if (thresholds.length > 0) config.thresholds = [...thresholds].sort((a, b) => a - b);
  }
  if (typeof raw.blockAtRatio === "number" && raw.blockAtRatio > 0 && raw.blockAtRatio <= 1) {
    config.blockAtRatio = raw.blockAtRatio;
  }
  if (typeof raw.blockWhenSpendUnknown === "boolean") {
    config.blockWhenSpendUnknown = raw.blockWhenSpendUnknown;
  }
  if (isRecord(raw.global)) {
    config.global = {
      session: asCap(raw.global.session),
      daily: asCap(raw.global.daily),
    };
  }
  if (isRecord(raw.projects)) {
    for (const [key, value] of Object.entries(raw.projects)) {
      if (!isRecord(value)) continue;
      config.projects[key] = { session: asCap(value.session), daily: asCap(value.daily) };
    }
  }
  if (isRecord(raw.sessions)) {
    for (const [key, value] of Object.entries(raw.sessions)) {
      const cap = asCap(value);
      if (cap) config.sessions[key] = cap;
    }
  }
  if (isRecord(raw.subagents)) {
    for (const [key, value] of Object.entries(raw.subagents)) {
      const cap = asCap(value);
      if (cap) config.subagents[key] = cap;
    }
  }
  return config;
}

function asCap(value: unknown): { usd?: number; tokens?: number } | null {
  if (!isRecord(value)) return null;
  const cap: { usd?: number; tokens?: number } = {};
  if (typeof value.usd === "number" && Number.isFinite(value.usd) && value.usd >= 0) cap.usd = value.usd;
  if (typeof value.tokens === "number" && Number.isFinite(value.tokens) && value.tokens >= 0) {
    cap.tokens = value.tokens;
  }
  return cap.usd === undefined && cap.tokens === undefined ? null : cap;
}

function normalizeKills(raw: unknown): Kills {
  const kills = defaultKills();
  if (!isRecord(raw)) return kills;
  kills.global = asKill(raw.global);
  if (isRecord(raw.projects)) {
    for (const [key, value] of Object.entries(raw.projects)) {
      const kill = asKill(value);
      if (kill) kills.projects[key] = kill;
    }
  }
  if (isRecord(raw.sessions)) {
    for (const [key, value] of Object.entries(raw.sessions)) {
      const kill = asKill(value);
      if (kill) kills.sessions[key] = kill;
    }
  }
  return kills;
}

function asKill(value: unknown): KillRecord | null {
  if (!isRecord(value) || typeof value.at !== "string") return null;
  return { at: value.at, reason: typeof value.reason === "string" ? value.reason : "manual kill switch" };
}

function normalizeLedger(raw: unknown): Ledger {
  const ledger = defaultLedger();
  if (!isRecord(raw)) return ledger;
  if (Array.isArray(raw.warnings)) {
    ledger.warnings = raw.warnings.filter((item): item is string => typeof item === "string");
  }
  if (!isRecord(raw.sessions)) return ledger;
  for (const [id, value] of Object.entries(raw.sessions)) {
    if (!isRecord(value)) continue;
    const session = emptySession({
      id,
      adapter: asAdapter(value.adapter),
      cwd: typeof value.cwd === "string" ? value.cwd : "",
      projectKey: typeof value.projectKey === "string" ? value.projectKey : "",
      now: new Date(typeof value.createdAt === "string" ? value.createdAt : Date.now()),
    });
    if (typeof value.createdAt === "string") session.createdAt = value.createdAt;
    if (typeof value.updatedAt === "string") session.updatedAt = value.updatedAt;
    session.usageKnown = value.usageKnown === true;
    session.transcripts = isRecord(value.transcripts) ? (value.transcripts as SessionRecord["transcripts"]) : {};
    session.usageEvents = isRecord(value.usageEvents) ? (value.usageEvents as SessionRecord["usageEvents"]) : {};
    if (isRecord(value.agents)) session.agents = value.agents as SessionRecord["agents"];
    ledger.sessions[id] = session;
  }
  return ledger;
}

function asAdapter(value: unknown): AdapterId {
  if (
    value === "codex" ||
    value === "cursor" ||
    value === "openclaw" ||
    value === "claude-code" ||
    value === "gemini-cli" ||
    value === "proxy"
  ) {
    return value;
  }
  return "claude-code";
}
