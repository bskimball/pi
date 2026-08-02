// dive: context compaction rendered as a descent.
//
// Compaction is the least visible important moment in a session: the default
// chrome is a generic braille spinner reading "Compacting context...", and when
// it ends nothing tells you what it cost. Pi constructs that spinner itself and
// exposes no way to restyle it (CompactionStatusIndicator is built internally
// from the compaction_start event), so this is a widget shown alongside it
// rather than a replacement for it.
//
// The reading is literal: the shark leaves the surface, descends while the
// summary is being written, and returns with a number — how much context the
// dive actually reclaimed.
//
// Pi's own spinner owns the words, so this surface carries no label of its own
// while descending. It also carries no progress: compaction has no honest
// percentage, and a mark that lands would read as "finished" while the work is
// still running. Instead the mark never reaches a floor — it holds mid-water
// and the bubbles stream up past it, which reads as an ongoing descent for as
// long as compaction actually takes (commonly tens of seconds).

import type { Component } from "@earendil-works/pi-tui";
import { safeTruncateToWidth } from "./safe-text-layout.ts";
import { reportRenderFailure } from "./tool-receipt.ts";

export interface DiveTheme {
  fg(token: string, text: string): string;
}

/** Frame cadence for the descent. Slow: this is a held breath, not a spinner. */
export const DIVE_FRAME_MS = 180;

/** Rows of water under the surface rule. */
const DEPTH_ROWS = 3;

const SURFACE = "\u2500";
/** The descending mark. Same minimal dorsal cue the observatory falls back to. */
const MARK = "\u25b4";
/** Bubbles rising past the descending mark. */
const TRACE = "\u00b7";

/** Frames the mark spends at each vertical position before bobbing. */
const BOB_FRAMES = 6;
/** Frames between horizontal sway steps. */
const SWAY_FRAMES = 4;
/** Rise cadence for bubbles: one row per RISE_FRAMES frames. */
const RISE_FRAMES = 3;
/** Length of the bubble cycle, in frames. */
const RISE_PERIOD = 9;

export type DivePhase = "descending" | "surfaced";

function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * The dive surface. Owns one interval while descending; the surfaced state is
 * static and keeps no clock.
 */
export class DiveView implements Component {
  private phase: DivePhase = "descending";
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private before: number | undefined;

  constructor(
    private theme: DiveTheme,
    private requestRender: () => void,
  ) {}

  /** Begin the descent. */
  start(): void {
    if (this.disposed) return;
    this.phase = "descending";
    this.frame = 0;
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), DIVE_FRAME_MS);
      this.timer.unref?.();
    }
  }

  /**
   * True while the descent is still running, i.e. no `session_compact` has
   * arrived. Callers use this to clean up a compaction that was cancelled or
   * failed, since Pi only emits `session_compact` on success.
   */
  get descending(): boolean {
    return this.phase === "descending";
  }

  /**
   * Surface. Stops the clock; the result row persists until the next input.
   *
   * Only the pre-compaction size is reported, because it is the only figure
   * that is actually known here: Pi computes an `estimatedTokensAfter` but does
   * not put it on `SessionCompactEvent`, and `getContextUsage()` deliberately
   * returns null until the next assistant response. A "before -> after" pair
   * would therefore be invented, so it is not shown.
   */
  surface(before: number | undefined): void {
    if (this.disposed) return;
    this.phase = "surfaced";
    this.before = before;
    this.stop();
    this.repaint();
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Advance one frame. Public so the preview harness can drive it. */
  tick(): void {
    if (this.disposed) {
      this.stop();
      return;
    }
    this.frame++;
    this.repaint();
  }

  private repaint(): void {
    try {
      this.requestRender();
    } catch {
      // A repaint failure must never kill the clock's owner.
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  invalidate(): void {}

  render(width: number): string[] {
    try {
      if (this.disposed || width <= 0) return [];
      return this.phase === "descending"
        ? this.renderDescent(width)
        : this.renderSurfaced(width);
    } catch (error) {
      reportRenderFailure("dive", error);
      return [];
    }
  }

  private renderDescent(width: number): string[] {
    const fg = this.theme.fg.bind(this.theme);
    const frame = this.frame;

    // The mark bobs between the two lower rows and never lands on a floor, so
    // the descent stays legible for an arbitrarily long compaction.
    const markRow =
      DEPTH_ROWS < 2
        ? 0
        : DEPTH_ROWS - 2 + (Math.floor(frame / BOB_FRAMES) % 2);

    // Slow triangle sway (0,1,2,1) keeps the column alive without suggesting
    // the mark is travelling anywhere in particular.
    const swayStep = Math.floor(frame / SWAY_FRAMES) % 4;
    const sway = swayStep === 3 ? 1 : swayStep;
    const indent = 2;
    const column = Math.min(Math.max(0, width - 1), indent + sway);

    const rows: string[] = [];
    rows.push(
      safeTruncateToWidth(
        fg("borderMuted", SURFACE.repeat(Math.max(0, width))),
        width,
      ),
    );

    for (let row = 0; row < DEPTH_ROWS; row++) {
      const cells: string[] = new Array(width).fill(" ");
      if (column < width && row === markRow) {
        cells[column] = fg("customMessageLabel", MARK);
      } else if (row < markRow) {
        // Offsetting the phase by the row makes a given bubble occupy a
        // higher row on each successive cycle, so the trace rises rather than
        // blinking in place. Two streams at different columns keep the water
        // from reading as a single dotted line.
        for (const [offset, phase] of [
          [0, 0],
          [2, 4],
        ] as const) {
          const bubbleColumn = indent + offset;
          if (bubbleColumn >= width) continue;
          const cycle = (frame + row * RISE_FRAMES + phase) % RISE_PERIOD;
          if (cycle < 2) cells[bubbleColumn] = fg("borderMuted", TRACE);
        }
      }
      rows.push(
        safeTruncateToWidth(cells.join("").replace(/\s+$/, ""), width),
      );
    }
    return rows;
  }

  private renderSurfaced(width: number): string[] {
    const fg = this.theme.fg.bind(this.theme);
    const before = this.before;
    const detail =
      before !== undefined && before > 0
        ? `carried ${compactTokens(before)} down`
        : undefined;
    const text = detail
      ? `${fg("muted", "surfaced")}  ${fg("dim", detail)}`
      : fg("muted", "surfaced");
    return [
      safeTruncateToWidth(
        fg("borderMuted", SURFACE.repeat(Math.max(0, width))),
        width,
      ),
      safeTruncateToWidth(`  ${text}`, width),
    ];
  }
}
