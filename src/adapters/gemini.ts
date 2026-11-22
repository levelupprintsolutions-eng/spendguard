import { createHash } from "node:crypto";
import type { Decision } from "../decide.js";
import { asString, isRecord } from "../jsonutil.js";
import { emptyUsage } from "../pricing.js";
import type { HookEventKind, HookOutput, NormalizedEvent, NormalizedUsage } from "../types.js";
import { jsonOutput, type AgentAdapter, type HookSpec } from "./types.js";

const KINDS: Record<string, HookEventKind> = {
  SessionStart: "session_start",
  SessionEnd: "session_end",
  BeforeAgent: "user_prompt",
  BeforeModel: "pre_tool",
  BeforeTool: "pre_tool",
  AfterModel: "model_usage",
  AfterAgent: "stop",
  AfterTool: "observe",
};

export const geminiHookSpecs: HookSpec[] = [
  { event: "BeforeModel", timeout: 15000 },
  { event: "BeforeTool", timeout: 15000 },
  { event: "BeforeAgent", timeout: 15000 },
  { event: "AfterModel", timeout: 15000 },
  { event: "AfterAgent", timeout: 15000 },
];

/** Events that are not also Claude Code event names. SessionStart is shared, so it is not a detector. */
export const GEMINI_EVENTS = new Set(["BeforeAgent", "BeforeModel", "BeforeTool", "AfterModel", "AfterAgent", "AfterTool"]);

export const geminiAdapter: AgentAdapter = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  enforcement: "partial",
  summary:
    "BeforeModel and BeforeTool can deny the next model call or tool and stop the loop. AfterModel records usageMetadata when Gemini CLI includes it. The local proxy is the accurate bill if the CLI is pointed at it.",
  limitations: [
    "The published AfterModel payload only guarantees usageMetadata.totalTokenCount. A total with no prompt/candidate split is priced as output tokens so the cap fails closed, and the cost is higher than the invoice.",
    "AfterModel runs on every streamed chunk. If each chunk repeats usageMetadata, the hook can count the same call more than once. Identical snapshots are stored once.",
    "SessionStart cannot block. The next BeforeModel or BeforeTool is the gate.",
    "AfterAgent decision:deny asks Gemini CLI to retry, which spends more. Over-cap stops use continue:false and do not deny.",
    "Cache storage (USD per million tokens per hour) is not in the hook payload and is not billed.",
  ],
  hookSpecs: geminiHookSpecs,
  normalize(payload): NormalizedEvent | null {
    const rawEvent = asString(payload.hook_event_name);
    if (!rawEvent) return null;
    const kind = KINDS[rawEvent];
    if (!kind) return null;
    const request = isRecord(payload.llm_request) ? payload.llm_request : undefined;
    const model = request ? asString(request.model) : undefined;
    const parsed = kind === "model_usage" ? geminiHookUsage(payload) : undefined;
    const sessionId = asString(payload.session_id) ?? "unknown";
    return {
      adapter: "gemini-cli",
      kind,
      rawEvent,
      sessionId,
      ...(asString(payload.cwd) ? { cwd: asString(payload.cwd) } : {}),
      ...(model ? { model } : {}),
      ...(parsed ? { usage: parsed, usageKey: geminiUsageKey(sessionId, parsed) } : {}),
    };
  },
  render(event, decision): HookOutput {
    return renderGemini(event, decision);
  },
};

function renderGemini(event: NormalizedEvent, decision: Decision): HookOutput {
  const reason = decision.systemMessage ?? decision.reason;
  if (decision.action === "block") {
    if (event.rawEvent === "AfterAgent" || event.kind === "stop") {
      return jsonOutput({ continue: false, stopReason: reason, systemMessage: reason }, false);
    }
    if (event.rawEvent === "AfterModel") {
      return jsonOutput({ continue: false, stopReason: reason, systemMessage: reason }, false);
    }
    return jsonOutput({ decision: "deny", reason, continue: false, stopReason: reason, systemMessage: reason }, false);
  }
  if (decision.action === "warn") {
    return jsonOutput({ systemMessage: reason, decision: "allow" }, true);
  }
  if (event.kind === "pre_tool" || event.kind === "user_prompt") {
    return jsonOutput({ decision: "allow" }, false);
  }
  return jsonOutput({}, false);
}

function geminiHookUsage(payload: Record<string, unknown>): NormalizedUsage | undefined {
  const response = isRecord(payload.llm_response) ? payload.llm_response : undefined;
  const meta = response && isRecord(response.usageMetadata) ? response.usageMetadata : undefined;
  if (!meta) return undefined;
  const prompt = count(meta.promptTokenCount);
  const candidates = count(meta.candidatesTokenCount);
  const thoughts = count(meta.thoughtsTokenCount) ?? 0;
  const cached = count(meta.cachedContentTokenCount) ?? 0;
  const total = count(meta.totalTokenCount);
  if (prompt === undefined && candidates === undefined && total === undefined) return undefined;
  const usage = emptyUsage();
  if (prompt === undefined && candidates === undefined && total !== undefined) {
    usage.outputTokens = total;
    return usage;
  }
  usage.inputTokens = Math.max(0, (prompt ?? 0) - cached);
  usage.outputTokens = (candidates ?? 0) + thoughts;
  usage.cacheReadTokens = cached;
  return usage;
}

function geminiUsageKey(sessionId: string, usage: NormalizedUsage): string {
  const hash = createHash("sha256").update(JSON.stringify(usage)).digest("hex").slice(0, 16);
  return `gemini:${sessionId}:${hash}`;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
