import { boundText } from "./text-bounds.ts";
import { SETTLED_RESULT_CHARS } from "./worker-status.ts";

export type MissionNodeStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface MissionNodeInput {
  id: string;
  agent: string;
  prompt: string;
  dependsOn?: readonly string[];
  cwd?: string;
  model?: string;
  reportSchema?: string;
  context?: "fresh" | "fork";
}

export interface MissionNodeState extends MissionNodeInput {
  status: MissionNodeStatus;
  startedAt?: number;
  endedAt?: number;
  turns?: number;
  result?: string;
  error?: string;
}

export function validateMissionNodes(
  nodes: readonly MissionNodeInput[],
): string | undefined {
  if (!nodes.length) return "nodes must contain at least one mission node.";
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node.id.trim()) return "mission node id must not be empty.";
    if (ids.has(node.id)) return `duplicate mission node id "${node.id}".`;
    ids.add(node.id);
    if (!node.agent.trim()) return `agent is required for mission node "${node.id}".`;
    if (!node.prompt.trim()) return `prompt is required for mission node "${node.id}".`;
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (dependency === node.id) {
        return `mission node "${node.id}" cannot depend on itself.`;
      }
      if (!ids.has(dependency)) {
        return `mission node "${node.id}" depends on unknown node "${dependency}".`;
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  for (const node of nodes) {
    if (!visit(node.id)) return `mission dependency cycle includes "${node.id}".`;
  }
  return undefined;
}

export function missionWriterConflict(
  nodes: readonly MissionNodeInput[],
  isWriter: (agent: string) => boolean,
  resolveCwd: (cwd: string | undefined) => string,
): string | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const dependsOn = (node: MissionNodeInput, ancestor: string): boolean => {
    const pending = [...(node.dependsOn ?? [])];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === ancestor) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(byId.get(id)?.dependsOn ?? []));
    }
    return false;
  };
  const writers = nodes.filter((node) => isWriter(node.agent));
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      const left = writers[i];
      const right = writers[j];
      if (
        resolveCwd(left.cwd) === resolveCwd(right.cwd) &&
        !dependsOn(left, right.id) &&
        !dependsOn(right, left.id)
      ) {
        return `writer nodes "${left.id}" and "${right.id}" share a worktree; isolate them or serialize outside mission.`;
      }
    }
  }
  return undefined;
}

export function substituteMissionResults(
  prompt: string,
  dependencies: readonly string[],
  results: ReadonlyMap<string, string>,
): string {
  let rendered = prompt;
  for (const dependency of dependencies) {
    const value = boundText(
      results.get(dependency) ?? "",
      SETTLED_RESULT_CHARS,
      Number.POSITIVE_INFINITY,
    ).text;
    rendered = rendered.split(`{{${dependency}}}`).join(value);
  }
  return rendered;
}

export function readyMissionNodes(
  nodes: readonly MissionNodeState[],
): MissionNodeState[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter(
    (node) =>
      node.status === "pending" &&
      (node.dependsOn ?? []).every(
        (dependency) => byId.get(dependency)?.status === "succeeded",
      ),
  );
}

export function skipBlockedMissionNodes(nodes: MissionNodeState[]): number {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let changed = 0;
  for (const node of nodes) {
    if (node.status !== "pending") continue;
    const failedDependency = (node.dependsOn ?? []).find((dependency) => {
      const status = byId.get(dependency)?.status;
      return status === "failed" || status === "skipped";
    });
    if (!failedDependency) continue;
    node.status = "skipped";
    node.error = `dependency "${failedDependency}" did not succeed`;
    node.endedAt = Date.now();
    changed++;
  }
  return changed;
}

export function missionTelemetry(
  nodes: readonly MissionNodeState[],
  startedAt: number,
  endedAt: number,
  concurrency: number,
): {
  elapsedMs: number;
  workerMs: number;
  utilization: number;
  peakConcurrency: number;
} {
  const events: Array<{ at: number; delta: number }> = [];
  let workerMs = 0;
  for (const node of nodes) {
    if (node.startedAt === undefined || node.endedAt === undefined) continue;
    workerMs += Math.max(0, node.endedAt - node.startedAt);
    events.push(
      { at: node.startedAt, delta: 1 },
      { at: node.endedAt, delta: -1 },
    );
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let peakConcurrency = 0;
  for (const event of events) {
    active += event.delta;
    peakConcurrency = Math.max(peakConcurrency, active);
  }
  const elapsedMs = Math.max(0, endedAt - startedAt);
  const capacityMs = elapsedMs * Math.max(1, concurrency);
  return {
    elapsedMs,
    workerMs,
    utilization: capacityMs > 0 ? Math.min(1, workerMs / capacityMs) : 0,
    peakConcurrency,
  };
}

export function formatMissionDigest(nodes: readonly MissionNodeState[]): string {
  return nodes
    .map((node) => {
      const elapsed =
        node.startedAt !== undefined && node.endedAt !== undefined
          ? ` · ${Math.max(0, node.endedAt - node.startedAt)}ms`
          : "";
      const detail = node.error ? ` · ${node.error}` : "";
      return `${node.id} ${node.status} ${node.agent}${elapsed}${detail}`;
    })
    .join("\n");
}
