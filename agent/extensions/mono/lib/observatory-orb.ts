// observatory-orb: the keyboard-focusable π orb.
//
// A pi-tui Component that renders the observatory splash in its selected
// state and turns arrow/tab/enter/escape into a single terminal result. It
// owns no timers and no render scheduling: pi-tui repaints after every
// handleInput, so selection movement is purely input-driven.

import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { reportRenderFailure } from "./tool-receipt.ts";
import { fallbackTruncateToWidth } from "./safe-text-layout.ts";
import {
  featuredAt,
  featuredEntries,
  renderObservatory,
  type FeaturedEntry,
  type Observatory,
} from "./observatory.ts";

export type ObservatoryOrbResult =
  | { action: "launch"; entry: FeaturedEntry }
  | { action: "dismiss" }
  | { action: "passthrough"; text: string };

const KEY_PREVIOUS = new Set(["\x1b[A", "\x1b[D"]);
const KEY_NEXT = new Set(["\x1b[B", "\x1b[C", "\t"]);
const KEY_LAUNCH = new Set(["\r", "\n"]);

/** True for a lone printable BMP character, i.e. the user starting to type. */
function isPrintable(data: string): boolean {
  if ([...data].length !== 1) return false;
  const code = data.codePointAt(0);
  return code !== undefined && code >= 0x20 && code !== 0x7f;
}

export function createObservatoryOrb(
  view: Observatory,
  theme: Theme,
  done: (result: ObservatoryOrbResult) => void,
): Component & { dispose?(): void } {
  const count = featuredEntries(view).length;
  let index = 0;
  let finished = false;

  const finish = (result: ObservatoryOrbResult): void => {
    if (finished) return;
    finished = true;
    try {
      done(result);
    } catch (error) {
      reportRenderFailure("observatory-orb", error);
    }
  };

  const move = (delta: number): void => {
    if (count <= 0) return;
    index = (index + delta + count) % count;
  };

  return {
    render(width: number): string[] {
      try {
        return renderObservatory(
          view,
          (key, text) => theme.fg(key as any, text),
          width,
          { index, active: true },
        );
      } catch (error) {
        reportRenderFailure("observatory-orb", error);
        return [fallbackTruncateToWidth("[observatory unavailable]", width)];
      }
    },

    handleInput(data: string): void {
      try {
        if (finished) return;
        if (KEY_PREVIOUS.has(data)) return move(-1);
        if (KEY_NEXT.has(data)) return move(1);
        if (KEY_LAUNCH.has(data)) {
          const entry = featuredAt(view, index);
          finish(entry ? { action: "launch", entry } : { action: "dismiss" });
          return;
        }
        // Bare ESC only: a longer sequence is an arrow/function key, not a
        // dismissal.
        if (data === "\x1b") return finish({ action: "dismiss" });
        // The moment the user types, the orb steps aside and hands the
        // character on so the first keystroke is never lost.
        if (isPrintable(data)) return finish({ action: "passthrough", text: data });
      } catch (error) {
        reportRenderFailure("observatory-orb", error);
      }
    },

    invalidate(): void {},
  };
}
