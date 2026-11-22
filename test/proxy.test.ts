import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./env.js";
import { setBudget } from "../src/budget.js";
import { engageKill } from "../src/kills.js";
import { parseProviderResponse } from "../src/proxy/parse.js";
import { startProxy } from "../src/proxy/server.js";
import { loadPriceTable, priceUsage } from "../src/pricing.js";
import { usdToNano } from "../src/money.js";

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spendguard-proxy-"));
}

function listen(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void>; hits: () => number }> {
  let count = 0;
  const server = http.createServer((request, response) => {
    count += 1;
    handler(request, response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        hits: () => count,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const payload = JSON.stringify(body);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload,
  });
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
}

test("openai, anthropic, and gemini usage parsers keep cache tokens from being billed twice", () => {
  const openai = parseProviderResponse(
    "openai",
    JSON.stringify({
      model: "gpt-5.4",
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
    }),
  );
  assert.equal(openai?.usage.inputTokens, 60);
  assert.equal(openai?.usage.cacheReadTokens, 40);
  assert.equal(openai?.usage.outputTokens, 20);

  const stream = [
    "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}",
    "",
    "data: {\"model\":\"gpt-5.4\",\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"prompt_tokens_details\":{\"cached_tokens\":4}}}",
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const streamed = parseProviderResponse("openai", stream);
  assert.equal(streamed?.usage.inputTokens, 6);
  assert.equal(streamed?.usage.cacheReadTokens, 4);

  const anthropic = [
    "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5-5\",\"usage\":{\"input_tokens\":10,\"output_tokens\":1,\"cache_read_input_tokens\":5}}}",
    "",
    "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}",
    "",
  ].join("\n");
  const claude = parseProviderResponse("anthropic", anthropic);
  assert.equal(claude?.model, "claude-opus-5-5");
  assert.equal(claude?.usage.inputTokens, 10);
  assert.equal(claude?.usage.cacheReadTokens, 5);
  assert.equal(claude?.usage.outputTokens, 7);

  const gemini = parseProviderResponse(
    "gemini",
    JSON.stringify({
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 30 },
    }),
    "gemini-3.8-flash",
  );
  assert.equal(gemini?.usage.inputTokens, 70);
  assert.equal(gemini?.usage.outputTokens, 25);
  assert.equal(gemini?.usage.cacheReadTokens, 30);
});

test("published OpenAI and xAI rates, including gpt-5.4 long context", () => {
  const table = loadPriceTable();
  const million = priceUsage(
    {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      webSearchRequests: 0,
      serviceTier: "standard",
      speed: "standard",
      inferenceGeo: "global",
    },
    "gpt-5.4-2026-03-05",
    table,
  );
  assert.equal(million.modelId, "gpt-5.4");
  assert.equal(million.nanoUsd, usdToNano(5));
  const short = priceUsage(
    {
      inputTokens: 1_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      webSearchRequests: 0,
      serviceTier: "standard",
      speed: "standard",
      inferenceGeo: "global",
    },
    "gpt-5.4",
    table,
  );
  assert.equal(short.nanoUsd, Math.round(1_000 * 2.5 * 1000));
  const long = priceUsage(
    { ...million, inputTokens: 272_001, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, webSearchRequests: 0, serviceTier: "standard", speed: "standard", inferenceGeo: "global" },
    "gpt-5.4",
    table,
  );
  assert.equal(long.nanoUsd, Math.round(272_001 * 5 * 1000));
  const grok = priceUsage(
    {
      inputTokens: 1_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      webSearchRequests: 0,
      serviceTier: "standard",
      speed: "standard",
      inferenceGeo: "global",
    },
    "grok-4.7",
    table,
  );
  assert.equal(grok.nanoUsd, Math.round(1_000 * 2 * 1000));
});

test("the proxy records a call, warns once, then refuses the next call without contacting the upstream", async () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { usd: 0.002 });
  const upstream = await listen((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ model: "gpt-5.4", usage: { prompt_tokens: 1000, completion_tokens: 0 } }));
  });
  const proxy = await startProxy({ provider: "openai", upstream: upstream.url, home: dir, port: 0 });
  try {
    const first = await post(`${proxy.url}/v1/chat/completions`, { model: "gpt-5.4", messages: [] }, { authorization: "Bearer sk-test-secret" });
    assert.equal(first.status, 200);
    assert.equal(first.headers["x-spendguard-warning"], undefined);
    const second = await post(`${proxy.url}/v1/chat/completions`, { model: "gpt-5.4", messages: [] });
    assert.equal(second.status, 402);
    assert.match(second.body, /stopped|cap|spendguard/i);
    assert.equal(upstream.hits(), 1);
    const third = await post(`${proxy.url}/v1/chat/completions`, { model: "gpt-5.4", messages: [] });
    assert.equal(third.status, 402);
    assert.equal(upstream.hits(), 1);
    const ledger = fs.readFileSync(path.join(dir, "ledger.json"), "utf8");
    assert.equal(ledger.includes("sk-test-secret"), false);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("a kill switch stops the proxy before the upstream is called", async () => {
  const dir = home();
  engageKill(dir, { kind: "global" }, "stop the lab");
  const upstream = await listen((_request, response) => {
    response.end("{}");
  });
  const proxy = await startProxy({ provider: "xai", upstream: upstream.url, home: dir, port: 0 });
  try {
    const result = await post(`${proxy.url}/v1/chat/completions`, { model: "grok-4.7", messages: [] });
    assert.equal(result.status, 402);
    assert.match(result.body, /kill switch/);
    assert.equal(upstream.hits(), 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("the proxy warns on the request after the threshold and still forwards it", async () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { usd: 1 });
  const upstream = await listen((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        model: "gpt-5.4",
        usage: { prompt_tokens: 100_000, completion_tokens: 0 },
      }),
    );
  });
  const proxy = await startProxy({ provider: "openai", upstream: upstream.url, home: dir, port: 0 });
  try {
    await post(`${proxy.url}/v1/chat/completions`, { model: "gpt-5.4" });
    await post(`${proxy.url}/v1/chat/completions`, { model: "gpt-5.4" });
    const warned = await post(`${proxy.url}/v1/chat/completions`, { model: "gpt-5.4" });
    assert.equal(warned.status, 200);
    assert.match(String(warned.headers["x-spendguard-warning"]), /50%/);
    const again = await post(`${proxy.url}/v1/chat/completions`, { model: "gpt-5.4" });
    assert.equal(again.status, 200);
    assert.equal(again.headers["x-spendguard-warning"], undefined);
    assert.equal(upstream.hits(), 4);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
