// fleet-waterline: live async workers as sharks cruising a horizon rule.
//
// The concurrency cap is otherwise a number you have to go ask for (task_list).
// Here each live worker is one dorsal fin travelling along a single rule above
// the editor, so "three workers, one of them stalled" is a glance rather than a
// query. When the last worker is reaped the widget removes itself entirely.
//
// Timer ownership: apex is otherwise timer-free because Pi owns the animation
// clock, but nothing in Pi drives a per-worker position. So this component owns
// exactly one interval, started on the first live fin and cleared on the last,
// and it is the only clock in the extension. `dispose()` is wired to Pi's
// widget teardown, so a session swap cannot leak it.

import type { Component } from "@earendil-works/pi-tui";
import { FIN_PHASES, FIN_WIDTH } from "./fin-art.ts";
import { TRUECOLOR, pixelCells } from "./pixel-art.ts";
import { safeTruncateToWidth } from "./safe-text-layout.ts";
import { reportRenderFailure } from "./tool-receipt.ts";

export interface FleetTheme {
  fg(token: string, text: string): string;
}

/** One live worker's presence on the surface. */
export interface FleetSwimmer {
  id: string;
  agent: string;
  /**
   * When the worker last produced an event. Movement is derived from this at
   * frame time rather than snapshotted as a boolean: the fleet is synchronized
   * by worker events, so a worker that simply goes silent would otherwise never
   * transition to drifting — which is exactly the case the surface exists to
   * make visible.
   */
  lastEventAt: number;
  /** True when the worker needs the user (waiting on a UI reply). */
  waiting: boolean;
}

/**
 * Frame cadence. Slow enough to read as cruising rather than scuttling, and
 * slow enough that a stalled fin is visibly stalled.
 */
export const FLEET_FRAME_MS = 220;

/** Columns advanced per frame for a worker that is actively producing events. */
const MOVING_SPEED = 1;
/** A worker counts as under way while it produced an event this recently. */
const MOVING_WINDOW_MS = 3_000;
/**
 * A worker with no recent events still drifts, just slowly: a dead-still fin
 * reads as a rendering bug, while a slow one reads as a stalled worker.
 */
const IDLE_SPEED = 0.18;

/** The rule the fins swim along, and the sky above it. */
const WATERLINE = "\u2500";

interface SwimmerState {
  id: string;
  agent: string;
  /** Fractional column of the fin's left edge; wraps at the rule's width. */
  x: number;
  lastEventAt: number;
  waiting: boolean;
  phase: number;
}

/**
 * The fleet surface. Rows: one waterline carrying the fins, and nothing else —
 * the widget must stay cheap because it repaints several times a second.
 */
export class FleetWaterline implements Component {
  private swimmers: SwimmerState[] = [];
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private theme: FleetTheme,
    private requestRender: () => void,
  ) {}

  /**
   * Replace the live set. Existing fins keep their position so a worker does
   * not teleport when an unrelated worker starts or is reaped.
   */
  setSwimmers(next: readonly FleetSwimmer[]): void {
    if (this.disposed) return;
    const previous = new Map(this.swimmers.map((s) => [s.id, s]));
    this.swimmers = next.map((swimmer, index) => {
      const prior = previous.get(swimmer.id);
      return {
        id: swimmer.id,
        agent: swimmer.agent,
        // New fins enter staggered rather than stacked on the left edge.
        x: prior?.x ?? index * (FIN_WIDTH + 4),
        lastEventAt: swimmer.lastEventAt,
        waiting: swimmer.waiting,
        phase: prior?.phase ?? 0,
      };
    });
    if (this.swimmers.length === 0) this.stop();
    else this.start();
  }

  get size(): number {
    return this.swimmers.length;
  }

  private start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => this.tick(), FLEET_FRAME_MS);
    // Never hold the process open for an ornament.
    this.timer.unref?.();
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Advance one frame. Public so the preview harness can drive it. */
  tick(): void {
    if (this.disposed || this.swimmers.length === 0) {
      this.stop();
      return;
    }
    const now = Date.now();
    for (const swimmer of this.swimmers) {
      // A worker waiting on the user holds station: it is not making progress
      // and the stillness is the point.
      if (swimmer.waiting) continue;
      const moving = now - swimmer.lastEventAt < MOVING_WINDOW_MS;
      swimmer.x += moving ? MOVING_SPEED : IDLE_SPEED;
      swimmer.phase = (swimmer.phase + 1) % FIN_PHASES.length;
    }
    try {
      this.requestRender();
    } catch {
      // A repaint failure must never kill the clock's owner.
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.swimmers = [];
  }

  invalidate(): void {}

  render(width: number): string[] {
    try {
      if (this.disposed || width <= 0 || this.swimmers.length === 0) return [];
      return this.compose(width);
    } catch (error) {
      reportRenderFailure("fleet-waterline", error);
      return [];
    }
  }

  private compose(width: number): string[] {
    const span = Math.max(FIN_WIDTH + 2, width);
    // Fins wrap through a span wider than the rule so one can swim off the
    // right edge and reappear rather than piling up at a wall.
    const track = span;

    // Row 0 is the fin's upper half (above the surface), row 1 is where the
    // fin meets the rule. Build both as cell arrays, then paint.
    const sky: string[] = new Array(span).fill(" ");
    const surface: (string | null)[] = new Array(span).fill(null);

    for (const swimmer of this.swimmers) {
      const left = Math.floor(((swimmer.x % track) + track) % track);
      const sprite = FIN_PHASES[swimmer.phase % FIN_PHASES.length];
      if (!sprite) continue;
      const upper = TRUECOLOR ? pixelCells(sprite[0] ?? "") : [];
      const lower = TRUECOLOR ? pixelCells(sprite[1] ?? "") : [];
      for (let offset = 0; offset < FIN_WIDTH; offset++) {
        const column = left + offset;
        if (column >= span) break;
        const top = upper[offset];
        if (top && top !== " ") sky[column] = top;
        const bottom = lower[offset];
        if (bottom && bottom !== " ") surface[column] = bottom;
      }
      if (!TRUECOLOR) {
        // Honest fallback: no truecolor means no sprite, so mark the worker's
        // position with the same minimal dorsal cue the observatory uses.
        const column = Math.min(span - 1, left + Math.floor(FIN_WIDTH / 2));
        sky[column] = this.theme.fg("customMessageLabel", "\u25b4");
      }
    }

    const rule = surface
      .map((cell) => cell ?? this.theme.fg("borderMuted", WATERLINE))
      .join("");

    return [
      safeTruncateToWidth(sky.join("").replace(/\s+$/, ""), width),
      safeTruncateToWidth(rule, width),
    ];
  }
}
