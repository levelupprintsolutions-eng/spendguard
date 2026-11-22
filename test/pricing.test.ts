import assert from "node:assert/strict";
import test from "node:test";
import "./env.js";
import { usdToNano } from "../src/money.js";
import { emptyUsage, findModel, loadPriceTable, priceUsage } from "../src/pricing.js";
import type { NormalizedUsage as Usage } from "../src/types.js";

function usage(partial: Partial<Usage> = {}): Usage {
  return { ...emptyUsage(), ...partial };
}

const table = loadPriceTable();

test("published million-token rates for Opus 5.5", () => {
  const once = (partial: Partial<Usage>) => priceUsage(usage(partial), "claude-opus-5-5", table).nanoUsd;
  assert.equal(once({ inputTokens: 1_000_000 }), usdToNano(4));
  assert.equal(once({ outputTokens: 1_000_000 }), usdToNano(20));
  assert.equal(once({ cacheWrite5mTokens: 1_000_000 }), usdToNano(5));
  assert.equal(once({ cacheWrite1hTokens: 1_000_000 }), usdToNano(8));
  assert.equal(once({ cacheReadTokens: 1_000_000 }), usdToNano(0.2));
  assert.equal(once({ webSearchRequests: 2 }), usdToNano(0.02));
});

test("fast, batch, and US multipliers stack the way the rate card does", () => {
  const input = usage({ inputTokens: 1_000_000, speed: "fast", inferenceGeo: "us" });
  assert.equal(priceUsage(input, "claude-opus-5-5", table).nanoUsd, usdToNano(8.8));
  const batchUs = usage({ inputTokens: 1_000_000, serviceTier: "batch", inferenceGeo: "us" });
  assert.equal(priceUsage(batchUs, "claude-opus-5-5", table).nanoUsd, usdToNano(2.2));
});

test("Haiku 5.5 prices the whole request at the higher rate only above 100k", () => {
  const at = priceUsage(usage({ inputTokens: 100_000 }), "claude-haiku-5-5", table);
  const over = priceUsage(usage({ inputTokens: 100_001 }), "claude-haiku-5-5", table);
  assert.equal(at.nanoUsd, usdToNano(0.01));
  assert.equal(over.nanoUsd, Math.round(100_001 * 0.5 * 1000));
  assert.ok(over.notes.some((note) => note.includes("long-context")));
});

test("longest model prefix wins, including dated snapshots", () => {
  assert.equal(findModel(table, "claude-opus-4-5-20251101").model.id, "claude-opus-4-5");
  assert.equal(findModel(table, "claude-opus-4").model.id, "claude-opus-4");
  assert.equal(findModel(table, "claude-opus-5").model.id, "claude-opus-5");
  assert.equal(findModel(table, "claude-opus-5-5").model.id, "claude-opus-5-5");
  assert.equal(findModel(table, "claude-sonnet-4-20250514").model.id, "claude-sonnet-4");
  assert.equal(findModel(table, "claude-sonnet-5").model.id, "claude-sonnet-5");
  assert.equal(findModel(table, "anthropic/claude-haiku-4-5[1m]").model.id, "claude-haiku-4-5");
  const million = priceUsage(usage({ inputTokens: 1_000_000 }), "claude-opus-5", table);
  assert.equal(million.nanoUsd, usdToNano(5));
});

test("unknown models use the fallback and are marked estimated", () => {
  const cost = priceUsage(usage({ inputTokens: 1_000_000 }), "not-a-real-model", table);
  assert.equal(cost.estimated, true);
  assert.equal(cost.modelId, "fallback-fable-5-2");
  assert.equal(cost.nanoUsd, usdToNano(8));
});

test("priority tier is noted and not given an invented multiplier", () => {
  const cost = priceUsage(usage({ inputTokens: 1_000_000, serviceTier: "priority" }), "claude-opus-5-5", table);
  assert.equal(cost.nanoUsd, usdToNano(4));
  assert.equal(cost.estimated, false);
  assert.ok(cost.notes.some((note) => note.includes("priority")));
});

test("cache multipliers match the published table", () => {
  for (const model of table.models) {
    assert.ok(Math.abs(model.cacheWrite5m / model.input - 1.25) < 1e-9, model.id);
    assert.ok(Math.abs(model.cacheWrite1h / model.input - 2) < 1e-9, model.id);
    const read = model.cacheRead / model.input;
    assert.ok([0.1, 0.05, 0.025].some((multiplier) => Math.abs(read - multiplier) < 1e-9), model.id);
    if (model.longContext) {
      assert.ok(Math.abs(model.longContext.cacheWrite5m / model.longContext.input - 1.25) < 1e-9, model.id);
      assert.ok(Math.abs(model.longContext.cacheRead / model.longContext.input - 0.1) < 1e-9, model.id);
    }
  }
});
