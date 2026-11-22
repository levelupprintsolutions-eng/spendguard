import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asCount, asFinite, isRecord } from "./jsonutil.js";
import { billedTokens, tokensToNano } from "./money.js";
import type { NormalizedUsage } from "./types.js";

export interface RateCard {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface ModelPrice extends RateCard {
  id: string;
  match: string[];
  fastMultiplier?: number;
  usGeoMultiplier?: number;
  longContext?: RateCard & { aboveTokens: number };
  reason?: string;
}

export interface PriceTable {
  updated: string;
  source: string;
  webSearchUsdPerThousand: number;
  batchMultiplier: number;
  fallback: ModelPrice;
  models: ModelPrice[];
  /** Built-in file, or the SPENDGUARD_PRICES override. */
  path: string;
  overlayPath?: string;
}

export interface CostResult {
  nanoUsd: number;
  tokens: number;
  estimated: boolean;
  modelId: string;
  notes: string[];
}

const RATE_KEYS = ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"] as const;

export function builtinPricePath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, "prices", "anthropic.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("spendguard could not find prices/anthropic.json");
}

export function loadPriceTable(options?: { home?: string; pricesPath?: string }): PriceTable {
  const override = options?.pricesPath ?? process.env.SPENDGUARD_PRICES;
  const basePath = override ? path.resolve(override) : builtinPricePath();
  const table = parsePriceTable(readJson(basePath), basePath);
  const overlay =
    options?.home && !override ? path.join(options.home, "prices.json") : undefined;
  if (overlay && fs.existsSync(overlay)) {
    mergeOverlay(table, readJson(overlay), overlay);
    table.overlayPath = overlay;
  }
  return table;
}

export function canonicalizeModel(model: string): string {
  let id = model.trim().toLowerCase();
  id = id.replace(/^anthropic[./]/, "");
  id = id.replace(/\[.*\]$/, "");
  return id;
}

export function findModel(
  table: PriceTable,
  modelId: string | undefined,
): { model: ModelPrice; estimated: boolean } {
  if (!modelId) return { model: table.fallback, estimated: true };
  const id = canonicalizeModel(modelId);
  let best: ModelPrice | null = null;
  let bestLen = -1;
  for (const model of table.models) {
    for (const key of model.match) {
      if (modelMatches(id, key) && key.length > bestLen) {
        best = model;
        bestLen = key.length;
      }
    }
  }
  if (!best) return { model: table.fallback, estimated: true };
  return { model: best, estimated: false };
}

export function priceUsage(
  usage: NormalizedUsage,
  modelId: string | undefined,
  table: PriceTable,
): CostResult {
  const found = findModel(table, modelId);
  const notes: string[] = [];
  let estimated = found.estimated;
  if (estimated) {
    const label = modelId ? `no price row for "${modelId}"` : "model id missing";
    notes.push(`${label}; used ${found.model.id}`);
  }

  const promptTokens =
    usage.inputTokens +
    usage.cacheReadTokens +
    usage.cacheWrite5mTokens +
    usage.cacheWrite1hTokens;
  let rates = cardOf(found.model);
  const long = found.model.longContext;
  if (long && promptTokens > long.aboveTokens) {
    rates = cardOf(long);
    notes.push(`long-context rates (prompt ${promptTokens} tokens)`);
  }

  if (usage.speed === "fast") {
    const multiplier = found.model.fastMultiplier ?? 2;
    if (found.model.fastMultiplier == null) {
      estimated = true;
      notes.push("fast mode has no published price on this model; applied 2x");
    }
    rates = scale(rates, multiplier);
  }

  if (usage.serviceTier === "batch") {
    rates = scale(rates, table.batchMultiplier);
  } else if (usage.serviceTier === "priority") {
    notes.push("priority tier is not in the price table; standard rates used");
  }

  if (usage.inferenceGeo === "us") {
    if (found.model.usGeoMultiplier) {
      rates = scale(rates, found.model.usGeoMultiplier);
    } else {
      notes.push("US inference premium not applied; this model has no published US multiplier");
    }
  }

  let nano =
    tokensToNano(usage.inputTokens, rates.input) +
    tokensToNano(usage.outputTokens, rates.output) +
    tokensToNano(usage.cacheReadTokens, rates.cacheRead) +
    tokensToNano(usage.cacheWrite5mTokens, rates.cacheWrite5m) +
    tokensToNano(usage.cacheWrite1hTokens, rates.cacheWrite1h);
  if (usage.webSearchRequests > 0) {
    nano += Math.round((usage.webSearchRequests * table.webSearchUsdPerThousand * 1_000_000_000) / 1000);
  }

  return {
    nanoUsd: nano,
    tokens: billedTokens(usage),
    estimated,
    modelId: found.model.id,
    notes,
  };
}

