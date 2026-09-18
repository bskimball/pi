// Process-global fleet snapshot bus. Apex's todo dock listens here so the
// agents tab can share that widget without importing this extension.

export const FLEET_BUS_KEY = "__piTaskFleetBus";
export const WORKSPACE_OPEN_KEY = "__piAgentWorkspaceOpen";

type WorkspaceRoot = typeof globalThis & {
  [WORKSPACE_OPEN_KEY]?: boolean;
};

/** True while the opaque Agents workspace overlay is open. Fusion Escape abort reads this. */
export function isAgentWorkspaceOpen(): boolean {
  return Boolean((globalThis as WorkspaceRoot)[WORKSPACE_OPEN_KEY]);
}

export interface FleetSnapshotActivity {
  /** Bounded tool name. */
  tool: string;
  /** Bounded primary argument: file, command, query, or prompt. */
  summary?: string;
  /** Activity status: "running" | "completed" | "error". */
  status: string;
}

export interface FleetSnapshotItem {
  id: string;
  agent: string;
  lifecycle: string;
  createdAt: number;
  lastEventAt?: number;
  /** Live execution phase ("model" | "tool" | "retry" | "compacting" | "none"). */
  phase?: string;
  /** Name of the most recently started running tool, if any. */
  tool?: string;
  turns?: number;
  maxTurns?: number;
  generation?: number;
  /** Pending UI requests: the "blocked on a question" signal. */
  waitingUi?: number;
  /** Bounded short mission label tracking the current generation. */
  mission?: string;
  /** Last steer/follow_up for this generation; queued until the worker picks it up. */
  directive?: { queued: boolean; text: string };
  /** True for Fusion's single persistent sidekick. */
  fusion?: boolean;
  /** Worker session file path, when reported by the task extension. */
  sessionFile?: string;
  /** Recent tool activity, oldest first; at most 4 entries. */
  activity?: FleetSnapshotActivity[];
}

/** Publish-time bounds so the dock never receives unbounded text. */
const TOOL_CHARS = 24;
const SUMMARY_CHARS = 120;
const MISSION_CHARS = 80;
const ACTIVITY_CAP = 4;

function sanitizeDirective(
  value: FleetSnapshotItem["directive"],
): FleetSnapshotItem["directive"] {
  if (value === undefined || value === null || typeof value !== "object") {
    return undefined;
  }
  const text = String((value as { text?: unknown }).text ?? "").slice(0, MISSION_CHARS);
  if (!text) return undefined;
  return { queued: Boolean((value as { queued?: unknown }).queued), text };
}

/**
 * Stable render key; heartbeat-only activity must not remount the fleet UI.
 * Structural fields (phase/tool/turns/generation/waitingUi/mission/directive/fusion
 * and the bounded recent-activity list) repaint; raw lastEventAt churn
 * never does. Tool start/end changes the activity list, so it repaints;
 * streaming deltas never touch the ledger (see below), so they cannot.
 */
export function fleetSnapshotKey(
  items: readonly FleetSnapshotItem[],
): string {
  return items
    .map(
      (item) =>
        `${item.id}\0${item.agent}\0${item.lifecycle}\0${item.createdAt}\0${item.phase ?? ""}\0${item.tool ?? ""}\0${item.turns ?? ""}\0${item.generation ?? ""}\0${item.waitingUi ?? ""}\0${item.mission ?? ""}\0${item.directive ? `${item.directive.queued ? "q" : "d"}:${item.directive.text}` : ""}\0${item.fusion ? "1" : ""}\0${item.sessionFile ?? ""}\0${(item.activity ?? []).map((entry) => `${entry.tool}:${entry.summary ?? ""}:${entry.status}`).join(",")}`,
    )
    .join("\n");
}

type FleetListener = (items: readonly FleetSnapshotItem[]) => void;

interface FleetBus {
  items: FleetSnapshotItem[];
  listeners: Set<FleetListener>;
}

function bus(): FleetBus {
  const root = globalThis as typeof globalThis & {
    [FLEET_BUS_KEY]?: FleetBus;
  };
  if (!root[FLEET_BUS_KEY]) {
    root[FLEET_BUS_KEY] = { items: [], listeners: new Set() };
  }
  return root[FLEET_BUS_KEY];
}

export function currentFleetSnapshot(): readonly FleetSnapshotItem[] {
  return bus().items;
}

export function publishFleetSnapshot(items: readonly FleetSnapshotItem[]): void {
  const next = items.slice(0, 8).map((item) => ({
    id: String(item.id ?? ""),
    agent: String(item.agent ?? ""),
    lifecycle: String(item.lifecycle ?? ""),
    createdAt: Number(item.createdAt) || 0,
    lastEventAt:
      item.lastEventAt === undefined ? undefined : Number(item.lastEventAt) || 0,
    phase: item.phase === undefined ? undefined : String(item.phase ?? ""),
    tool:
      item.tool === undefined
        ? undefined
        : String(item.tool ?? "").slice(0, TOOL_CHARS),
    turns: item.turns === undefined ? undefined : Number(item.turns) || 0,
    maxTurns: item.maxTurns === undefined ? undefined : Number(item.maxTurns) || 0,
    generation:
      item.generation === undefined ? undefined : Number(item.generation) || 0,
    waitingUi:
      item.waitingUi === undefined ? undefined : Number(item.waitingUi) || 0,
    mission:
      item.mission === undefined
        ? undefined
        : String(item.mission ?? "").slice(0, MISSION_CHARS),
    directive: sanitizeDirective(item.directive),
    fusion: item.fusion === undefined ? undefined : Boolean(item.fusion),
    sessionFile:
      item.sessionFile === undefined ? undefined : String(item.sessionFile ?? ""),
    activity:
      item.activity === undefined
        ? undefined
        : item.activity.slice(0, ACTIVITY_CAP).map((entry) => ({
            tool: String(entry?.tool ?? "").slice(0, TOOL_CHARS),
            summary:
              entry?.summary === undefined
                ? undefined
                : String(entry.summary ?? "").slice(0, SUMMARY_CHARS),
            status: String(entry?.status ?? ""),
          })),
  }));
  const state = bus();
  state.items = next;
  for (const listener of state.listeners) {
    try {
      listener(next);
    } catch {
      // A dock failure must not interrupt worker lifecycle.
    }
  }
}

export function subscribeFleetSnapshot(listener: FleetListener): () => void {
  const state = bus();
  state.listeners.add(listener);
  try {
    listener(state.items);
  } catch {
    // Same isolation as publish.
  }
  return () => {
    state.listeners.delete(listener);
  };
}

/** Test helper: drop listeners and items so cases do not leak across files. */
export function resetFleetBus(): void {
  const root = globalThis as typeof globalThis & {
    [FLEET_BUS_KEY]?: FleetBus;
  };
  const existing = root[FLEET_BUS_KEY];
  if (existing) existing.listeners.clear();
  root[FLEET_BUS_KEY] = { items: [], listeners: new Set() };
  (globalThis as WorkspaceRoot)[WORKSPACE_OPEN_KEY] = false;
}
