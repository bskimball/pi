// Task-owned host repaint coalescing.
//
// Live worker cards should repaint the mounted TUI instead of remounting their
// historical transcript row for every lifecycle event. This helper is
// intentionally local to Task so the extension remains independently
// removable and has no cross-extension source imports.

import { TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";

const HOST_WRAP_KEY = Symbol.for("pi.task.renderSafety.hostWrapped");
const HOST_PAINTERS_KEY = Symbol.for("pi.task.renderSafety.hostPainters");

interface HostPainter {
  requestRender(force?: boolean): void;
}

function hostPainters(): Set<HostPainter> {
  const state = globalThis as typeof globalThis & {
    [HOST_PAINTERS_KEY]?: Set<HostPainter>;
  };
  return (state[HOST_PAINTERS_KEY] ??= new Set());
}

function findOwnMethod(
  start: object,
  name: string,
): { method: (...args: never[]) => unknown } | undefined {
  let current: object | null = start;
  while (current && current !== Object.prototype) {
    const candidate = (current as Record<string, unknown>)[name];
    if (typeof candidate === "function") {
      return { method: candidate as (...args: never[]) => unknown };
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function wrapHostPainter(Host: { prototype: object }): void {
  const proto = Host.prototype as HostPainter & {
    [HOST_WRAP_KEY]?: boolean;
    stop?: (...args: unknown[]) => unknown;
  };
  if (proto[HOST_WRAP_KEY]) return;
  const render = findOwnMethod(proto, "requestRender");
  if (!render) return;
  const stop = findOwnMethod(proto, "stop");
  const originalRender = render.method as HostPainter["requestRender"];
  proto.requestRender = function requestTrackedRender(
    this: HostPainter,
    force?: boolean,
  ): void {
    attachTaskHostPainter(this);
    originalRender.call(this, force);
  };
  if (stop) {
    const originalStop = stop.method as (...args: unknown[]) => unknown;
    proto.stop = function stopTracked(this: HostPainter, ...args: unknown[]) {
      hostPainters().delete(this);
      return originalStop.apply(this, args);
    };
  }
  proto[HOST_WRAP_KEY] = true;
}

/** Register a mounted Task host painter. */
export function attachTaskHostPainter(painter: HostPainter): () => void {
  hostPainters().add(painter);
  return () => hostPainters().delete(painter);
}

export function installTaskRenderSafety(): void {
  wrapHostPainter(TuiAltScreen);
  wrapHostPainter(TuiMainScreen);
}

export function requestTaskHostRender(): boolean {
  installTaskRenderSafety();
  const painters = hostPainters();
  let painted = false;
  for (const painter of painters) {
    try {
      painter.requestRender();
      painted = true;
    } catch {
      painters.delete(painter);
    }
  }
  return painted;
}

/** Prefer a coalesced host frame; remount only when no live TUI is attached. */
export function paintTaskPinnedSurface(remount: () => void): boolean {
  if (requestTaskHostRender()) return true;
  remount();
  return false;
}
