#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAdapters, parseAdapterId } from "./adapters/index.js";
import {
  clearBudget,
  parseCap,
  setBlockAt,
  setBudget,
  setStrict,
  setThresholds,
  showConfig,
  type BudgetScope,
} from "./budget.js";
import { runDemo } from "./demo.js";
import { handleHook } from "./hook.js";
import {
  defaultSettingsPath,
  installHooks,
  installMcp,
  installSkill,
  invocation,
  mcpSnippet,
  skillSource,
  uninstallHooks,
} from "./install.js";
import { clearKill, engageKill, type KillScope } from "./kills.js";
import { serveMcp } from "./mcp.js";
import { startProxy } from "./proxy/server.js";
import { defaultUpstream, parseProxyProvider } from "./proxy/parse.js";
import { resolveHome } from "./paths.js";
import { loadPriceTable, type ModelPrice } from "./pricing.js";
import { loadLedger } from "./store.js";
import { buildStatus, formatStatus, resolveSessionPrefix } from "./status.js";
import type { AdapterId, Cap } from "./types.js";

interface Parsed {
  positionals: string[];
  flags: Map<string, string | true>;
  repeated: Map<string, string[]>;
}

const BOOLEANS = new Set([
  "json",
  "daily",
  "project",
  "skill",
  "mcp",
  "print",
  "strict",
  "no-strict",
  "all",
  "no-scan",
  "spendguard",
  "help",
  "version",
]);

function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    let name = arg.slice(2);
    let value: string | true = true;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    } else if (!BOOLEANS.has(name)) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      }
    }
    if (name === "adapter" && typeof value === "string") {
      const list = repeated.get(name) ?? [];
      list.push(value);
      repeated.set(name, list);
    }
    flags.set(name, value);
  }
  return { positionals, flags, repeated };
}