export function modelMatches(modelId: string, key: string): boolean {
  const id = modelId.toLowerCase();
  const prefix = key.toLowerCase();
  return id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}.`);
}

function cardOf(source: RateCard): RateCard {
  return {
    input: source.input,
    output: source.output,
    cacheWrite5m: source.cacheWrite5m,
    cacheWrite1h: source.cacheWrite1h,
    cacheRead: source.cacheRead,
  };
}

function scale(rates: RateCard, multiplier: number): RateCard {
  return {
    input: rates.input * multiplier,
    output: rates.output * multiplier,
    cacheWrite5m: rates.cacheWrite5m * multiplier,
    cacheWrite1h: rates.cacheWrite1h * multiplier,
    cacheRead: rates.cacheRead * multiplier,
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read price table ${file}: ${message}`);
  }
}

function parsePriceTable(raw: unknown, file: string): PriceTable {
  if (!isRecord(raw)) throw new Error(`${file}: price table must be a JSON object`);
  const modelsRaw = raw.models;
  if (!Array.isArray(modelsRaw)) throw new Error(`${file}: models must be an array`);
  return {
    updated: typeof raw.updated === "string" ? raw.updated : "unknown",
    source: typeof raw.source === "string" ? raw.source : "",
    webSearchUsdPerThousand: requiredNumber(raw.webSearchUsdPerThousand, file, "webSearchUsdPerThousand"),
    batchMultiplier: requiredNumber(raw.batchMultiplier, file, "batchMultiplier"),
    fallback: parseModel(raw.fallback, file, "fallback"),
    models: modelsRaw.map((entry, index) => parseModel(entry, file, `models[${index}]`)),
    path: file,
  };
}

function mergeOverlay(table: PriceTable, raw: unknown, file: string): void {
  if (!isRecord(raw)) throw new Error(`${file}: overlay must be a JSON object`);
  if (raw.updated !== undefined && typeof raw.updated === "string") table.updated = raw.updated;
  if (raw.source !== undefined && typeof raw.source === "string") table.source = raw.source;
  if (raw.webSearchUsdPerThousand !== undefined) {
    table.webSearchUsdPerThousand = requiredNumber(raw.webSearchUsdPerThousand, file, "webSearchUsdPerThousand");
  }
  if (raw.batchMultiplier !== undefined) {
    table.batchMultiplier = requiredNumber(raw.batchMultiplier, file, "batchMultiplier");
  }
  if (raw.fallback !== undefined) table.fallback = parseModel(raw.fallback, file, "fallback");
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models)) throw new Error(`${file}: models must be an array`);
    for (const [index, entry] of raw.models.entries()) {
      const model = parseModel(entry, file, `models[${index}]`);
      const existing = table.models.findIndex((item) => item.id === model.id);
      if (existing >= 0) table.models[existing] = model;
      else table.models.push(model);
    }
  }
}

function parseModel(raw: unknown, file: string, label: string): ModelPrice {
  if (!isRecord(raw)) throw new Error(`${file}: ${label} must be an object`);
  const match = raw.match === undefined ? [] : raw.match;
  if (!Array.isArray(match) || match.some((item) => typeof item !== "string")) {
    throw new Error(`${file}: ${label}.match must be an array of strings`);
  }
  const model: ModelPrice = {
    id: typeof raw.id === "string" && raw.id ? raw.id : label,
    match: match as string[],
    input: requiredNumber(raw.input, file, `${label}.input`),
    output: requiredNumber(raw.output, file, `${label}.output`),
    cacheWrite5m: requiredNumber(raw.cacheWrite5m, file, `${label}.cacheWrite5m`),
    cacheWrite1h: requiredNumber(raw.cacheWrite1h, file, `${label}.cacheWrite1h`),
    cacheRead: requiredNumber(raw.cacheRead, file, `${label}.cacheRead`),
  };
  if (raw.fastMultiplier !== undefined) {
    model.fastMultiplier = requiredNumber(raw.fastMultiplier, file, `${label}.fastMultiplier`);
  }
  if (raw.usGeoMultiplier !== undefined) {
    model.usGeoMultiplier = requiredNumber(raw.usGeoMultiplier, file, `${label}.usGeoMultiplier`);
  }
  if (raw.reason !== undefined && typeof raw.reason === "string") model.reason = raw.reason;
  if (raw.longContext !== undefined) {
    if (!isRecord(raw.longContext)) throw new Error(`${file}: ${label}.longContext must be an object`);
    const above = raw.longContext.aboveTokens;
    if (typeof above !== "number" || !Number.isInteger(above) || above <= 0) {
      throw new Error(`${file}: ${label}.longContext.aboveTokens must be a positive integer`);
    }
    model.longContext = {
      aboveTokens: above,
      input: requiredNumber(raw.longContext.input, file, `${label}.longContext.input`),
      output: requiredNumber(raw.longContext.output, file, `${label}.longContext.output`),
      cacheWrite5m: requiredNumber(raw.longContext.cacheWrite5m, file, `${label}.longContext.cacheWrite5m`),
      cacheWrite1h: requiredNumber(raw.longContext.cacheWrite1h, file, `${label}.longContext.cacheWrite1h`),
      cacheRead: requiredNumber(raw.longContext.cacheRead, file, `${label}.longContext.cacheRead`),
    };
  }
  for (const key of RATE_KEYS) {
    if (model[key] < 0) throw new Error(`${file}: ${label}.${key} must be >= 0`);
  }
  return model;
}

