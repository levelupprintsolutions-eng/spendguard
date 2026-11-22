import type { Decision } from "../decide.js";
import { asString } from "../jsonutil.js";
import type { HookEventKind, HookOutput, NormalizedEvent } from "../types.js";
import { jsonOutput, silent, type AgentAdapter, type HookSpec } from "./types.js";

const KINDS: Record<string, HookEventKind> = {
  SessionStart: "session_start",
  SubagentStart: "subagent_start",
  PreToolUse: "pre_tool",
  PermissionRequest: "permission",
  PostToolBatch: "post_tool_batch",
  UserPromptSubmit: "user_prompt",
  Stop: "stop",
  SubagentStop: "subagent_stop",
  SessionEnd: "session_end",
  PostToolUse: "observe",
  PostToolUseFailure: "observe",
  StopFailure: "observe",
};

export const claudeHookSpecs: HookSpec[] = [
  { event: "PreToolUse", timeout: 20, onFailure: "block", statusMessage: "Checking spend cap" },
  { event: "PermissionRequest", timeout: 20, onFailure: "block", statusMessage: "Checking spend cap" },
  { event: "PostToolBatch", timeout: 20, onFailure: "block", statusMessage: "Checking spend cap" },
  { event: "UserPromptSubmit", timeout: 15, onFailure: "block", statusMessage: "Checking spend cap" },
  { event: "Stop", timeout: 20, statusMessage: "Checking spend cap" },
  { event: "SubagentStop", timeout: 20, statusMessage: "Checking spend cap" },
  { event: "SubagentStart", timeout: 10 },
  { event: "SessionStart", timeout: 10 },
  { event: "SessionEnd", timeout: 10 },
];

export const claudeAdapter: AgentAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  enforcement: "enforced",
  summary:
    "Hooks read the session JSONL transcript, price every assistant request, and hard-stop the run when a cap or the kill switch is hit.",
  limitations: [
    "The transcript is written asynchronously, so a hook can be one model call behind. That call is already billed.",
    "Tool calls already in flight when the cap trips still finish. The next PreToolUse is denied and continue:false stops the loop.",
    "Dollar amounts are first-party API list price. Claude Pro and Max are not invoiced from this table.",
    "Stop must not use decision:block. In Claude Code that field means keep working, which would spend more.",
    "A subagent cap follows hook agent_id and agent_transcript_path. Sidechain rows that exist only inside the parent transcript count toward the session total, not a separate subagent cap.",
    "Cloud sessions do not read ~/.claude/settings.json. Install project hooks or the runner image for those.",
  ],
  hookSpecs: claudeHookSpecs,
  normalize(payload): NormalizedEvent | null {
    const rawEvent = asString(payload.hook_event_name);
    if (!rawEvent) return null;
    const kind = KINDS[rawEvent];
    if (!kind) return null;
    return {
      adapter: "claude-code",
      kind,
      rawEvent,
      sessionId: asString(payload.session_id) ?? "unknown",
      ...(asString(payload.agent_id) ? { agentId: asString(payload.agent_id) } : {}),
      ...(asString(payload.agent_type) ? { agentType: asString(payload.agent_type) } : {}),
      ...(asString(payload.cwd) ? { cwd: asString(payload.cwd) } : {}),
      ...(asString(payload.transcript_path) ? { transcriptPath: asString(payload.transcript_path) } : {}),
      ...(asString(payload.agent_transcript_path)
        ? { extraTranscriptPath: asString(payload.agent_transcript_path) }
        : {}),
    };
  },
  render(event, decision): HookOutput {
    return renderClaude(event, decision);
  },
};

function renderClaude(event: NormalizedEvent, decision: Decision): HookOutput {
  if (decision.action === "allow") return silent();
  const reason = decision.systemMessage ?? decision.reason;
  if (decision.action === "warn") {
    if (event.kind === "session_end" || event.kind === "observe") return silent();
    const body: Record<string, unknown> = { systemMessage: reason };
    if (decision.additionalContext && event.kind !== "stop" && event.kind !== "subagent_stop") {
      body.hookSpecificOutput = {
        hookEventName: event.rawEvent,
        additionalContext: decision.additionalContext,
      };
    }
    return jsonOutput(body, true);
  }
  if (event.kind === "pre_tool") {
    return jsonOutput(
      {
        continue: false,
        stopReason: reason,
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
        continue: false,
        stopReason: reason,
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
    return jsonOutput(
      {
        continue: false,
        stopReason: reason,
        decision: "block",
        reason,
        systemMessage: reason,
      },
      false,
    );
  }
  if (event.kind === "stop" || event.kind === "subagent_stop" || event.kind === "post_tool_batch") {
    // decision:"block" on Stop means "keep going". Never send it.
    return jsonOutput({ continue: false, stopReason: reason, systemMessage: reason }, false);
  }
  return jsonOutput({ systemMessage: reason }, false);
}
