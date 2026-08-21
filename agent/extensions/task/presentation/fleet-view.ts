// fleet-view: persistent below-editor summary of live async RPC workers.
//
// Event-driven only. Callers snapshot workers outside the render closure and
// pass a frozen list so the widget factory never scans a registry.

import { safeTruncateToWidth } from "./safe-text-layout.ts";
import { formatDuration } from "./ui-common.ts";
import { lifecycleKind, statusLabel, type StatusTheme } from "./status-view.ts";

const FLEET_LINE_CAP = 10;
const FLEET_ITEM_CAP = 8;
const AGENT_CAP = 24;

export const FLEET_WIDGET_KEY = "subagents";

export interface FleetWorkerItem {
  id: string;
  agent: string;
  lifecycle: string;
  createdAt: number;
  lastEventAt?: number;
}

function ageMs(item: FleetWorkerItem, now: number): number {
  const stamp = item.lastEventAt ?? item.createdAt;
  return Math.max(0, now - stamp);
}

function compactAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  return `${Math.floor(ms / 60_000)}m`;
}

function clipAgent(agent: string): string {
  const text = String(agent ?? "").replace(/\s+/g, " ").trim() || "agent";
  if (text.length <= AGENT_CAP) return text;
  return `${text.slice(0, AGENT_CAP - 3)}...`;
}

/** One bounded collapsed line. Empty when there are no live workers. */
export function renderFleetCollapsed(
  items: readonly FleetWorkerItem[],
  now = Date.now(),
): string | undefined {
  const live = items.slice(0, FLEET_ITEM_CAP);
  if (!live.length) return undefined;
  const noun = live.length === 1 ? "agent" : "agents";
  const parts = live.map((item) => {
    const kind = lifecycleKind(item.lifecycle);
    return `${clipAgent(item.agent)} ${statusLabel(kind)} ${compactAge(ageMs(item, now))}`;
  });
  return `${live.length} ${noun} · ${parts.join(" · ")}`;
}

/** Expanded fleet (display only). Hard-bounded to ~10 rows. */
export function renderFleetExpanded(
  theme: StatusTheme,
  width: number,
  items: readonly FleetWorkerItem[],
  now = Date.now(),
): string[] {
  const collapsed = renderFleetCollapsed(items, now);
  if (!collapsed) return [];
  const live = items.slice(0, FLEET_ITEM_CAP);
  const lines = [
    safeTruncateToWidth(theme.fg("muted", collapsed), width),
  ];
  for (const item of live) {
    if (lines.length >= FLEET_LINE_CAP) break;
    const kind = lifecycleKind(item.lifecycle);
    const elapsed = formatDuration(ageMs(item, now));
    lines.push(
      safeTruncateToWidth(
        `${theme.fg("dim", item.id)} ${theme.fg("accent", clipAgent(item.agent))} ${theme.fg("muted", statusLabel(kind))} ${theme.fg("dim", elapsed)}`,
        width,
      ),
    );
  }
  return lines.slice(0, FLEET_LINE_CAP);
}

export function renderFleetWidgetLines(
  theme: StatusTheme,
  width: number,
  items: readonly FleetWorkerItem[],
  now = Date.now(),
): string[] {
  const line = renderFleetCollapsed(items, now);
  if (!line) return [];
  return [safeTruncateToWidth(theme.fg("muted", line), width)];
}
