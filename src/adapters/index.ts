import { asString } from "../jsonutil.js";
import type { AdapterId } from "../types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter, isCodexPayload } from "./codex.js";
import { CURSOR_EVENTS, cursorAdapter } from "./cursor.js";
import { isOpenClawPayload, openclawAdapter } from "./openclaw.js";
import type { AgentAdapter } from "./types.js";

export const adapters: Record<AdapterId, AgentAdapter> = {
  "claude-code": claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  openclaw: openclawAdapter,
};

export function listAdapters(): AgentAdapter[] {
  return [claudeAdapter, codexAdapter, cursorAdapter, openclawAdapter];
}

export function getAdapter(id: AdapterId): AgentAdapter {
  return adapters[id];
}

export function parseAdapterId(value: string | undefined): AdapterId | undefined {
  if (!value) return undefined;
  if (value === "claude" || value === "claude-code") return "claude-code";
  if (value === "codex" || value === "cursor" || value === "openclaw") return value;
  return undefined;
}

export function detectAdapter(payload: Record<string, unknown>, hint?: string): AdapterId {
  const parsed = parseAdapterId(hint);
  if (parsed) return parsed;
  const event = asString(payload.hook_event_name) ?? "";
  if (typeof payload.cursor_version === "string" || CURSOR_EVENTS.has(event)) return "cursor";
  if (isOpenClawPayload(payload)) return "openclaw";
  if (isCodexPayload(payload)) return "codex";
  return "claude-code";
}