function flag(args: Parsed, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function on(args: Parsed, name: string): boolean {
  return args.flags.has(name);
}

function homeOf(args: Parsed): string {
  return resolveHome(flag(args, "home"));
}

function help(): string {
  return `spendguard — hard budget caps and a kill switch for coding agents

Usage
  spendguard demo
  spendguard init [--project] [--adapter claude|codex|cursor] [--skill] [--mcp]
  spendguard uninstall [--project] [--adapter claude|codex|cursor]
  spendguard budget set [--usd N] [--tokens N] [--daily] [--project] [--session ID]
  spendguard budget set --subagent ID --session ID --usd N
  spendguard budget set --block-at 0.95
  spendguard budget set --strict | --no-strict
  spendguard budget thresholds 0.5 0.8
  spendguard budget show [--json]
  spendguard budget clear [--daily] [--project] [--session ID]
  spendguard status [--session ID] [--json]
  spendguard kill [--session ID | --project] [--reason TEXT]
  spendguard resume [--session ID | --project | --all]
  spendguard prices [--json]
  spendguard adapters [--json]
  spendguard hook                 read a host hook payload on stdin
  spendguard mcp                  stdio MCP server (status only)
  spendguard proxy --provider anthropic|openai|gemini|xai [--port 8791] [--upstream URL]

The proxy listens on 127.0.0.1. Point an agent's API base URL at it and the
same caps and kill switch apply to the next provider request. Gemini CLI
hooks install with --adapter gemini. See docs/agents.md for what each host enforces.

State lives in ~/.spendguard (override with SPENDGUARD_HOME or --home).
A session cap replaces the project default, which replaces the global default.
Daily ceilings apply on top of the session cap. The tightest one stops the run.
The kill switch stops a run even when it is under budget.

Claude Code enforcement is on by default. Codex records token_usage and can
deny tools. Cursor's kill switch is real; dollar caps wait on a usage feed.
OpenClaw is a sample, not an installed enforcer. See \`spendguard adapters\`.
`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positionals[0] ?? "help";
  try {
    if (command === "help" || on(args, "help") || command === "--help") {
      console.log(help());
      return 0;
    }
    if (command === "version" || on(args, "version")) {
      console.log("0.1.0");
      return 0;
    }
    if (command === "demo") return commandDemo();
    if (command === "init") return commandInit(args);
    if (command === "uninstall") return commandUninstall(args);
    if (command === "budget") return commandBudget(args);
    if (command === "status" || command === "sessions") return commandStatus(args);
    if (command === "kill") return commandKill(args, true);
    if (command === "resume") return commandKill(args, false);
    if (command === "prices") return commandPrices(args);
    if (command === "adapters") return commandAdapters(args);
    if (command === "hook") return commandHook(args);
    if (command === "proxy") return commandProxy(args);
    if (command === "mcp") {
      await serveMcp(homeOf(args));
      return 0;
    }
    console.error(`Unknown command "${command}".\n`);
    console.error(help());
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function commandDemo(): number {
  const result = runDemo();
  console.log(result.text);
  return result.ok ? 0 : 1;
}

function commandInit(args: Parsed): number {
  const scope = on(args, "project") ? "project" : "user";
  const adapters = chosenAdapters(args);
  const lines: string[] = [];
  for (const adapter of adapters) {
    if (adapter === "openclaw") {
      lines.push("OpenClaw is a sample only. Read adapters/openclaw/HOOK.md. Nothing was installed.");
      continue;
    }
    const invoke = invocation(adapter);
    const settingsPath = flag(args, "settings") ?? defaultSettingsPath(adapter, scope);
    if (on(args, "print")) {
      lines.push(`# ${adapter} → ${settingsPath}`);
      lines.push(invoke.shell);
      continue;
    }
    const result = installHooks({ adapter, settingsPath, invocation: invoke });
    lines.push(`${result.changed ? "Installed" : "Already installed"} ${adapter} hooks in ${settingsPath}`);
    if (adapter === "codex") {
      lines.push("Codex ignores new hooks until you trust them with /hooks.");
    }
  }
  if (on(args, "skill")) {
    const destination = on(args, "project")
      ? path.join(process.cwd(), ".claude", "skills", "spendguard", "SKILL.md")
      : path.join(os.homedir(), ".claude", "skills", "spendguard", "SKILL.md");
    if (!on(args, "print")) installSkill(destination);
    lines.push(`${on(args, "print") ? "Would install" : "Installed"} skill ${on(args, "print") ? `(source ${skillSource()})` : destination}`);
  }
  if (on(args, "mcp")) {
    const invoke = invocation("claude-code");
    if (!on(args, "project")) {
      lines.push("MCP config snippet (pass --project to write ./.mcp.json):");
      lines.push(JSON.stringify(mcpSnippet(invoke), null, 2));
    } else if (!on(args, "print")) {
      const file = path.join(process.cwd(), ".mcp.json");
      installMcp(file, invoke);
      lines.push(`Installed MCP server in ${file}`);
    }
  }
  console.log(lines.join("\n"));
  return 0;
}

function commandUninstall(args: Parsed): number {
  const scope = on(args, "project") ? "project" : "user";
  const adapters = chosenAdapters(args);
  for (const adapter of adapters) {
    if (adapter === "openclaw") continue;
    const settingsPath = flag(args, "settings") ?? defaultSettingsPath(adapter, scope);
    if (!fs.existsSync(settingsPath)) {
      console.log(`No settings file at ${settingsPath}`);
      continue;
    }
    const result = uninstallHooks(settingsPath);
    console.log(`${result.changed ? "Removed" : "No"} spendguard hooks in ${settingsPath}`);
  }
  return 0;
}

function commandBudget(args: Parsed): number {
  const sub = args.positionals[1] ?? "show";
  const home = homeOf(args);
  if (sub === "show") {
    const config = showConfig(home);
    console.log(on(args, "json") ? JSON.stringify(config, null, 2) : formatConfig(config));
    return 0;
  }
  if (sub === "thresholds") {
    const numbers = args.positionals.slice(2).map(Number);
    const config = setThresholds(home, numbers);
    console.log(`Thresholds ${config.thresholds.join(", ")}`);
    return 0;
  }
  if (sub !== "set" && sub !== "clear") throw new Error("Use budget set, budget show, budget clear, or budget thresholds.");
  const scope = budgetScope(args);
  if (sub === "clear") {
    clearBudget(home, scope);
    console.log(`Cleared ${scopeLabel(scope)}.`);
    return 0;
  }
  if (on(args, "strict")) setStrict(home, true);
  if (on(args, "no-strict")) setStrict(home, false);
  const blockAt = flag(args, "block-at");
  if (blockAt !== undefined) setBlockAt(home, Number(blockAt));
  const usd = flag(args, "usd");
  const tokens = flag(args, "tokens");
  if (usd === undefined && tokens === undefined) {
    if (blockAt === undefined && !on(args, "strict") && !on(args, "no-strict")) {
      throw new Error("Pass --usd or --tokens. Settings-only changes are --block-at, --strict, and --no-strict.");
    }
    console.log("Updated budget settings.");
    return 0;
  }
  const cap = parseCap(usd === undefined ? undefined : Number(usd), tokens === undefined ? undefined : Number(tokens));
  setBudget(home, scope, cap);
  console.log(`Set ${scopeLabel(scope)} to ${formatCap(cap)}.`);
  return 0;
}

function commandStatus(args: Parsed): number {
  const home = homeOf(args);
  const requested = flag(args, "session");
  const sessionId = requested ? resolveSessionPrefix(loadLedger(home), requested) : undefined;
  const claudeProjects = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, "projects")
    : path.join(os.homedir(), ".claude", "projects");
  const report = buildStatus({
    home,
    ...(sessionId ? { sessionId } : {}),
    scan: !on(args, "no-scan"),
    claudeProjects,
    ...(on(args, "all") ? { maxAgeMs: Number.MAX_SAFE_INTEGER, maxFiles: 2000 } : {}),
  });
  console.log(on(args, "json") ? JSON.stringify(report, null, 2) : formatStatus(report));
  return 0;
}

function commandKill(args: Parsed, engage: boolean): number {
  const home = homeOf(args);
  const scope = killScope(args);
  if (engage) {
    const reason = flag(args, "reason") ?? "manual kill switch";
    engageKill(home, scope, reason);
    console.log(`Kill switch on (${scopeLabelKill(scope)}). The next hook stops the run.`);
    return 0;
  }
  clearKill(home, scope);
  console.log(`Kill switch cleared (${scopeLabelKill(scope)}). A budget that is still spent stays in force.`);
  return 0;
}

function commandPrices(args: Parsed): number {
  const table = loadPriceTable({ home: homeOf(args) });
  if (on(args, "json")) {
    console.log(JSON.stringify(table, null, 2));
    return 0;
  }
  console.log(`Updated ${table.updated}`);
  if (table.source) console.log(`Source ${table.source}`);
  console.log(`File ${table.path}`);
  if (table.overlayPath) console.log(`Overlay ${table.overlayPath}`);
  console.log("");
  console.log(priceRow("model", "input", "output", "cache 5m", "cache 1h", "cache read"));
  for (const model of table.models) console.log(priceRowOf(model));
  console.log(priceRowOf(table.fallback));
  console.log("");
  console.log("Rates are USD per 1,000,000 tokens. Unknown models use the fallback and are marked estimated.");
  console.log("Override with ~/.spendguard/prices.json or SPENDGUARD_PRICES.");
  return 0;
}

function commandAdapters(args: Parsed): number {
  const rows = listAdapters().map((adapter) => ({
    id: adapter.id,
    name: adapter.displayName,
    enforcement: adapter.enforcement,
    summary: adapter.summary,
    limitations: adapter.limitations,
  }));
  if (on(args, "json")) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  for (const row of rows) {
    console.log(`${row.name} (${row.id}) — ${row.enforcement}`);
    console.log(`  ${row.summary}`);
    for (const limitation of row.limitations) console.log(`  - ${limitation}`);
    console.log("");
  }
  return 0;
}

async function commandProxy(args: Parsed): Promise<number> {
  const provider = parseProxyProvider(flag(args, "provider"));
  if (!provider) throw new Error("--provider must be anthropic, openai, gemini, or xai.");
  const upstream = flag(args, "upstream") ?? defaultUpstream(provider);
  const port = flag(args, "port");
  const host = flag(args, "host") ?? "127.0.0.1";
  const running = await startProxy({
    provider,
    upstream,
    home: homeOf(args),
    host,
    ...(port ? { port: Number(port) } : { port: 8791 }),
    cwd: flag(args, "cwd") ?? process.cwd(),
  });
  console.error(`spendguard proxy listening on ${running.url} -> ${upstream} (${provider})`);
  console.error("Ctrl-C stops it. API keys are forwarded and are not stored.");
  await new Promise(() => {});
  return 0;
}

async function commandHook(args: Parsed): Promise<number> {
  const raw = await readStdin();
  const output = handleHook(raw, { home: homeOf(args), adapter: flag(args, "adapter") });
  if (output.stdout) process.stdout.write(output.stdout.endsWith("\n") ? output.stdout : `${output.stdout}\n`);
  if (output.stderr) process.stderr.write(output.stderr.endsWith("\n") ? output.stderr : `${output.stderr}\n`);
  return output.exitCode;
}

function chosenAdapters(args: Parsed): AdapterId[] {
  const requested = args.repeated.get("adapter") ?? [];
  if (requested.length === 0) return ["claude-code"];
  return requested.map((value) => {
    const id = parseAdapterId(value);
    if (!id) throw new Error(`Unknown adapter "${value}". Use claude, codex, cursor, or openclaw.`);
    return id;
  });
}

function budgetScope(args: Parsed): BudgetScope {
  const session = flag(args, "session");
  const agent = flag(args, "subagent");
  if (agent) {
    if (!session) throw new Error("--subagent requires --session.");
    return { kind: "subagent", sessionId: resolveSessionPrefix(loadLedger(homeOf(args)), session), agentId: agent };
  }
  if (session && on(args, "daily")) throw new Error("Session caps are not daily. Drop --daily, or drop --session for a daily ceiling.");
  if (session) return { kind: "session", sessionId: resolveSessionPrefix(loadLedger(homeOf(args)), session) };
  const project = on(args, "project") ? (flag(args, "cwd") ?? process.cwd()) : undefined;
  if (project && on(args, "daily")) return { kind: "project-daily", project };
  if (project) return { kind: "project-session", project };
  if (on(args, "daily")) return { kind: "global-daily" };
  return { kind: "global-session" };
}

function killScope(args: Parsed): KillScope {
  if (on(args, "all")) return { kind: "all" };
  const session = flag(args, "session");
  if (session) return { kind: "session", sessionId: resolveSessionPrefix(loadLedger(homeOf(args)), session) };
  if (on(args, "project")) return { kind: "project", project: flag(args, "cwd") ?? process.cwd() };
  return { kind: "global" };
}

function scopeLabel(scope: BudgetScope): string {
  if (scope.kind === "global-session") return "the default session cap";
  if (scope.kind === "global-daily") return "the global daily cap";
  if (scope.kind === "project-session") return `the session cap for ${scope.project}`;
  if (scope.kind === "project-daily") return `the daily cap for ${scope.project}`;
  if (scope.kind === "session") return `session ${scope.sessionId}`;
  return `subagent ${scope.agentId} in session ${scope.sessionId}`;
}

function scopeLabelKill(scope: KillScope): string {
  if (scope.kind === "all") return "everything";
  if (scope.kind === "global") return "every session";
  if (scope.kind === "project") return scope.project;
  return `session ${scope.sessionId}`;
}

function formatCap(cap: Cap): string {
  const parts: string[] = [];
  if (cap.usd !== undefined) parts.push(`$${cap.usd}`);
  if (cap.tokens !== undefined) parts.push(`${cap.tokens} tokens`);
  return parts.join(" and ");
}

function formatConfig(config: ReturnType<typeof showConfig>): string {
  const lines = [
    `Thresholds ${config.thresholds.join(", ")}`,
    `Block at ${config.blockAtRatio} of each cap`,
    `Strict when spend is unknown: ${config.blockWhenSpendUnknown ? "yes" : "no"}`,
    `Default session cap: ${config.global.session ? formatCap(config.global.session) : "none"}`,
    `Global daily cap: ${config.global.daily ? formatCap(config.global.daily) : "none"}`,
  ];
  for (const [key, project] of Object.entries(config.projects)) {
    lines.push(`Project ${key}: session ${project.session ? formatCap(project.session) : "none"}, daily ${project.daily ? formatCap(project.daily) : "none"}`);
  }
  for (const [id, cap] of Object.entries(config.sessions)) lines.push(`Session ${id}: ${formatCap(cap)}`);
  for (const [id, cap] of Object.entries(config.subagents)) lines.push(`Subagent ${id}: ${formatCap(cap)}`);
  return lines.join("\n");
}

function priceRow(model: string, input: string, output: string, five: string, hour: string, read: string): string {
  return [model.padEnd(28), input.padStart(8), output.padStart(8), five.padStart(10), hour.padStart(10), read.padStart(12)].join(" ");
}

function priceRowOf(model: ModelPrice): string {
  return priceRow(model.id, money(model.input), money(model.output), money(model.cacheWrite5m), money(model.cacheWrite1h), money(model.cacheRead));
}

function money(value: number): string {
  return `$${value}`;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

void main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
