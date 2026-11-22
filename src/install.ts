import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter } from "./adapters/index.js";
import type { HookSpec } from "./adapters/types.js";
import { isRecord } from "./jsonutil.js";
import { ensureDir, shellQuote, writeJsonAtomic } from "./paths.js";
import type { AdapterId } from "./types.js";

export interface Invocation {
  node: string;
  script: string;
  args: string[];
  shell: string;
}

export function invocation(adapter: AdapterId, node = process.execPath, script = cliScript()): Invocation {
  const args = [script, "hook", "--spendguard"];
  if (adapter !== "claude-code") args.push("--adapter", adapter);
  const shell = [shellQuote(node), ...args.map(shellQuote)].join(" ");
  return { node, script, args, shell };
}

export function cliScript(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

export function defaultSettingsPath(adapter: AdapterId, scope: "user" | "project", cwd = process.cwd()): string {
  if (adapter === "openclaw") {
    throw new Error("OpenClaw has no shell-hook settings file. See adapters/openclaw/handler.mjs.");
  }
  if (adapter === "gemini-cli") {
    return scope === "project"
      ? path.join(cwd, ".gemini", "settings.json")
      : path.join(os.homedir(), ".gemini", "settings.json");
  }
  if (adapter === "claude-code") {
    return scope === "project"
      ? path.join(cwd, ".claude", "settings.json")
      : path.join(os.homedir(), ".claude", "settings.json");
  }
  if (adapter === "codex") {
    const root = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
    return scope === "project" ? path.join(cwd, ".codex", "hooks.json") : path.join(root, "hooks.json");
  }
  return scope === "project" ? path.join(cwd, ".cursor", "hooks.json") : path.join(os.homedir(), ".cursor", "hooks.json");
}

export function installHooks(options: {
  adapter: AdapterId;
  settingsPath: string;
  invocation: Invocation;
}): { changed: boolean; settings: Record<string, unknown> } {
  const existing = readSettings(options.settingsPath);
  const next =
    options.adapter === "cursor"
      ? mergeCursor(existing, options.invocation.shell)
      : mergeNested(existing, options.adapter, options.invocation);
  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  if (changed) writeJsonAtomic(options.settingsPath, next);
  return { changed, settings: next };
}

export function uninstallHooks(settingsPath: string): { changed: boolean; settings: Record<string, unknown> } {
  const existing = readSettings(settingsPath);
  const next = stripOurs(existing);
  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  if (changed) writeJsonAtomic(settingsPath, next);
  return { changed, settings: next };
}

export function skillSource(): string {
  return walkUp("skill", "SKILL.md");
}

export function installSkill(destination: string): void {
  ensureDir(path.dirname(destination));
  fs.copyFileSync(skillSource(), destination);
}

export function mcpSnippet(invoke: Invocation): Record<string, unknown> {
  return {
    mcpServers: {
      spendguard: {
        command: invoke.node,
        args: [invoke.script, "mcp"],
      },
    },
  };
}

export function installMcp(file: string, invoke: Invocation): { changed: boolean } {
  const existing = readSettings(file);
  const servers = isRecord(existing.mcpServers) ? { ...existing.mcpServers } : {};
  servers.spendguard = { command: invoke.node, args: [invoke.script, "mcp"] };
  const next = { ...existing, mcpServers: servers };
  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  if (changed) writeJsonAtomic(file, next);
  return { changed };
}

function mergeNested(existing: Record<string, unknown>, adapter: AdapterId, invoke: Invocation): Record<string, unknown> {
  const specs = getAdapter(adapter).hookSpecs;
  const root: Record<string, unknown> = { ...existing };
  const hooks = isRecord(root.hooks) ? { ...root.hooks } : {};
  for (const spec of specs) {
    const groups = (Array.isArray(hooks[spec.event]) ? hooks[spec.event] : []) as unknown[];
    const cleaned = groups
      .map((group) => stripGroup(group))
      .filter((group) => isRecord(group) && Array.isArray(group.hooks) && group.hooks.length > 0);
    const hook = nestedHook(adapter, spec, invoke);
    const target = cleaned.find(
      (group) => isRecord(group) && (group.matcher === undefined || group.matcher === "" || group.matcher === "*"),
    );
    if (isRecord(target) && Array.isArray(target.hooks)) {
      target.hooks = [...target.hooks, hook];
    } else {
      cleaned.push({ hooks: [hook] });
    }
    hooks[spec.event] = cleaned;
  }
  root.hooks = hooks;
  return root;
}

function nestedHook(adapter: AdapterId, spec: HookSpec, invoke: Invocation): Record<string, unknown> {
  if (adapter === "gemini-cli") {
    return {
      type: "command",
      name: "spendguard",
      command: invoke.shell,
      timeout: spec.timeout,
    };
  }
  if (adapter === "claude-code") {
    const hook: Record<string, unknown> = {
      type: "command",
      command: invoke.node,
      args: invoke.args,
      timeout: spec.timeout,
    };
    if (spec.onFailure) hook.onFailure = spec.onFailure;
    if (spec.statusMessage) hook.statusMessage = spec.statusMessage;
    return hook;
  }
  const hook: Record<string, unknown> = {
    type: "command",
    command: invoke.shell,
    timeout: spec.timeout,
  };
  if (spec.statusMessage) hook.statusMessage = spec.statusMessage;
  return hook;
}

function mergeCursor(existing: Record<string, unknown>, shell: string): Record<string, unknown> {
  const root: Record<string, unknown> = { ...existing, version: 1 };
  const hooks = isRecord(root.hooks) ? { ...root.hooks } : {};
  for (const spec of getAdapter("cursor").hookSpecs) {
    const existingHooks = hooks[spec.event];
    const current = Array.isArray(existingHooks) ? existingHooks.filter((hook: unknown) => !isOurs(hook)) : [];
    const hook: Record<string, unknown> = { command: shell, timeout: spec.timeout };
    if (spec.failClosed !== undefined) hook.failClosed = spec.failClosed;
    hooks[spec.event] = [...current, hook];
  }
  root.hooks = hooks;
  return root;
}

function stripOurs(existing: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = { ...existing };
  if (!isRecord(root.hooks)) return root;
  const hooks: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(root.hooks)) {
    if (!Array.isArray(value)) continue;
    if (value.some((item) => isRecord(item) && Array.isArray(item.hooks))) {
      const groups = value
        .map((group) => stripGroup(group))
        .filter((group) => isRecord(group) && Array.isArray(group.hooks) && group.hooks.length > 0);
      if (groups.length > 0) hooks[event] = groups;
    } else {
      const flat = value.filter((hook) => !isOurs(hook));
      if (flat.length > 0) hooks[event] = flat;
    }
  }
  if (Object.keys(hooks).length === 0) delete root.hooks;
  else root.hooks = hooks;
  return root;
}

function stripGroup(group: unknown): unknown {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return group;
  return { ...group, hooks: group.hooks.filter((hook) => !isOurs(hook)) };
}

function isOurs(hook: unknown): boolean {
  if (!isRecord(hook)) return false;
  if (Array.isArray(hook.args) && hook.args.some((arg) => arg === "--spendguard")) return true;
  return typeof hook.command === "string" && hook.command.includes("--spendguard");
}

function readSettings(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing to edit ${file}: ${message}`);
  }
  if (!isRecord(parsed)) throw new Error(`Refusing to edit ${file}: expected a JSON object`);
  return parsed;
}

function walkUp(directory: string, file: string): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, directory, file);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find ${directory}/${file}`);
}
