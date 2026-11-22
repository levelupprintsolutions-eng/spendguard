/** Hosts the governor knows how to talk to. */
export type AdapterId = "claude-code" | "codex" | "cursor" | "openclaw" | "gemini-cli" | "proxy";

export type Enforcement = "enforced" | "partial" | "sample";

/** Token usage for one model request, after transcript dedupe. */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  webSearchRequests: number;
  serviceTier: "standard" | "batch" | "priority" | "unknown";
  speed: "standard" | "fast" | "unknown";
  inferenceGeo: "global" | "us" | "other";
}

export interface StoredMessage {
  model?: string;
  usage: NormalizedUsage;
  /** Local calendar day YYYY-MM-DD of the request, or the day the hook observed it. */
  day: string;
}

export interface TranscriptRecord {
  mtimeMs: number;
  size: number;
  agentId: string | null;
  /** True when the file contained at least one assistant usage object. */
  usageFound: boolean;
  messages: Record<string, StoredMessage>;
}

export interface UsageEventRecord {
  agentId: string | null;
  message: StoredMessage;
}

export interface SessionRecord {
  id: string;
  adapter: AdapterId;
  cwd: string;
  projectKey: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Claude sessions are known once a hook has read the transcript (an empty
   * file is a real $0). Codex and Cursor stay unknown until a usage payload
   * or a transcript with usage is seen, so a missing feed cannot look like $0.
   */
  usageKnown: boolean;
  transcripts: Record<string, TranscriptRecord>;
  agents: Record<string, { type?: string; seenAt: string }>;
  usageEvents: Record<string, UsageEventRecord>;
}

export interface Ledger {
  version: 1;
  sessions: Record<string, SessionRecord>;
  /** `${scopeKey}@${threshold}` marks already shown to the user. */
  warnings: string[];
}

/** A cap stored the way a person typed it. Absent fields do not apply. */
export interface Cap {
  usd?: number;
  tokens?: number;
}

export interface ProjectBudget {
  session: Cap | null;
  daily: Cap | null;
}

export interface Config {
  version: 1;
  /** Warn when spend/cap crosses each of these, once per scope. */
  thresholds: number[];
  /** Block at this fraction of a cap. 1 blocks at the cap itself. */
  blockAtRatio: number;
  /** Block when a host has no usage signal yet. Default off. */
  blockWhenSpendUnknown: boolean;
  global: { session: Cap | null; daily: Cap | null };
  projects: Record<string, ProjectBudget>;
  sessions: Record<string, Cap>;
  /** Keyed by `${sessionId}:${agentId}`. */
  subagents: Record<string, Cap>;
}

export interface KillRecord {
  at: string;
  reason: string;
}

export interface Kills {
  version: 1;
  global: KillRecord | null;
  projects: Record<string, KillRecord>;
  sessions: Record<string, KillRecord>;
}

export type HookEventKind =
  | "session_start"
  | "subagent_start"
  | "pre_tool"
  | "permission"
  | "post_tool_batch"
  | "user_prompt"
  | "stop"
  | "subagent_stop"
  | "session_end"
  | "model_usage"
  | "observe";

export interface NormalizedEvent {
  adapter: AdapterId;
  kind: HookEventKind;
  rawEvent: string;
  sessionId: string;
  agentId?: string;
  agentType?: string;
  cwd?: string;
  transcriptPath?: string;
  extraTranscriptPath?: string;
  model?: string;
  usage?: NormalizedUsage;
  /** Stable id so a retried model-usage hook is not billed twice. */
  usageKey?: string;
}

export interface HookOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the user or the model will actually see the warning text. */
  surfacedWarning: boolean;
}
