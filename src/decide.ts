import { formatPct, formatTokens, formatUsd, usdToNano } from "./money.js";
import type { MoneyBag } from "./rollup.js";
import type { Cap, KillRecord } from "./types.js";

export interface KillFlags {
  global: KillRecord | null;
  project: KillRecord | null;
  session: KillRecord | null;
}

export interface ResolvedCaps {
  session: Cap | null;
  dailyGlobal: Cap | null;
  dailyProject: Cap | null;
  agent: Cap | null;
  blockAtRatio: number;
  thresholds: number[];
  blockWhenSpendUnknown: boolean;
}

export interface SpendView {
  session: MoneyBag;
  dailyGlobal: MoneyBag;
  dailyProject: MoneyBag;
  agent: MoneyBag | null;
}

export interface Decision {
  action: "allow" | "warn" | "block";
  reason: string;
  systemMessage?: string;
  additionalContext?: string;
  warningMarks: string[];
  binding?: string;
}

interface Check {
  key: string;
  label: string;
  ratio: number;
  over: boolean;
  summary: string;
  unknown: boolean;
}

/**
 * Pure cap decision. Stop's `decision: "block"` means "keep working" in
 * Claude Code and Codex, so this function never emits that shape. Renderers
 * turn `action: "block"` into a host-specific hard stop.
 */
export function decide(input: {
  spend: SpendView;
  caps: ResolvedCaps;
  kills: KillFlags;
  warnings: readonly string[];
  sessionId: string;
  agentId?: string;
}): Decision {
  const kill = describeKill(input.kills, input.sessionId);
  if (kill) {
    return {
      action: "block",
      reason: kill,
      systemMessage: kill,
      warningMarks: [],
      binding: "kill switch",
    };
  }

  const checks = collectChecks(input);
  const blocking = checks.filter((check) => check.over);
  if (blocking.length > 0) {
    const primary = blocking.sort((a, b) => b.ratio - a.ratio)[0] as Check;
    const also = blocking.filter((check) => check !== primary).map((check) => check.label);
    const reason = primary.unknown
      ? `spendguard: spend for ${primary.label} is unknown and strict mode is on. Turn it off with \`spendguard budget set --no-strict\` only if you accept an unmetered run.`
      : `spendguard: ${primary.label} reached ${primary.summary}. This run is stopped. ${raiseHint(input.sessionId, input.agentId, primary.label)}${also.length ? ` Also over: ${also.join(", ")}.` : ""}`;
    return {
      action: "block",
      reason,
      systemMessage: reason,
      warningMarks: [],
      binding: primary.label,
    };
  }

  const already = new Set(input.warnings);
  let best: { check: Check; threshold: number } | null = null;
  const marks: string[] = [];
  for (const check of checks) {
    if (check.unknown || !Number.isFinite(check.ratio)) continue;
    for (const threshold of input.caps.thresholds) {
      if (check.ratio < threshold) continue;
      const mark = `${check.key}@${threshold}`;
      if (already.has(mark)) continue;
      marks.push(mark);
      if (!best || check.ratio > best.check.ratio || (check.ratio === best.check.ratio && threshold > best.threshold)) {
        best = { check, threshold };
      }
    }
  }
  if (!best) return { action: "allow", reason: "", warningMarks: [] };

  const pct = formatPct(best.threshold);
  const reason = `spendguard: ${best.check.label} is ${best.check.summary}, past the ${pct} mark.`;
  const decision: Decision = {
    action: "warn",
    reason,
    systemMessage: reason,
    warningMarks: marks,
    binding: best.check.label,
  };
  if (best.threshold >= 0.8) {
    decision.additionalContext = `Spendguard: ${best.check.summary} of the ${best.check.label}. Further tool calls are hard-stopped at the cap.`;
  }
  return decision;
}

function describeKill(kills: KillFlags, sessionId: string): string | null {
  if (kills.session) {
    return `spendguard kill switch is on for session ${sessionId} (${kills.session.reason}). Clear it with \`spendguard resume --session ${sessionId}\`.`;
  }
  if (kills.project) {
    return `spendguard kill switch is on for this project (${kills.project.reason}). Clear it with \`spendguard resume --project\`.`;
  }
  if (kills.global) {
    return `spendguard kill switch is on for every session (${kills.global.reason}). Clear it with \`spendguard resume\`.`;
  }
  return null;
}

function raiseHint(sessionId: string, agentId: string | undefined, label: string): string {
  if (label.startsWith("subagent") && agentId) {
    return `Raise it with \`spendguard budget set --subagent ${agentId} --session ${sessionId} --usd <amount>\`.`;
  }
  if (label.startsWith("project")) return "Raise it with `spendguard budget set --project --daily --usd <amount>`.";
  if (label.startsWith("global daily")) return "Raise it with `spendguard budget set --daily --usd <amount>`.";
  return `Raise it with \`spendguard budget set --session ${sessionId} --usd <amount>\`.`;
}

function collectChecks(input: {
  spend: SpendView;
  caps: ResolvedCaps;
  sessionId: string;
  agentId?: string;
}): Check[] {
  const checks: Check[] = [];
  pushCap(checks, `session:${input.sessionId}`, "session cap", input.spend.session, input.caps.session, input.caps);
  pushCap(checks, "daily:global", "global daily cap", input.spend.dailyGlobal, input.caps.dailyGlobal, input.caps);
  pushCap(checks, "daily:project", "project daily cap", input.spend.dailyProject, input.caps.dailyProject, input.caps);
  if (input.agentId && input.caps.agent && input.spend.agent) {
    pushCap(checks, `agent:${input.sessionId}:${input.agentId}`, "subagent cap", input.spend.agent, input.caps.agent, input.caps);
  }
  return checks;
}

function pushCap(
  checks: Check[],
  key: string,
  label: string,
  spend: MoneyBag,
  cap: Cap | null,
  caps: ResolvedCaps,
): void {
  if (!cap) return;
  if (cap.usd !== undefined) {
    checks.push(moneyCheck(`${key}:usd`, label, spend, usdToNano(cap.usd), "usd", caps));
  }
  if (cap.tokens !== undefined) {
    const tokenLabel = label.includes("token") ? label : label.replace(" cap", " token cap");
    checks.push(moneyCheck(`${key}:tokens`, tokenLabel, spend, cap.tokens, "tokens", caps));
  }
}

function moneyCheck(
  key: string,
  label: string,
  spend: MoneyBag,
  limit: number,
  unit: "usd" | "tokens",
  caps: ResolvedCaps,
): Check {
  if (!spend.known) {
    if (caps.blockWhenSpendUnknown) {
      return {
        key,
        label,
        ratio: Number.POSITIVE_INFINITY,
        over: true,
        summary: "spend unknown",
        unknown: true,
      };
    }
    return { key, label, ratio: 0, over: false, summary: "spend unknown", unknown: true };
  }
  const amount = unit === "usd" ? spend.nanoUsd : spend.tokens;
  const threshold = unit === "usd" ? Math.round(limit * caps.blockAtRatio) : limit * caps.blockAtRatio;
  const ratio = limit === 0 ? (amount > 0 ? Number.POSITIVE_INFINITY : 1) : amount / limit;
  const summary =
    unit === "usd"
      ? `${formatUsd(amount)} / ${formatUsd(limit)} (${formatPct(ratio)})`
      : `${formatTokens(amount)} / ${formatTokens(limit)} tokens (${formatPct(ratio)})`;
  return {
    key,
    label,
    ratio,
    over: limit === 0 ? true : amount >= threshold,
    summary,
    unknown: false,
  };
}
