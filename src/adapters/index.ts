import { asString } from "../jsonutil.js";
import type { AdapterId } from "../types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter, isCodexPayload } from "./codex.js";
import { CURSOR_EVENTS, cursorAdapter } from "./cursor.js";
import { GEMINI_EVENTS, geminiAdapter } from "./gemini.js";
import { isOpenClawPayload, openclawAdapter } from "./openclaw.js";
import type { AgentAdapter } from "./types.js";

export const adapters: Record<AdapterId, AgentAdapter> = {
  "claude-code": claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  openclaw: openclawAdapter,
  "gemini-cli": geminiAdapter,
  proxy: {
    id: "proxy",
    displayName: "Provider proxy",
    enforcement: "enforced",
    summary:
      "A localhost reverse proxy for the Anthropic, OpenAI, Gemini, and xAI APIs. The next request is refused when the cap or the kill switch is hit. Any agent that can set a base URL is covered.",
    limitations: [
      "The request that crosses the cap is already billed. The following request is refused.",
      "Warnings are a response header and `spendguard status`. They are not injected into the model prompt.",
      "The proxy buffers each response so it can read usage, and it also streams those bytes to the client as they arrive.",
      "Cache-storage fees charged per hour, and search-grounding fees, are not in the usage object.",
      "Bind it to 127.0.0.1. It forwards API keys.",
    ],
    hookSpecs: [],
    normalize: () => null,
    render: (_event, _decision) => ({ exitCode: 0, stdout: "", stderr: "", surfacedWarning: false }),
  },
};

export function listAdapters(): AgentAdapter[] {
  return [claudeAdapter, codexAdapter, cursorAdapter, openclawAdapter, geminiAdapter, adapters.proxy];
}

export function getAdapter(id: AdapterId): AgentAdapter {
  return adapters[id];
}

export function parseAdapterId(value: string | undefined): AdapterId | undefined {
  if (!value) return undefined;
  if (value === "claude" || value === "claude-code") return "claude-code";
  if (value === "gemini" || value === "gemini-cli") return "gemini-cli";
  if (value === "codex" || value === "cursor" || value === "openclaw" || value === "proxy") return value;
  return undefined;
}

export function detectAdapter(payload: Record<string, unknown>, hint?: string): AdapterId {
  const parsed = parseAdapterId(hint);
  if (parsed) return parsed;
  const event = asString(payload.hook_event_name) ?? "";
  if (typeof payload.cursor_version === "string" || CURSOR_EVENTS.has(event)) return "cursor";
  if (GEMINI_EVENTS.has(event)) return "gemini-cli";
  if (isOpenClawPayload(payload)) return "openclaw";
  if (isCodexPayload(payload)) return "codex";
  return "claude-code";
}
