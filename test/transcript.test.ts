import assert from "node:assert/strict";
import test from "node:test";
import "./env.js";
import { loadPriceTable, priceUsage } from "../src/pricing.js";
import { parseTranscript } from "../src/transcript.js";

const now = new Date("2026-11-22T15:00:00.000Z");
const table = loadPriceTable();

function line(value: unknown): string {
  return JSON.stringify(value);
}

test("streaming snapshots of one message are billed once, at the last usage", () => {
  const text = [
    line({
      type: "assistant",
      message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 1 } },
    }),
    line({
      type: "assistant",
      message: {
        id: "msg_1",
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 10,
          output_tokens: 50,
          iterations: [{ input_tokens: 9_999_999, output_tokens: 9_999_999 }],
        },
      },
    }),
  ].join("\n");
  const parsed = parseTranscript(text, now);
  const messages = Object.values(parsed.messages);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.usage.outputTokens, 50);
  assert.equal(messages[0]?.usage.inputTokens, 10);
});

test("cache write split prices 1-hour tokens at 2x and leaves the remainder on 5-minute", () => {
  const parsed = parseTranscript(
    line({
      type: "assistant",
      timestamp: "2026-11-22T15:00:00.000Z",
      message: {
        id: "msg_cache",
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 50 },
        },
      },
    }),
    now,
  );
  const message = parsed.messages.msg_cache;
  assert.ok(message);
  assert.equal(message.usage.cacheWrite5mTokens, 50);
  assert.equal(message.usage.cacheWrite1hTokens, 50);
  const cost = priceUsage(message.usage, message.model, table);
  const five = (50 * 5) / 1_000_000;
  const hour = (50 * 8) / 1_000_000;
  assert.equal(cost.nanoUsd, Math.round((five + hour) * 1_000_000_000));
});

test("older transcripts without a TTL split bill cache writes at the 5-minute rate", () => {
  const parsed = parseTranscript(
    line({
      type: "assistant",
      message: {
        id: "old",
        model: "claude-sonnet-4-5",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 },
      },
    }),
    now,
  );
  const message = parsed.messages.old;
  assert.ok(message);
  assert.equal(message.usage.cacheWrite5mTokens, 1_000_000);
  assert.equal(message.usage.cacheWrite1hTokens, 0);
  assert.equal(priceUsage(message.usage, message.model, table).nanoUsd, Math.round(3.75 * 1_000_000_000));
});

test("malformed lines and non-assistant rows are ignored", () => {
  const text = ["not json", line({ type: "user", message: { role: "user", content: "hi" } }), ""].join("\n");
  const parsed = parseTranscript(text, now);
  assert.equal(parsed.usageFound, false);
  assert.equal(Object.keys(parsed.messages).length, 0);
});
