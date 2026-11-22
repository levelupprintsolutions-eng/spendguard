import { resolveExisting } from "./paths.js";
import { updateStore } from "./store.js";
import type { Kills } from "./types.js";

export type KillScope =
  | { kind: "global" }
  | { kind: "project"; project: string }
  | { kind: "session"; sessionId: string }
  | { kind: "all" };

export function engageKill(home: string, scope: KillScope, reason: string, now = new Date()): Kills {
  const record = { at: now.toISOString(), reason: reason || "manual kill switch" };
  return updateStore(home, ({ kills }) => {
    if (scope.kind === "global" || scope.kind === "all") kills.global = record;
    if (scope.kind === "project") kills.projects[resolveExisting(scope.project)] = record;
    if (scope.kind === "session") kills.sessions[scope.sessionId] = record;
    return kills;
  });
}

export function clearKill(home: string, scope: KillScope): Kills {
  return updateStore(home, ({ kills }) => {
    if (scope.kind === "all") {
      kills.global = null;
      kills.projects = {};
      kills.sessions = {};
      return kills;
    }
    if (scope.kind === "global") kills.global = null;
    if (scope.kind === "project") delete kills.projects[resolveExisting(scope.project)];
    if (scope.kind === "session") delete kills.sessions[scope.sessionId];
    return kills;
  });
}
