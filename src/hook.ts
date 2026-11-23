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
    // One transcript file is one bill. A subagent hook and the parent's
    // subagentStop can both be handed that path; keep it on this session only.
    releaseSharedTranscript(ledger.sessions, session.id, event.transcriptPath);
    releaseSharedTranscript(ledger.sessions, session.id, event.extraTranscriptPath);
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
  // subagentStart and subagentStop run in the parent, so transcript_path is
  // the parent conversation and the subagent file arrives separately.
  // Tagging the parent file would bill it against the subagent cap. A hook
  // that runs inside the subagent passes that file as transcript_path and
  // has no second path, so the subagent id stays on it.
  const transcriptIsParent =
    event.kind === "subagent_start" ||
    event.kind === "session_start" ||
    (event.kind === "subagent_stop" && event.extraTranscriptPath !== undefined);
  const transcriptAgent = transcriptIsParent ? null : (event.agentId ?? null);
  if (event.transcriptPath) readTranscript(session, event.transcriptPath, transcriptAgent, now);
  if (event.extraTranscriptPath) readTranscript(session, event.extraTranscriptPath, event.agentId ?? null, now);
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
  if ((event.adapter === "codex" || event.adapter === "openclaw") && Object.keys(session.usageEvents).length > 0) {
    session.usageKnown = true;
  }
}

function releaseSharedTranscript(
  sessions: Record<string, SessionRecord>,
  ownerId: string,
  filePath: string | undefined,
): void {
  if (!filePath || !sessions[ownerId]?.transcripts[filePath]) return;
  for (const [id, other] of Object.entries(sessions)) {
    if (id === ownerId || !other.transcripts[filePath]) continue;
    delete other.transcripts[filePath];
    if (other.adapter !== "cursor") continue;
    const usageLeft = Object.values(other.transcripts).some((transcript) => transcript.usageFound);
    if (usageLeft || Object.keys(other.usageEvents).length > 0) continue;
    if (Object.keys(other.transcripts).length === 0) delete sessions[id];
    else other.usageKnown = false;
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
