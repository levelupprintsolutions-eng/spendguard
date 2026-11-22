import { isRecord, asString } from "./jsonutil.js";
import { dayKey } from "./paths.js";
import { usageFromRecord } from "./pricing.js";
import type { StoredMessage } from "./types.js";

export interface ParsedTranscript {
  messages: Record<string, StoredMessage>;
  usageFound: boolean;
}

/**
 * Claude Code appends a JSON object per line. Assistant rows carry
 * `message.usage` for that API request. The same message id is rewritten as
 * the reply streams, so the last row for an id is the billable one.
 * `usage.iterations` is a breakdown of the same request and is not added.
 */
export function parseTranscript(text: string, now: Date): ParsedTranscript {
  const messages: Record<string, StoredMessage> = {};
  let usageFound = false;
  let anonymous = 0;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isAssistant(parsed)) continue;
    const usageRecord = usageRecordOf(parsed);
    if (!usageRecord) continue;
    usageFound = true;
    const id = messageId(parsed) ?? `anon:${anonymous++}`;
    const model = asString(messageOf(parsed)?.model) ?? asString(parsed.model);
    const timestamp = asString(parsed.timestamp);
    const when = timestamp ? new Date(timestamp) : now;
    const day = Number.isNaN(when.getTime()) ? dayKey(now) : dayKey(when);
    messages[id] = {
      ...(model ? { model } : {}),
      usage: usageFromRecord(usageRecord),
      day,
    };
  }
  return { messages, usageFound };
}

function isAssistant(entry: Record<string, unknown>): boolean {
  if (entry.type === "assistant") return true;
  if (entry.role === "assistant") return true;
  const message = messageOf(entry);
  return message?.role === "assistant";
}

function messageOf(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(entry.message) ? entry.message : undefined;
}

function usageRecordOf(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const message = messageOf(entry);
  if (message && isRecord(message.usage)) return message.usage;
  if (isRecord(entry.usage)) return entry.usage;
  return undefined;
}

function messageId(entry: Record<string, unknown>): string | undefined {
  const message = messageOf(entry);
  const id = message ? asString(message.id) : undefined;
  if (id) return id;
  const request = asString(entry.requestId) ?? asString(entry.request_id);
  if (request) return request;
  return asString(entry.uuid);
}
