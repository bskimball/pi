// Listen for live async-worker snapshots published by the task extension.
// Same global key as task/runtime/fleet-bus.ts; no cross-extension import.

const FLEET_BUS_KEY = "__piTaskFleetBus";
const WORKSPACE_OPEN_KEY = "__piAgentWorkspaceOpen";
const ITEM_CAP = 8;

type WorkspaceRoot = typeof globalThis & {
  [WORKSPACE_OPEN_KEY]?: boolean;
};

/** True while the opaque Agents workspace overlay is open. Fusion Escape abort reads this. */
export function isAgentWorkspaceOpen(): boolean {
  return Boolean((globalThis as WorkspaceRoot)[WORKSPACE_OPEN_KEY]);
}

export function setAgentWorkspaceOpen(open: boolean): void {
  (globalThis as WorkspaceRoot)[WORKSPACE_OPEN_KEY] = open;
}

/** Publish-time bounds so the dock never receives unbounded text. */
const TOOL_CHARS = 24;
const SUMMARY_CHARS = 120;
const MISSION_CHARS = 80;
const MODEL_CHARS = 80;
const ACTIVITY_CAP = 4;

function sanitizeDirective(
  value: DockAgentItem["directive"],
): DockAgentItem["directive"] {
  if (value === undefined || value === null || typeof value !== "object") {
    return undefined;
  }
  const text = String((value as { text?: unknown }).text ?? "").slice(0, MISSION_CHARS);
  if (!text) return undefined;
  return { queued: Boolean((value as { queued?: unknown }).queued), text };
}

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
  /** Resolved model label, e.g. `provider/model-id` or `default model`. */
  model?: string;
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
    model:
      item.model === undefined
        ? undefined
        : String(item.model ?? "").slice(0, MODEL_CHARS),
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
  setAgentWorkspaceOpen(false);
}
