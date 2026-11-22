import { pathUnder, resolveExisting } from "./paths.js";
import { loadConfig, saveConfig, updateStore } from "./store.js";
import type { Cap, Config, ProjectBudget } from "./types.js";

export interface BudgetScope {
  kind: "global-session" | "global-daily" | "project-session" | "project-daily" | "session" | "subagent";
  project?: string;
  sessionId?: string;
  agentId?: string;
}

export function parseCap(usd: number | undefined, tokens: number | undefined): Cap {
  const cap: Cap = {};
  if (usd !== undefined) {
    if (!Number.isFinite(usd) || usd < 0) throw new Error("--usd must be a number >= 0");
    cap.usd = usd;
  }
  if (tokens !== undefined) {
    if (!Number.isFinite(tokens) || tokens < 0) throw new Error("--tokens must be a number >= 0");
    cap.tokens = tokens;
  }
  if (cap.usd === undefined && cap.tokens === undefined) {
    throw new Error("Pass --usd or --tokens (or both).");
  }
  return cap;
}

export function setBudget(home: string, scope: BudgetScope, cap: Cap): Config {
  return updateStore(home, ({ config }) => {
    assign(config, scope, cap);
    return config;
  });
}

export function clearBudget(home: string, scope: BudgetScope): Config {
  return updateStore(home, ({ config }) => {
    assign(config, scope, null);
    return config;
  });
}

export function setBlockAt(home: string, ratio: number): Config {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new Error("--block-at must be greater than 0 and at most 1");
  }
  return updateStore(home, ({ config }) => {
    config.blockAtRatio = ratio;
    return config;
  });
}

export function setStrict(home: string, enabled: boolean): Config {
  return updateStore(home, ({ config }) => {
    config.blockWhenSpendUnknown = enabled;
    return config;
  });
}

export function setThresholds(home: string, thresholds: number[]): Config {
  if (thresholds.length === 0) throw new Error("Pass at least one threshold between 0 and 1.");
  for (const threshold of thresholds) {
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
      throw new Error(`Threshold ${threshold} must be greater than 0 and less than 1.`);
    }
  }
  return updateStore(home, ({ config }) => {
    config.thresholds = [...thresholds].sort((a, b) => a - b);
    return config;
  });
}

export function showConfig(home: string): Config {
  return loadConfig(home);
}

function assign(config: Config, scope: BudgetScope, cap: Cap | null): void {
  if (scope.kind === "global-session") {
    config.global.session = cap;
    return;
  }
  if (scope.kind === "global-daily") {
    config.global.daily = cap;
    return;
  }
  if (scope.kind === "project-session" || scope.kind === "project-daily") {
    const key = resolveExisting(scope.project ?? process.cwd());
    const project = config.projects[key] ?? { session: null, daily: null };
    if (scope.kind === "project-session") project.session = cap;
    else project.daily = cap;
    if (!project.session && !project.daily) delete config.projects[key];
    else config.projects[key] = project;
    return;
  }
  if (scope.kind === "session") {
    const id = required(scope.sessionId, "session id");
    if (cap) config.sessions[id] = cap;
    else delete config.sessions[id];
    return;
  }
  const sessionId = required(scope.sessionId, "session id");
  const agentId = required(scope.agentId, "subagent id");
  const key = `${sessionId}:${agentId}`;
  if (cap) config.subagents[key] = cap;
  else delete config.subagents[key];
}

export function matchProject(config: Config, projectKey: string): { key: string; budget: ProjectBudget } | null {
  let bestKey: string | null = null;
  for (const key of Object.keys(config.projects)) {
    if (!pathUnder(key, projectKey)) continue;
    if (!bestKey || key.length > bestKey.length) bestKey = key;
  }
  if (!bestKey) return null;
  return { key: bestKey, budget: config.projects[bestKey] ?? { session: null, daily: null } };
}

export function resolveProjectBudget(config: Config, projectKey: string): ProjectBudget {
  return matchProject(config, projectKey)?.budget ?? { session: null, daily: null };
}

export function resolveSessionCap(config: Config, sessionId: string, projectKey: string): Cap | null {
  return config.sessions[sessionId] ?? resolveProjectBudget(config, projectKey).session ?? config.global.session;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}
