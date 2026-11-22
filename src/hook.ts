import fs from "node:fs";
import { matchProject, resolveSessionCap } from "./budget.js";
import { decide, type KillFlags, type ResolvedCaps } from "./decide.js";
import { detectAdapter, getAdapter } from "./adapters/index.js";
import { asString, isRecord } from "./jsonutil.js";
import { dayKey, pathUnder, resolveExisting, resolveHome } from "./paths.js";
import { loadPriceTable } from "./pricing.js";
import { pictureFor } from "./rollup.js";
import { emptySession, updateStore } from "./store.js";
import { parseTranscript } from "./transcript.js";
import type { HookOutput, KillRecord, Kills, NormalizedEvent, SessionRecord } from "./types.js";

export interface HookOptions {
  home?: string;
  now?: Date;
  adapter?: string;
}

const FAIL_CLOSED = new Set([
  "PreToolUse",
  "UserPromptSubmit",
  "PostToolBatch",
  "preToolUse",
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "beforeSubmitPrompt",
  "subagentStart",
  "BeforeModel",
  "BeforeTool",
  "BeforeAgent",
]);

export function handleHook(raw: string, options: HookOptions = {}): HookOutput {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return { exitCode: 0, stdout: "", stderr: "", surfacedWarning: false };
  }
  if (!isRecord(payload)) {
    return { exitCode: 0, stdout: "", stderr: "", surfacedWarning: false };
  }
  try {
    return evaluatePayload(payload, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = `spendguard hook failed: ${message}`;
    const event = asString(payload.hook_event_name) ?? "";
    if (event === "PermissionRequest") {
      return { exitCode: 1, stdout: "", stderr, surfacedWarning: false };
    }
    if (FAIL_CLOSED.has(event)) {
      return { exitCode: 2, stdout: "", stderr, surfacedWarning: false };
    }
    return { exitCode: 0, stdout: "", stderr, surfacedWarning: false };
  }
}

function evaluatePayload(payload: Record<string, unknown>, options: HookOptions): HookOutput {
  const now = options.now ?? new Date();
  const home = resolveHome(options.home);
  const adapter = getAdapter(detectAdapter(payload, options.adapter));
  const event = adapter.normalize(payload);
  if (!event) return { exitCode: 0, stdout: "", stderr: "", surfacedWarning: false };

  return updateStore(home, ({ config, kills, ledger }) => {
    const table = loadPriceTable({ home });
    const session = locateSession(ledger.sessions, event, now);
    ledger.sessions[session.id] = session;
    ingest(session, event, now);
    const projectKey = session.projectKey || (event.cwd ? resolveExisting(event.cwd) : "");
    const matched = projectKey ? matchProject(config, projectKey) : null;
    const picture = pictureFor({
      ledger,
      sessionId: session.id,
      ...(event.agentId ? { agentId: event.agentId } : {}),
      projectKey: matched?.key ?? projectKey,
      day: dayKey(now),
      table,
    });
    const caps: ResolvedCaps = {
      session: resolveSessionCap(config, session.id, projectKey),
      dailyGlobal: config.global.daily,
      dailyProject: matched?.budget.daily ?? null,
      agent: event.agentId ? (config.subagents[`${session.id}:${event.agentId}`] ?? null) : null,
      blockAtRatio: config.blockAtRatio,
      thresholds: config.thresholds,
      blockWhenSpendUnknown: config.blockWhenSpendUnknown,
    };
    const decision = decide({
      spend: picture,
      caps,
      kills: killFlags(kills, projectKey, session.id),
      warnings: ledger.warnings,
      sessionId: session.id,
      ...(event.agentId ? { agentId: event.agentId } : {}),
    });
    const output = adapter.render(event, decision);
    if (output.surfacedWarning) {
      for (const mark of decision.warningMarks) {
        if (!ledger.warnings.includes(mark)) ledger.warnings.push(mark);
      }
    }
    return output;
  });
}

function locateSession(
  sessions: Record<string, SessionRecord>,
  event: NormalizedEvent,
  now: Date,
): SessionRecord {
  let id = event.sessionId || "unknown";
  if (event.agentId) {
    for (const existing of Object.values(sessions)) {
      if (existing.agents[event.agentId]) {
        id = existing.id;
        break;
      }
    }
  }
  const cwd = event.cwd ? resolveExisting(event.cwd) : "";
  const current = sessions[id];
  if (!current) {
    const created = emptySession({
      id,
      adapter: event.adapter,
      cwd,
      projectKey: cwd,
      now,
    });
    if (event.agentId) {
      created.agents[event.agentId] = { ...(event.agentType ? { type: event.agentType } : {}), seenAt: now.toISOString() };
    }
    return created;
  }
  current.updatedAt = now.toISOString();
  if (!current.projectKey && cwd) {
    current.cwd = cwd;
    current.projectKey = cwd;
  }
  if (event.agentId) {
    const previous = current.agents[event.agentId];
    current.agents[event.agentId] = {
      ...(previous?.type || event.agentType ? { type: event.agentType ?? previous?.type } : {}),
      seenAt: now.toISOString(),
    };
  }
  return current;
}

function ingest(session: SessionRecord, event: NormalizedEvent, now: Date): void {
  // SubagentStart runs in the parent, so its transcript_path is the parent
  // conversation. Tagging that file would bill the parent against the subagent.
  const transcriptAgent = event.kind === "subagent_start" || event.kind === "session_start" ? null : (event.agentId ?? null);
  // Gemini CLI dollars come from AfterModel usageMetadata. Its transcript is not a stable bill.
  if (event.adapter !== "gemini-cli") {
    if (event.transcriptPath) readTranscript(session, event.transcriptPath, transcriptAgent, now);
    if (event.extraTranscriptPath) readTranscript(session, event.extraTranscriptPath, event.agentId ?? null, now);
  }
  if (event.usage && event.usageKey) {
    session.usageEvents[event.usageKey] = {
      agentId: event.agentId ?? null,
      message: {
        ...(event.model ? { model: event.model } : {}),
        usage: event.usage,
        day: dayKey(now),
      },
    };
  }
  if (event.adapter === "claude-code") session.usageKnown = true;
  if (event.adapter === "cursor" && Object.values(session.transcripts).some((transcript) => transcript.usageFound)) {
    session.usageKnown = true;
  }
  if (
    (event.adapter === "codex" || event.adapter === "openclaw" || event.adapter === "gemini-cli") &&
    Object.keys(session.usageEvents).length > 0
  ) {
    session.usageKnown = true;
  }
}

function readTranscript(session: SessionRecord, filePath: string, agentId: string | null, now: Date): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }
  const previous = session.transcripts[filePath];
  if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
    if (agentId && !previous.agentId) previous.agentId = agentId;
    return;
  }
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  const parsed = parseTranscript(text, now);
  session.transcripts[filePath] = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    agentId: agentId ?? previous?.agentId ?? null,
    usageFound: parsed.usageFound,
    messages: parsed.messages,
  };
}

function killFlags(kills: Kills, projectKey: string, sessionId: string): KillFlags {
  let project: KillRecord | null = null;
  let best = -1;
  for (const [key, record] of Object.entries(kills.projects)) {
    if (projectKey && pathUnder(key, projectKey) && key.length > best) {
      project = record;
      best = key.length;
    }
  }
  return {
    global: kills.global,
    project,
    session: kills.sessions[sessionId] ?? null,
  };
}
