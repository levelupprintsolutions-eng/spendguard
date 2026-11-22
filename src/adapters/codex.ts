import type { Decision } from "../decide.js";
import { asString, isRecord } from "../jsonutil.js";
import { billedTokens } from "../money.js";
import { parseLooseUsage } from "../pricing.js";
import type { HookEventKind, HookOutput, NormalizedEvent, NormalizedUsage } from "../types.js";
import { hashText, jsonOutput, silent, type AgentAdapter, type HookSpec } from "./types.js";

const KINDS: Record<string, HookEventKind> = {
  SessionStart: "session_start",
  SubagentStart: "subagent_start",
  PreToolUse: "pre_tool",
  PermissionRequest: "permission",
  UserPromptSubmit: "user_prompt",
  Stop: "stop",
  SubagentStop: "subagent_stop",
  SessionEnd: "session_end",
  PostModelRequest: "model_usage",
  PostToolUse: "observe",
};

export const codexHookSpecs: HookSpec[] = [
  { event: "PreToolUse", timeout: 20, statusMessage: "Checking spend cap" },
  { event: "PermissionRequest", timeout: 20, statusMessage: "Checking spend cap" },
  { event: "UserPromptSubmit", timeout: 15, statusMessage: "Checking spend cap" },
  { event: "Stop", timeout: 20, statusMessage: "Checking spend cap" },
  { event: "SubagentStop", timeout: 20, statusMessage: "Checking spend cap" },
  { event: "PostModelRequest", timeout: 15, statusMessage: "Recording token usage" },
  { event: "SubagentStart", timeout: 10 },
  { event: "SessionStart", timeout: 10 },
];

export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "OpenAI Codex CLI",
  enforcement: "partial",
  summary:
    "The same hook events can deny a tool call and stop a turn. Spend is recorded from PostModelRequest.token_usage when the counts use a recognized field name.",
  limitations: [
    "Codex says the transcript format is not a stable interface, so this adapter does not price rollout files.",
    "token_usage is only documented as 'token counts when available'. Unrecognized shapes stay unknown and do not trip a dollar cap.",
    "PreToolUse rejects continue:false. A deny is permissionDecision only. Stop uses continue:false, which does end the turn.",
    "Hosted tools such as WebSearch do not run PreToolUse. A turn that only calls those can still spend until Stop.",
    "New hooks stay inactive until you trust them with /hooks, unless you pass --dangerously-bypass-hook-trust.",
    "Add the model to the price table. Unknown ids use the Fable 5.2 fallback and are marked estimated.",
  ],
  hookSpecs: codexHookSpecs,
  normalize(payload): NormalizedEvent | null {
    const rawEvent = asString(payload.hook_event_name);
    if (!rawEvent) return null;
    const kind = KINDS[rawEvent];
    if (!kind) return null;
    const usage = kind === "model_usage" ? codexUsage(payload) : undefined;
    const turn = asString(payload.turn_id) ?? "";
    const call = asString(payload.call_id) ?? asString(payload.request_id) ?? "";
    return {
      adapter: "codex",
      kind,
      rawEvent,
      sessionId: asString(payload.session_id) ?? "unknown",
      ...(asString(payload.agent_id) ? { agentId: asString(payload.agent_id) } : {}),
      ...(asString(payload.agent_type) ? { agentType: asString(payload.agent_type) } : {}),
      ...(asString(payload.cwd) ? { cwd: asString(payload.cwd) } : {}),
      ...(asString(payload.model) ? { model: asString(payload.model) } : {}),
      ...(usage ? { usage, usageKey: call || `${turn}:${hashText(JSON.stringify(usage))}` } : {}),
    };
  },
  render(event, decision): HookOutput {
    return renderCodex(event, decision);
  },
};

function codexUsage(payload: Record<string, unknown>): NormalizedUsage | undefined {
  if (!("token_usage" in payload) || payload.token_usage === null) return undefined;
  const usage = parseLooseUsage(payload.token_usage);
  if (!usage) return undefined;
  const status = asString(payload.status);
  if (status === "cancelled" && billedTokens(usage) === 0 && usage.webSearchRequests === 0) return undefined;
  return usage;
}

function renderCodex(event: NormalizedEvent, decision: Decision): HookOutput {
  // PostModelRequest output cannot block, and a bad field fails the hook open.
  if (event.kind === "model_usage" || event.kind === "observe" || event.kind === "session_end") return silent();
  const reason = decision.systemMessage ?? decision.reason;
  if (decision.action === "allow") {
    if (event.kind === "stop" || event.kind === "subagent_stop") return jsonOutput({ continue: true }, false);
    return silent();
  }
  if (decision.action === "warn") {
    if (event.kind === "stop" || event.kind === "subagent_stop") {
      return jsonOutput({ continue: true, systemMessage: reason }, true);
    }
    if (event.kind === "pre_tool" || event.kind === "permission") {
      return jsonOutput({ systemMessage: reason }, true);
    }
    return jsonOutput({ systemMessage: reason }, true);
  }
  if (event.kind === "pre_tool") {
    return jsonOutput(
      {
        systemMessage: reason,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      },
      false,
    );
  }
  if (event.kind === "permission") {
    return jsonOutput(
      {
        systemMessage: reason,
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message: reason },
        },
      },
      false,
    );
  }
  if (event.kind === "user_prompt") {
    return jsonOutput({ continue: false, stopReason: reason, decision: "block", reason, systemMessage: reason }, false);
  }
  if (event.kind === "stop" || event.kind === "subagent_stop") {
    return jsonOutput({ continue: false, stopReason: reason, systemMessage: reason }, false);
  }
  return jsonOutput({ systemMessage: reason }, false);
}

export function isCodexPayload(payload: Record<string, unknown>): boolean {
  return typeof payload.turn_id === "string" && isRecord(payload);
}
