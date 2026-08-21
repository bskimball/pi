// Listen for live async-worker snapshots published by the task extension.
// Same global key as task/runtime/fleet-bus.ts; no cross-extension import.

const FLEET_BUS_KEY = "__piTaskFleetBus";
const ITEM_CAP = 8;

export interface DockAgentItem {
  id: string;
  agent: string;
  lifecycle: string;
  createdAt: number;
  lastEventAt?: number;
}

type FleetListener = (items: readonly DockAgentItem[]) => void;

interface FleetBus {
  items: DockAgentItem[];
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

export function currentDockAgents(): DockAgentItem[] {
  return bus().items.slice(0, ITEM_CAP);
}

export function subscribeDockAgents(listener: FleetListener): () => void {
  const state = bus();
  state.listeners.add(listener);
  try {
    listener(state.items.slice(0, ITEM_CAP));
  } catch {
    // Dock failures must not interrupt publishers.
  }
  return () => {
    state.listeners.delete(listener);
  };
}

export function publishDockAgents(items: readonly DockAgentItem[]): void {
  const next = items.slice(0, ITEM_CAP).map((item) => ({
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
      // Same isolation as subscribe.
    }
  }
}

export function resetDockAgents(): void {
  const root = globalThis as typeof globalThis & {
    [FLEET_BUS_KEY]?: FleetBus;
  };
  const existing = root[FLEET_BUS_KEY];
  if (existing) existing.listeners.clear();
  root[FLEET_BUS_KEY] = { items: [], listeners: new Set() };
}
