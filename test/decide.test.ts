import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./env.js";
import { resolveSessionCap } from "../src/budget.js";
import { decide, type ResolvedCaps, type SpendView } from "../src/decide.js";
import { usdToNano } from "../src/money.js";
import { emptyBag, type MoneyBag } from "../src/rollup.js";
import { defaultConfig } from "../src/store.js";

function spend(nano: number, tokens = 0, known = true): MoneyBag {
  return { nanoUsd: nano, tokens, known, estimated: false, incomplete: false };
}

function view(session: MoneyBag, extra: Partial<SpendView> = {}): SpendView {
  return {
    session,
    dailyGlobal: extra.dailyGlobal ?? emptyBag(true),
    dailyProject: extra.dailyProject ?? emptyBag(true),
    agent: extra.agent ?? null,
  };
}

function caps(partial: Partial<ResolvedCaps> = {}): ResolvedCaps {
  return {
    session: { usd: 1 },
    dailyGlobal: null,
    dailyProject: null,
    agent: null,
    blockAtRatio: 1,
    thresholds: [0.5, 0.8],
    blockWhenSpendUnknown: false,
    ...partial,
  };
}

test("under the first threshold is silent", () => {
  const decision = decide({
    spend: view(spend(usdToNano(0.4))),
    caps: caps(),
    kills: { global: null, project: null, session: null },
    warnings: [],
    sessionId: "s",
  });
  assert.equal(decision.action, "allow");
});

test("crossing 50% warns once, and 80% adds context for the model", () => {
  const first = decide({
    spend: view(spend(usdToNano(0.6))),
    caps: caps(),
    kills: { global: null, project: null, session: null },
    warnings: [],
    sessionId: "s",
  });
  assert.equal(first.action, "warn");
  assert.match(first.reason, /50%/);
  assert.equal(first.additionalContext, undefined);
  const again = decide({
    spend: view(spend(usdToNano(0.6))),
    caps: caps(),
    kills: { global: null, project: null, session: null },
    warnings: first.warningMarks,
    sessionId: "s",
  });
  assert.equal(again.action, "allow");
  const high = decide({
    spend: view(spend(usdToNano(0.85))),
    caps: caps(),
    kills: { global: null, project: null, session: null },
    warnings: first.warningMarks,
    sessionId: "s",
  });
  assert.equal(high.action, "warn");
  assert.match(high.reason, /80%/);
  assert.ok(high.additionalContext?.includes("hard-stopped"));
});

test("reaching the cap blocks, and a jump past both thresholds names the higher one", () => {
  const blocked = decide({
    spend: view(spend(usdToNano(1))),
    caps: caps(),
    kills: { global: null, project: null, session: null },
    warnings: [],
    sessionId: "s",
  });
  assert.equal(blocked.action, "block");
  assert.match(blocked.reason, /stopped/);
  const jumped = decide({
    spend: view(spend(usdToNano(0.9))),
    caps: caps(),
    kills: { global: null, project: null, session: null },
    warnings: [],
    sessionId: "s",
  });
  assert.equal(jumped.action, "warn");
  assert.match(jumped.reason, /80%/);
  assert.ok(jumped.warningMarks.some((mark) => mark.endsWith("@0.5")));
  assert.ok(jumped.warningMarks.some((mark) => mark.endsWith("@0.8")));
});

test("the kill switch blocks even when spend is under the cap", () => {
  const decision = decide({
    spend: view(spend(usdToNano(0.1))),
    caps: caps(),
    kills: { global: null, project: null, session: { at: "t", reason: "runaway" } },
    warnings: [],
    sessionId: "s",
  });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /kill switch/);
});

test("a zero cap blocks immediately and block-at can trip early", () => {
  const zero = decide({
    spend: view(spend(0)),
    caps: caps({ session: { usd: 0 } }),
    kills: { global: null, project: null, session: null },
    warnings: [],
    sessionId: "s",
  });
  assert.equal(zero.action, "block");
  const early = decide({
    spend: view(spend(usdToNano(0.96))),
    caps: caps({ blockAtRatio: 0.95 }),
    kills: { global: null, project: null, session: null },
    warnings: [],
    sessionId: "s",
  });
  assert.equal(early.action, "block");
});

test("unknown spend blocks only in strict mode", () => {
  const open = decide({
    spend: view(spend(0, 0, false)),
    caps: caps(),
    kills: { global: null, project: null, session: null },
    warnings: [],
    sessionId: "s",
  });
  assert.equal(open.action, "allow");
  const closed = decide({
    spend: view(spend(0, 0, false)),
    caps: caps({ blockWhenSpendUnknown: true }),
    kills: { global: null, project: null, session: null },
    warnings: [],
    sessionId: "s",
  });
  assert.equal(closed.action, "block");
  assert.match(closed.reason, /unknown/);
});

test("the tighter of a token cap and a dollar cap wins", () => {
  const decision = decide({
    spend: view(spend(usdToNano(0.1), 80)),
    caps: caps({ session: { usd: 10, tokens: 100 } }),
    kills: { global: null, project: null, session: null },
    warnings: [],
    sessionId: "s",
  });
  assert.equal(decision.action, "warn");
  assert.match(decision.reason, /token/);
});

test("a daily ceiling blocks while the session cap still has room", () => {
  const decision = decide({
    spend: view(spend(usdToNano(0.2)), { dailyGlobal: spend(usdToNano(5)) }),
    caps: caps({ session: { usd: 10 }, dailyGlobal: { usd: 5 } }),
    kills: { global: null, project: null, session: null },
    warnings: [],
    sessionId: "s",
  });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /daily/);
});

test("a subagent cap does not use the parent session's headroom", () => {
  const decision = decide({
    spend: view(spend(usdToNano(0.2)), { agent: spend(usdToNano(0.3)) }),
    caps: caps({ session: { usd: 10 }, agent: { usd: 0.25 } }),
    kills: { global: null, project: null, session: null },
    warnings: [],
    sessionId: "s",
    agentId: "explore",
  });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /subagent/);
});

test("session caps replace project caps, which replace the global default, and a sibling path does not match", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spendguard-budget-"));
  const config = defaultConfig();
  config.global.session = { usd: 10 };
  config.projects[root] = { session: { usd: 2 }, daily: null };
  assert.equal(resolveSessionCap(config, "s", path.join(root, "src"))?.usd, 2);
  assert.equal(resolveSessionCap(config, "s", `${root}-other`)?.usd, 10);
  config.sessions.s = { usd: 9 };
  assert.equal(resolveSessionCap(config, "s", path.join(root, "src"))?.usd, 9);
});
