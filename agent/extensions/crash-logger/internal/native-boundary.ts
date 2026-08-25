// Crash-surviving breadcrumbs around Pi's native-adjacent fullscreen paths.
//
// These hooks do not alter rendered content or chunk writes. They identify
// whether a native process death occurred inside layout/render, while queuing
// terminal output, or after the output callback drained. The observer feeds the
// bounded runtime event ring; writeLastPhase survives an immediate native abort.

import {
  ProcessTerminal,
  TuiAltScreen,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { writeLastPhase } from "./last-phase.ts";

const STATE_KEY = Symbol.for("pi.crashLogger.nativeBoundary");
const LARGE_WRITE_CHARS = 1_024;

interface NativeBoundaryState {
  installed: boolean;
  sequence: number;
  observe?: (event: string) => void;
  wrappedRenderers: WeakSet<object>;
}

const globalState = globalThis as typeof globalThis & {
  [STATE_KEY]?: NativeBoundaryState;
};

function state(): NativeBoundaryState {
  return (globalState[STATE_KEY] ??= {
    installed: false,
    sequence: 0,
    wrappedRenderers: new WeakSet<object>(),
  });
}

function boundary(event: string, persist = true): void {
  if (persist) writeLastPhase(event);
  try {
    state().observe?.(event);
  } catch {
    // Diagnostics must never affect the TUI path they observe.
  }
}

function wrapRenderer(
  Host: { prototype: object },
  kind: "fullscreen" | "main-screen",
): void {
  const current = state();
  const prototype = Host.prototype as { doRender?: () => void };
  if (current.wrappedRenderers.has(prototype)) return;
  const original = prototype.doRender;
  if (typeof original !== "function") return;

  prototype.doRender = function tracedRender(this: unknown): void {
    const id = ++state().sequence;
    boundary(`tui-render:enter kind=${kind} id=${id}`);
    try {
      original.call(this);
      boundary(`tui-render:return kind=${kind} id=${id}`);
    } catch (error) {
      boundary(`tui-render:throw kind=${kind} id=${id}`);
      throw error;
    }
  };
  current.wrappedRenderers.add(prototype);
}

function wrapTerminalWrite(): void {
  const current = state();
  if (current.installed) return;
  const prototype = ProcessTerminal.prototype as {
    write(data: string): void;
  };
  const original = prototype.write;

  prototype.write = function tracedTerminalWrite(
    this: ProcessTerminal,
    data: string,
  ): void {
    const text = typeof data === "string" ? data : String(data ?? "");
    if (text.length < LARGE_WRITE_CHARS) {
      original.call(this, text);
      return;
    }

    const id = ++state().sequence;
    const bytes = Buffer.byteLength(text, "utf8");
    boundary(`terminal-write:enter id=${id} chars=${text.length} bytes=${bytes}`);
    try {
      original.call(this, text);
      boundary(
        `terminal-write:return id=${id} chars=${text.length} bytes=${bytes}`,
      );
      // Stream callbacks are ordered. An empty marker does not change terminal
      // content, but its callback proves all prior queued bytes were accepted by
      // Node's stdout stream.
      process.stdout.write("", () => {
        boundary(
          `terminal-write:flushed id=${id} chars=${text.length} bytes=${bytes}`,
        );
      });
    } catch (error) {
      boundary(`terminal-write:throw id=${id} chars=${text.length} bytes=${bytes}`);
      throw error;
    }
  };
  current.installed = true;
}

/** Install once per process. Calling again only updates the event observer. */
export function installNativeBoundaryTelemetry(
  observe?: (event: string) => void,
): void {
  const current = state();
  current.observe = observe;
  wrapRenderer(TuiAltScreen, "fullscreen");
  wrapRenderer(TuiMainScreen, "main-screen");
  wrapTerminalWrite();
}