function requiredNumber(value: unknown, file: string, label: string): number {
  const number = asFinite(value);
  if (number === undefined) throw new Error(`${file}: ${label} must be a number`);
  return number;
}

export function emptyUsage(): NormalizedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    webSearchRequests: 0,
    serviceTier: "standard",
    speed: "standard",
    inferenceGeo: "global",
  };
}

/** Accept the common Anthropic, OpenAI, and camelCase usage shapes. */
export function parseLooseUsage(value: unknown): NormalizedUsage | null {
  if (!isRecord(value)) return null;
  const source = isRecord(value.usage) ? value.usage : value;
  const input = firstCount(source, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const output = firstCount(source, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  if (input === undefined && output === undefined) return null;
  const usage = usageFromRecord(source);
  usage.inputTokens = input ?? 0;
  usage.outputTokens = output ?? 0;
  return usage;
}

export function usageFromRecord(source: Record<string, unknown>): NormalizedUsage {
  const cacheRead =
    firstCount(source, [
      "cache_read_input_tokens",
      "cacheReadInputTokens",
      "cached_tokens",
      "cachedTokens",
    ]) ?? 0;
  const creation = isRecord(source.cache_creation) ? source.cache_creation : undefined;
  const five = creation ? asCount(creation.ephemeral_5m_input_tokens) : undefined;
  const hour = creation ? asCount(creation.ephemeral_1h_input_tokens) : undefined;
  const totalCreate = firstCount(source, ["cache_creation_input_tokens", "cacheCreationInputTokens"]) ?? 0;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  if ((five ?? 0) + (hour ?? 0) > 0) {
    cacheWrite5m = five ?? 0;
    cacheWrite1h = hour ?? 0;
    const leftover = Math.max(0, totalCreate - cacheWrite5m - cacheWrite1h);
    cacheWrite5m += leftover;
  } else {
    cacheWrite5m = totalCreate;
  }
  const serverTools = isRecord(source.server_tool_use) ? source.server_tool_use : undefined;
  const webSearch = serverTools ? (asCount(serverTools.web_search_requests) ?? 0) : 0;
  return {
    inputTokens: firstCount(source, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]) ?? 0,
    outputTokens: firstCount(source, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]) ?? 0,
    cacheReadTokens: cacheRead,
    cacheWrite5mTokens: cacheWrite5m,
    cacheWrite1hTokens: cacheWrite1h,
    webSearchRequests: webSearch,
    serviceTier: tierOf(source.service_tier ?? source.serviceTier),
    speed: speedOf(source.speed),
    inferenceGeo: geoOf(source.inference_geo ?? source.inferenceGeo),
  };
}

function firstCount(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    if (key in source) {
      const count = asCount(source[key]);
      if (count !== undefined) return count;
    }
  }
  return undefined;
}

function tierOf(value: unknown): NormalizedUsage["serviceTier"] {
  if (value === "batch" || value === "priority" || value === "standard") return value;
  if (value === undefined || value === null || value === "") return "standard";
  return "unknown";
}

function speedOf(value: unknown): NormalizedUsage["speed"] {
  if (value === "fast") return "fast";
  if (value === undefined || value === null || value === "" || value === "standard") return "standard";
  return "unknown";
}

function geoOf(value: unknown): NormalizedUsage["inferenceGeo"] {
  if (value === "us") return "us";
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "global" ||
    value === "not_available"
  ) {
    return "global";
  }
  return "other";
}
