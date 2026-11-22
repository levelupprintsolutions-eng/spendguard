import type { Decision } from "../decide.js";
import type { AdapterId, Enforcement, HookOutput, NormalizedEvent } from "../types.js";

export interface HookSpec {
  event: string;
  timeout: number;
  onFailure?: "block";
  statusMessage?: string;
  /** Cursor blocks the action when the hook crashes. */
  failClosed?: boolean;
}

export interface AgentAdapter {
  id: AdapterId;
  displayName: string;
  enforcement: Enforcement;
  summary: string;
  limitations: string[];
  hookSpecs: HookSpec[];
  normalize(payload: Record<string, unknown>): NormalizedEvent | null;
  render(event: NormalizedEvent, decision: Decision): HookOutput;
}

export function silent(): HookOutput {
  return { exitCode: 0, stdout: "", stderr: "", surfacedWarning: false };
}

export function jsonOutput(body: unknown, surfacedWarning: boolean): HookOutput {
  return { exitCode: 0, stdout: JSON.stringify(body), stderr: "", surfacedWarning };
}

export function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) + hash + text.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(16);
}
