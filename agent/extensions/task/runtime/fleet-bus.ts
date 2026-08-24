// Process-global fleet snapshot bus. Apex's todo dock listens here so the
// agents tab can share that widget without importing this extension.

export const FLEET_BUS_KEY = "__piTaskFleetBus";

export interface FleetSnapshotItem {
  id: string;
  agent: string;
  lifecycle: string;
  createdAt: number;
  lastEventAt?: number;
}

/** Stable render key; heartbeat-only activity must not remount the fleet UI. */
export function fleetSnapshotKey(
  items: readonly FleetSnapshotItem[],
): string {
  return items
    .map((item) => `${item.id}\0${item.agent}\0${item.lifecycle}\0${item.createdAt}`)
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
