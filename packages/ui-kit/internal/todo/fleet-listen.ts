// Listen for live async-worker snapshots published by the task extension.
// Same global key as task/runtime/fleet-bus.ts; no cross-extension import.

const FLEET_BUS_KEY = "__piTaskFleetBus";
const ITEM_CAP = 8;

/** Publish-time bounds so the dock never receives unbounded text. */
const TOOL_CHARS = 24;
const SUMMARY_CHARS = 120;
const MISSION_CHARS = 80;
const ACTIVITY_CAP = 4;

export interface DockAgentActivity {
  /** Bounded tool name. */
  tool: string;
  /** Bounded primary argument: file, command, query, or prompt. */
  summary?: string;
  /** Activity status: "running" | "completed" | "error". */
  status: string;
}

export interface DockAgentItem {
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
  /** Worker session file path, when reported by the task extension. */
  sessionFile?: string;
  /** Recent tool activity, oldest first; at most 4 entries. */
  activity?: DockAgentActivity[];
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
