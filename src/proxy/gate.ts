import { createHash } from "node:crypto";
import { matchProject, resolveSessionCap } from "../budget.js";
import { decide, type ResolvedCaps } from "../decide.js";
import { dayKey, resolveExisting } from "../paths.js";
import { loadPriceTable } from "../pricing.js";
import { pictureFor } from "../rollup.js";
import { emptySession, updateStore } from "../store.js";
import type { NormalizedUsage, SessionRecord } from "../types.js";

export interface GateResult {
  action: "allow" | "warn" | "block";
  message: string;
}

export function inspectSession(input: {
  home: string;
  now?: Date;
  sessionId: string;
  cwd: string;
}): GateResult {
  const now = input.now ?? new Date();
  return updateStore(input.home, ({ config, kills, ledger }) => {
    const session = ensureProxySession(ledger.sessions, input.sessionId, input.cwd, now);
    ledger.sessions[session.id] = session;
    const projectKey = session.projectKey;
    const matched = projectKey ? matchProject(config, projectKey) : null;
    const table = loadPriceTable({ home: input.home });
    const picture = pictureFor({
      ledger,
      sessionId: session.id,
      projectKey: matched?.key ?? projectKey,
      day: dayKey(now),
      table,
    });
    const caps: ResolvedCaps = {
      session: resolveSessionCap(config, session.id, projectKey),
      dailyGlobal: config.global.daily,
      dailyProject: matched?.budget.daily ?? null,
      agent: null,
      blockAtRatio: config.blockAtRatio,
      thresholds: config.thresholds,
      blockWhenSpendUnknown: config.blockWhenSpendUnknown,
    };
    const projectKill = Object.entries(kills.projects).find(([key]) => projectKey && (projectKey === key || projectKey.startsWith(`${key}/`)));
    const decision = decide({
      spend: picture,
      caps,
      kills: {
        global: kills.global,
        project: projectKill ? projectKill[1] : null,
        session: kills.sessions[session.id] ?? null,
      },
      warnings: ledger.warnings,
      sessionId: session.id,
    });
    if (decision.action === "warn") {
      for (const mark of decision.warningMarks) {
        if (!ledger.warnings.includes(mark)) ledger.warnings.push(mark);
      }
    }
    return { action: decision.action, message: decision.systemMessage ?? decision.reason };
  });
}

export function recordProxyCall(input: {
  home: string;
  now?: Date;
  sessionId: string;
  cwd: string;
  model?: string;
  usage: NormalizedUsage;
  usageKey: string;
}): void {
  const now = input.now ?? new Date();
  updateStore(input.home, ({ ledger }) => {
    const session = ensureProxySession(ledger.sessions, input.sessionId, input.cwd, now);
    session.usageKnown = true;
    session.updatedAt = now.toISOString();
    session.usageEvents[input.usageKey] = {
      agentId: null,
      message: {
        ...(input.model ? { model: input.model } : {}),
        usage: input.usage,
        day: dayKey(now),
      },
    };
    ledger.sessions[session.id] = session;
  });
}

export function usageKeyFor(sessionId: string, raw: string): string {
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `proxy:${sessionId}:${hash}:${Date.now().toString(36)}`;
}

function ensureProxySession(
  sessions: Record<string, SessionRecord>,
  sessionId: string,
  cwd: string,
  now: Date,
): SessionRecord {
  const id = sessionId || "proxy";
  const projectKey = cwd ? resolveExisting(cwd) : "";
  const existing = sessions[id];
  if (existing) {
    if (!existing.projectKey && projectKey) {
      existing.cwd = projectKey;
      existing.projectKey = projectKey;
    }
    existing.usageKnown = true;
    return existing;
  }
  const created = emptySession({ id, adapter: "proxy", cwd: projectKey, projectKey, now });
  created.usageKnown = true;
  return created;
}
