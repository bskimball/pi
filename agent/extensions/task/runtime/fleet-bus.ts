// Process-global fleet snapshot bus. Apex's todo dock listens here so the
// agents tab can share that widget without importing this extension.

export const FLEET_BUS_KEY = "__piTaskFleetBus";

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
  /** True for Fusion's single persistent sidekick. */
  fusion?: boolean;
}

/** Publish-time bounds so the dock never receives unbounded text. */
const TOOL_CHARS = 24;
const MISSION_CHARS = 80;

/**
 * Stable render key; heartbeat-only activity must not remount the fleet UI.
 * Structural fields (phase/tool/turns/generation/waitingUi/mission/fusion)
 * repaint; raw lastEventAt churn never does.
 */
export function fleetSnapshotKey(
  items: readonly FleetSnapshotItem[],
): string {
  return items
    .map((item) => `${item.id}\0${item.agent}\0${item.lifecycle}\0${item.createdAt}\0${item.phase ?? ""}\0${item.tool ?? ""}\0${item.turns ?? ""}\0${item.generation ?? ""}\0${item.waitingUi ?? ""}\0${item.mission ?? ""}\0${item.fusion ? "1" : ""}`)
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
    fusion: item.fusion === undefined ? undefined : Boolean(item.fusion),
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
}
