import type { Decision } from "../decide.js";
import { asString, isRecord } from "../jsonutil.js";
import { parseLooseUsage } from "../pricing.js";
import type { HookEventKind, HookOutput, NormalizedEvent } from "../types.js";
import { hashText, jsonOutput, silent, type AgentAdapter, type HookSpec } from "./types.js";

const KINDS: Record<string, HookEventKind> = {
  before_tool_call: "pre_tool",
  before_agent_run: "user_prompt",
  model_call_ended: "model_usage",
  reply_payload_sending: "model_usage",
  agent_end: "stop",
};

export const openclawHookSpecs: HookSpec[] = [];

export const openclawAdapter: AgentAdapter = {
  id: "openclaw",
  displayName: "OpenClaw",
  enforcement: "sample",
  summary:
    "OpenClaw can block a run in-process (before_tool_call, before_agent_run). This repo ships a sample hook, not an installed enforcer. Official model_call_ended events do not include token counts.",
  limitations: [
    "model_call_ended publishes provider, model, duration, and outcome. It does not publish input or output tokens.",
    "reply_payload_sending.usageState is documented as a best-effort snapshot. Treat it as incomplete.",
    "Plugin hooks are TypeScript inside the gateway, not a shell hook. spendguard init does not install them.",
    "The sample returns { outcome: 'block', reason } for before_agent_run. Confirm the current before_tool_call return shape before using it.",
    "Until a usage payload is recognized, caps do not trip. The sample will not invent a dollar figure.",
  ],
  hookSpecs: openclawHookSpecs,
  normalize(payload): NormalizedEvent | null {
    const rawEvent = asString(payload.hook_event_name) ?? asString(payload.type) ?? asString(payload.event);
    if (!rawEvent) return null;
    const kind = KINDS[rawEvent];
    if (!kind) return null;
    const usageSource = payload.usageState ?? payload.usage ?? nestedUsage(payload);
    const usage = kind === "model_usage" ? (parseLooseUsage(usageSource) ?? undefined) : undefined;
    const sessionId = asString(payload.sessionKey) ?? asString(payload.session_id) ?? "unknown";
    return {
      adapter: "openclaw",
      kind,
      rawEvent,
      sessionId,
      ...(asString(payload.agent_id) ? { agentId: asString(payload.agent_id) } : {}),
      ...(asString(payload.model) ? { model: asString(payload.model) } : {}),
      ...(usage ? { usage, usageKey: hashText(`${sessionId}:${JSON.stringify(usage)}:${rawEvent}`) } : {}),
    };
  },
  render(event, decision): HookOutput {
    return renderOpenClaw(event, decision);
  },
};

function nestedUsage(payload: Record<string, unknown>): unknown {
  const context = payload.context;
  if (!isRecord(context)) return undefined;
  return context.usageState ?? context.usage;
}

function renderOpenClaw(event: NormalizedEvent, decision: Decision): HookOutput {
  if (event.kind === "model_usage" || event.kind === "stop") return silent();
  const reason = decision.systemMessage ?? decision.reason;
  if (decision.action === "block" && (event.kind === "pre_tool" || event.kind === "user_prompt")) {
    return jsonOutput({ outcome: "block", reason }, false);
  }
  if (decision.action === "warn") return jsonOutput({ systemMessage: reason }, true);
  return silent();
}

export function isOpenClawPayload(payload: Record<string, unknown>): boolean {
  const name = asString(payload.hook_event_name) ?? asString(payload.type) ?? asString(payload.event) ?? "";
  return name in KINDS;
}
