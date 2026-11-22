import { isRecord } from "../jsonutil.js";
import { emptyUsage, parseLooseUsage, usageFromRecord } from "../pricing.js";
import type { NormalizedUsage } from "../types.js";

export type ProxyProvider = "anthropic" | "openai" | "gemini" | "xai";

export interface ParsedCall {
  model?: string;
  usage: NormalizedUsage;
  /** True when Gemini CLI sent only totalTokenCount and the split was inferred. */
  totalOnly: boolean;
}

const DEFAULTS: Record<ProxyProvider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
  xai: "https://api.x.ai",
};

export function defaultUpstream(provider: ProxyProvider): string {
  return DEFAULTS[provider];
}

export function parseProxyProvider(value: string | undefined): ProxyProvider | undefined {
  if (value === "anthropic" || value === "openai" || value === "gemini" || value === "xai") return value;
  return undefined;
}

/** Pull model and token usage out of a provider response body, JSON or SSE. */
export function parseProviderResponse(
  provider: ProxyProvider,
  raw: string,
  requestModel?: string,
): ParsedCall | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:") || trimmed.includes("\ndata:")) {
    return parseEventStream(provider, trimmed, requestModel);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  return parseJsonBody(provider, parsed, requestModel);
}

export function modelFromRequest(rawBody: string, urlPath: string): string | undefined {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (isRecord(parsed) && typeof parsed.model === "string" && parsed.model) return parsed.model;
  } catch {
    // Gemini generateContent often puts the model in the URL, not the body.
  }
  const match = /\/models\/([^/:?]+)(?::|\/|$)/.exec(urlPath);
  return match?.[1];
}

export function blockedResponse(provider: ProxyProvider, reason: string): { status: number; body: string } {
  const message = reason.replace(/[\r\n]+/g, " ");
  if (provider === "anthropic") {
    return {
      status: 402,
      body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
    };
  }
  if (provider === "gemini") {
    return {
      status: 402,
      body: JSON.stringify({ error: { code: 402, message, status: "RESOURCE_EXHAUSTED" } }),
    };
  }
  return {
    status: 402,
    body: JSON.stringify({ error: { message, type: "insufficient_quota", code: "spendguard_cap" } }),
  };
}

function parseJsonBody(provider: ProxyProvider, parsed: unknown, requestModel?: string): ParsedCall | null {
  if (Array.isArray(parsed)) {
    let found: ParsedCall | null = null;
    for (const entry of parsed) {
      const next = parseJsonBody(provider, entry, requestModel);
      if (next) found = next;
    }
    return found;
  }
  if (!isRecord(parsed)) return null;
  const model = (typeof parsed.model === "string" && parsed.model) || requestModel;
  if (provider === "anthropic") {
    const usage = isRecord(parsed.usage) ? usageFromRecord(parsed.usage) : undefined;
    return usage && hasTokens(usage) ? { ...(model ? { model } : {}), usage, totalOnly: false } : null;
  }
  if (provider === "gemini") {
    return geminiUsage(parsed, model);
  }
  const usage = openAiUsage(parsed);
  if (!usage || !hasTokens(usage)) return null;
  return { ...(model ? { model } : {}), usage, totalOnly: false };
}

function parseEventStream(provider: ProxyProvider, raw: string, requestModel?: string): ParsedCall | null {
  if (provider === "anthropic") return parseAnthropicStream(raw, requestModel);
  let found: ParsedCall | null = null;
  for (const event of ssePayloads(raw)) {
    const next = parseJsonBody(provider, event, requestModel);
    if (next) found = next;
  }
  return found;
}

function parseAnthropicStream(raw: string, requestModel?: string): ParsedCall | null {
  const usage = emptyUsage();
  let model = requestModel;
  let saw = false;
  for (const event of ssePayloads(raw)) {
    if (!isRecord(event)) continue;
    if (event.type === "message_start" && isRecord(event.message)) {
      if (typeof event.message.model === "string") model = event.message.model;
      if (isRecord(event.message.usage)) {
        const start = usageFromRecord(event.message.usage);
        usage.inputTokens = start.inputTokens;
        usage.cacheReadTokens = start.cacheReadTokens;
        usage.cacheWrite5mTokens = start.cacheWrite5mTokens;
        usage.cacheWrite1hTokens = start.cacheWrite1hTokens;
        usage.webSearchRequests = start.webSearchRequests;
        usage.serviceTier = start.serviceTier;
        usage.speed = start.speed;
        usage.inferenceGeo = start.inferenceGeo;
        saw = true;
      }
    }
    if (event.type === "message_delta" && isRecord(event.usage)) {
      const delta = usageFromRecord(event.usage);
      if (delta.outputTokens > 0) usage.outputTokens = delta.outputTokens;
      saw = true;
    }
  }
  if (!saw || !hasTokens(usage)) return null;
  return { ...(model ? { model } : {}), usage, totalOnly: false };
}

function geminiUsage(parsed: Record<string, unknown>, model?: string): ParsedCall | null {
  const meta = isRecord(parsed.usageMetadata) ? parsed.usageMetadata : undefined;
  if (!meta) return null;
  const prompt = count(meta.promptTokenCount);
  const candidates = count(meta.candidatesTokenCount);
  const thoughts = count(meta.thoughtsTokenCount) ?? 0;
  const cached = count(meta.cachedContentTokenCount) ?? 0;
  const total = count(meta.totalTokenCount);
  if (prompt === undefined && candidates === undefined) {
    if (total === undefined) return null;
    const usage = emptyUsage();
    usage.outputTokens = total;
    return { ...(model ? { model } : {}), usage, totalOnly: true };
  }
  const usage = emptyUsage();
  usage.inputTokens = Math.max(0, (prompt ?? 0) - cached);
  usage.outputTokens = (candidates ?? 0) + thoughts;
  usage.cacheReadTokens = cached;
  return { ...(model ? { model } : {}), usage, totalOnly: false };
}

function openAiUsage(parsed: Record<string, unknown>): NormalizedUsage | null {
  const source = isRecord(parsed.usage) ? parsed.usage : parsed;
  const usage = parseLooseUsage(source);
  if (!usage) return null;
  const details = isRecord(source.prompt_tokens_details)
    ? source.prompt_tokens_details
    : isRecord(source.input_tokens_details)
      ? source.input_tokens_details
      : undefined;
  const cached = details ? count(details.cached_tokens) : undefined;
  if (cached !== undefined) usage.cacheReadTokens = cached;
  splitCachedPrompt(usage);
  return usage;
}

/**
 * OpenAI reports prompt_tokens as the whole prompt, with cached_tokens inside it.
 * The price table bills cacheRead instead of input, so the overlap is removed once.
 */
function splitCachedPrompt(usage: NormalizedUsage): void {
  if (usage.cacheReadTokens <= 0) return;
  if (usage.inputTokens >= usage.cacheReadTokens) {
    usage.inputTokens -= usage.cacheReadTokens;
  }
}

function ssePayloads(raw: string): unknown[] {
  const payloads: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(data) as unknown);
    } catch {
      // Ignore keep-alives and non-JSON comments.
    }
  }
  return payloads;
}

function hasTokens(usage: NormalizedUsage): boolean {
  return (
    usage.inputTokens +
      usage.outputTokens +
      usage.cacheReadTokens +
      usage.cacheWrite5mTokens +
      usage.cacheWrite1hTokens +
      usage.webSearchRequests >
    0
  );
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
