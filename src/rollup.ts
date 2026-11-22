import { priceUsage, type PriceTable } from "./pricing.js";
import type { Ledger, SessionRecord, StoredMessage } from "./types.js";

export interface PricedMessage {
  nanoUsd: number;
  tokens: number;
  day: string;
  estimated: boolean;
  modelId: string;
  notes: string[];
  agents: string[];
}

export interface MoneyBag {
  nanoUsd: number;
  tokens: number;
  known: boolean;
  estimated: boolean;
  incomplete: boolean;
}

export interface SpendPicture {
  session: MoneyBag;
  dailyGlobal: MoneyBag;
  dailyProject: MoneyBag;
  agent: MoneyBag | null;
  models: Array<{ modelId: string; nanoUsd: number; tokens: number; estimated: boolean }>;
}

export function sessionMessages(session: SessionRecord, table: PriceTable): Map<string, PricedMessage> {
  const map = new Map<string, PricedMessage>();
  const countTranscripts = session.adapter === "claude-code" || session.adapter === "cursor";
  if (countTranscripts) {
    for (const transcript of Object.values(session.transcripts)) {
      if (session.adapter === "cursor" && !transcript.usageFound) continue;
      for (const [id, message] of Object.entries(transcript.messages)) {
        mergeMessage(map, id, message, transcript.agentId, table);
      }
    }
  }
  for (const [id, event] of Object.entries(session.usageEvents)) {
    mergeMessage(map, `event:${id}`, event.message, event.agentId, table);
  }
  return map;
}

export function pictureFor(input: {
  ledger: Ledger;
  sessionId: string;
  agentId?: string;
  projectKey: string;
  day: string;
  table: PriceTable;
}): SpendPicture {
  const session = input.ledger.sessions[input.sessionId];
  const current = session ? [...sessionMessages(session, input.table).values()] : [];
  const sessionBag = bagFrom(current, session?.usageKnown === true);
  const agentMessages = input.agentId
    ? current.filter((message) => message.agents.includes(input.agentId as string))
    : [];
  const agent = input.agentId ? bagFrom(agentMessages, session?.usageKnown === true) : null;

  const dailyGlobalMessages: PricedMessage[] = [];
  const dailyProjectMessages: PricedMessage[] = [];
  let globalIncomplete = false;
  let projectIncomplete = false;
  for (const candidate of Object.values(input.ledger.sessions)) {
    const messages = [...sessionMessages(candidate, input.table).values()].filter(
      (message) => message.day === input.day,
    );
    if (!candidate.usageKnown) globalIncomplete = true;
    dailyGlobalMessages.push(...messages);
    if (candidate.projectKey === input.projectKey || (input.projectKey && candidate.projectKey.startsWith(`${input.projectKey}/`))) {
      dailyProjectMessages.push(...messages);
      if (!candidate.usageKnown) projectIncomplete = true;
    }
  }
  return {
    session: sessionBag,
    dailyGlobal: { ...bagFrom(dailyGlobalMessages, true), incomplete: globalIncomplete },
    dailyProject: { ...bagFrom(dailyProjectMessages, true), incomplete: projectIncomplete },
    agent,
    models: modelBreakdown(current),
  };
}

function mergeMessage(
  map: Map<string, PricedMessage>,
  id: string,
  message: StoredMessage,
  agentId: string | null,
  table: PriceTable,
): void {
  const priced = priceUsage(message.usage, message.model, table);
  const previous = map.get(id);
  if (!previous || priced.nanoUsd >= previous.nanoUsd) {
    map.set(id, {
      nanoUsd: priced.nanoUsd,
      tokens: priced.tokens,
      day: message.day,
      estimated: priced.estimated,
      modelId: priced.modelId,
      notes: priced.notes,
      agents: previous ? [...previous.agents] : [],
    });
  }
  if (agentId) {
    const current = map.get(id);
    if (current && !current.agents.includes(agentId)) current.agents.push(agentId);
  }
}

function bagFrom(messages: PricedMessage[], known: boolean): MoneyBag {
  let nanoUsd = 0;
  let tokens = 0;
  let estimated = false;
  for (const message of messages) {
    nanoUsd += message.nanoUsd;
    tokens += message.tokens;
    if (message.estimated) estimated = true;
  }
  return { nanoUsd, tokens, known, estimated, incomplete: false };
}

function modelBreakdown(messages: PricedMessage[]): SpendPicture["models"] {
  const byModel = new Map<string, { nanoUsd: number; tokens: number; estimated: boolean }>();
  for (const message of messages) {
    const current = byModel.get(message.modelId) ?? { nanoUsd: 0, tokens: 0, estimated: false };
    current.nanoUsd += message.nanoUsd;
    current.tokens += message.tokens;
    current.estimated = current.estimated || message.estimated;
    byModel.set(message.modelId, current);
  }
  return [...byModel.entries()]
    .map(([modelId, totals]) => ({ modelId, ...totals }))
    .sort((a, b) => b.nanoUsd - a.nanoUsd);
}

export function emptyBag(known: boolean): MoneyBag {
  return { nanoUsd: 0, tokens: 0, known, estimated: false, incomplete: false };
}
