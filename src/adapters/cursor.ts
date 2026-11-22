import type { Decision } from "../decide.js";
import { asString } from "../jsonutil.js";
import type { HookEventKind, HookOutput, NormalizedEvent } from "../types.js";
import { jsonOutput, type AgentAdapter, type HookSpec } from "./types.js";

const KINDS: Record<string, HookEventKind> = {
  sessionStart: "session_start",
  sessionEnd: "session_end",
  preToolUse: "pre_tool",
  beforeShellExecution: "pre_tool",
  beforeMCPExecution: "pre_tool",
  beforeReadFile: "pre_tool",
  beforeSubmitPrompt: "user_prompt",
  subagentStart: "subagent_start",
  subagentStop: "subagent_stop",
  stop: "stop",
  postToolUse: "observe",
  afterShellExecution: "observe",
  afterAgentResponse: "observe",
};

const PERMISSION_KINDS = new Set<HookEventKind>(["pre_tool", "subagent_start"]);

export const cursorHookSpecs: HookSpec[] = [
  { event: "preToolUse", timeout: 20, failClosed: true },
  { event: "beforeShellExecution", timeout: 20, failClosed: true },
  { event: "beforeMCPExecution", timeout: 20, failClosed: true },
  { event: "beforeReadFile", timeout: 20, failClosed: true },
  { event: "beforeSubmitPrompt", timeout: 15, failClosed: true },
  { event: "subagentStart", timeout: 15, failClosed: true },
  { event: "subagentStop", timeout: 20, failClosed: false },
  { event: "stop", timeout: 20, failClosed: false },
];

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  displayName: "Cursor",
  enforcement: "partial",
  summary:
    "Hooks can deny the next tool call, shell command, file read, prompt, or subagent. The kill switch works today. A dollar cap applies only when the transcript actually contains token usage.",
  limitations: [
    "Cursor hook payloads include the model id and not token counts. There is no documented usage field to bill from.",
    "transcript_path is parsed when it is Claude-style JSONL. Other transcript shapes count as unknown spend, not as $0.",
    "Unknown spend does not trip a cap unless you set --strict. Strict mode blocks every unmetered Cursor action.",
    "User-level hooks do not run on cloud agents. Project hooks in .cursor/hooks.json do, after the workspace is writable.",
    "An empty stdout on a permission hook is treated as a block. Allow responses always send permission:allow.",
    "stop cannot cancel the turn that just finished. The next beforeSubmitPrompt or preToolUse is the gate.",
  ],
  hookSpecs: cursorHookSpecs,
  normalize(payload): NormalizedEvent | null {
    const rawEvent = asString(payload.hook_event_name);
    if (!rawEvent) return null;
    const kind = KINDS[rawEvent];
    if (!kind) return null;
    const parent = asString(payload.parent_conversation_id);
    const own = asString(payload.conversation_id) ?? asString(payload.session_id);
    const agentId = asString(payload.subagent_id) ?? asString(payload.agent_id);
    const sessionId = parent ?? own ?? "unknown";
    const transcriptPath = asString(payload.transcript_path);
    const agentTranscript = asString(payload.agent_transcript_path);
    const model = asString(payload.model_id) ?? asString(payload.model);
    const agentType = asString(payload.subagent_type);
    const cwd = asString(payload.cwd);
    return {
      adapter: "cursor",
      kind,
      rawEvent,
      sessionId,
      ...(agentId ? { agentId } : {}),
      ...(agentType ? { agentType } : {}),
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(agentTranscript && agentTranscript !== transcriptPath ? { extraTranscriptPath: agentTranscript } : {}),
    };
  },
  render(event, decision): HookOutput {
    return renderCursor(event, decision);
  },
};

function renderCursor(event: NormalizedEvent, decision: Decision): HookOutput {
  const reason = decision.systemMessage ?? decision.reason;
  if (PERMISSION_KINDS.has(event.kind)) {
    if (decision.action === "block") {
      return jsonOutput({ permission: "deny", user_message: reason, agent_message: reason }, false);
    }
    if (decision.action === "warn") {
      return jsonOutput({ permission: "allow", user_message: reason, agent_message: reason }, true);
    }
    return jsonOutput({ permission: "allow" }, false);
  }
  if (event.kind === "user_prompt") {
    if (decision.action === "block") return jsonOutput({ continue: false, user_message: reason }, false);
    if (decision.action === "warn") return jsonOutput({ continue: true, user_message: reason }, true);
    return jsonOutput({ continue: true }, false);
  }
  if (decision.action === "block") return jsonOutput({ user_message: reason }, false);
  if (decision.action === "warn") return jsonOutput({ user_message: reason }, true);
  return jsonOutput({}, false);
}

export const CURSOR_EVENTS = new Set(Object.keys(KINDS));
