// Defensive boundary around Pi TUI rendering.
//
// A malformed extension/model value must not be able to terminate the whole
// interactive process. Keep valid strings byte-for-byte intact (including ANSI
// and image protocol sequences), but coerce invalid line/text values and contain
// failures in the text renderers that consume model and extension payloads.

import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { writeLastPhase } from "../runtime/last-phase.ts";
import { installSegmenterSafety } from "../runtime/segmenter-safety.ts";
import { safeTruncateToWidth } from "./safe-text-layout.ts";
import { reportRenderFailure } from "./tool-receipt.ts";

// Native Intl.Segmenter can terminate Node on Windows while pi-tui breaks very
// long unbroken words. Keep native wrapping for ordinary text, but insert
// zero-width break opportunities before a run becomes large enough to enter
// that pathological segmenter path. U+200B is consumed as a break point by the
// TUI and does not change model-facing/session content.
export const SAFE_UNBROKEN_RUN_CHARS = 256;
/** Hard cap for Text/Markdown payloads. Ctrl+O expand-all must not dump
 * unbounded tool output into the compositor. */
export const SAFE_TEXT_MAX_CHARS = 16_384;
export const SAFE_RENDER_MAX_LINES = 240;
const BREAK_OPPORTUNITY = "\u200b";

const INSTALL_KEY = Symbol.for("pi.apex.renderSafety.installed");
const HOST_WRAP_KEY = Symbol.for("pi.apex.renderSafety.hostWrapped");
const HOST_DO_RENDER_KEY = Symbol.for("pi.apex.renderSafety.hostDoRenderWrapped");
const TOOL_RENDER_KEY = Symbol.for("pi.apex.renderSafety.toolRenderWrapped");
const HOST_PAINTERS_KEY = Symbol.for("pi.apex.renderSafety.hostPainters");
const PHASE_STATE_KEY = Symbol.for("pi.apex.renderSafety.phaseState");
const GUARDED_TEXT = Symbol.for("pi.apex.renderSafety.guardedText");
const RAW_TEXT = Symbol.for("pi.apex.renderSafety.rawText");
const state = globalThis as typeof globalThis & { [INSTALL_KEY]?: boolean };
const PHASE_LEN_THRESHOLD = 4096;
const PHASE_WRITE_INTERVAL_MS = 1000;

interface HostPainter {
  requestRender(force?: boolean): void;
}

interface PhaseState {
  lastPhase: string;
  lastPhaseAt: number;
}

function hostPainters(): Set<HostPainter> {
  const globalState = globalThis as typeof globalThis & {
    [HOST_PAINTERS_KEY]?: Set<HostPainter>;
  };
  return (globalState[HOST_PAINTERS_KEY] ??= new Set());
}

function phaseState(): PhaseState {
  const globalState = globalThis as typeof globalThis & {
    [PHASE_STATE_KEY]?: PhaseState;
  };
  return (globalState[PHASE_STATE_KEY] ??= { lastPhase: "", lastPhaseAt: 0 });
}

function notePhase(phase: string): void {
  const current = phaseState();
  const now = Date.now();
  if (now - current.lastPhaseAt < PHASE_WRITE_INTERVAL_MS) {
    const upgrade =
      current.lastPhase.startsWith("host-paint") &&
      (phase.startsWith("text-render") || phase.startsWith("guard-runs"));
    if (!upgrade) return;
  }
  current.lastPhase = phase;
  current.lastPhaseAt = now;
  writeLastPhase(phase);
}

function noteRenderPhase(kind: string, len: number): void {
  if (len < PHASE_LEN_THRESHOLD) return;
  notePhase(
    kind === "guard-runs"
      ? `guard-runs len=${len}`
      : `text-render kind=${kind} len=${len}`,
  );
}

function noteHostPhase(kind: string): void {
  const current = phaseState().lastPhase;
  if (
    current.startsWith("host-paint") ||
    current.startsWith("text-render") ||
    current.startsWith("guard-runs")
  ) {
    return;
  }
  notePhase(`host-paint kind=${kind}`);
}

// Module load: the compositor can measure lines as soon as this file is
// imported. The wrap is idempotent with crash-logger's install.
installSegmenterSafety();

function safeString(value: unknown, fallback = "[unrenderable]"): string {
  if (typeof value === "string") return value;
  try {
    return String(value ?? "");
  } catch {
    return fallback;
  }
}

/**
 * Components are required to return one string per terminal row. Preserve valid
 * rows exactly; only malformed values are coerced. Embedded newlines are split
 * so they cannot desynchronize fullscreen row accounting.
 */
export function normalizeRenderedLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    let clean = true;
    for (const item of value) {
      if (typeof item !== "string" || /[\r\n]/.test(item)) {
        clean = false;
        break;
      }
    }
    if (clean) return boundRenderedRows(value as string[]);
  }
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const lines: string[] = [];
  for (const item of values) {
    const text = safeString(item);
    if (typeof item === "string" && !/[\r\n]/.test(item)) {
      lines.push(item);
      continue;
    }
    lines.push(...text.replace(/\r\n?/g, "\n").split("\n"));
  }
  return boundRenderedRows(lines);
}

function boundRenderedRows(rows: string[]): string[] {
  const limited =
    rows.length <= SAFE_RENDER_MAX_LINES
      ? rows
      : [
          ...rows.slice(0, SAFE_RENDER_MAX_LINES),
          `... ${rows.length - SAFE_RENDER_MAX_LINES} more lines truncated for display`,
        ];
  let charTruncated = false;
  const out: string[] = [];
  for (const row of limited) {
    if (row.length <= SAFE_TEXT_MAX_CHARS) {
      out.push(row);
      continue;
    }
    charTruncated = true;
    const candidate =
      row.length > SAFE_TEXT_MAX_CHARS + 256
        ? row.slice(0, SAFE_TEXT_MAX_CHARS + 256)
        : row;
    out.push(safeTruncateToWidth(candidate, SAFE_TEXT_MAX_CHARS));
  }
  if (charTruncated) {
    const last = out.at(-1) ?? "";
    if (last.endsWith("more lines truncated for display")) {
      out[out.length - 1] = last.replace(
        /truncated for display$/,
        "and output truncated for display",
      );
    } else if (last !== "... output truncated for display") {
      if (out.length < SAFE_RENDER_MAX_LINES + 1) {
        out.push("... output truncated for display");
      } else {
        out[out.length - 1] = "... output truncated for display";
      }
    }
  }
  return out;
}

function boundDisplayText(value: unknown): string {
  const text = safeString(value);
  if (text.length <= SAFE_TEXT_MAX_CHARS) return text;
  return `${text.slice(0, SAFE_TEXT_MAX_CHARS)}\n... output truncated for display`;
}

interface TextLikePrototype {
  setText(value: string): void;
  render(width: number): string[];
}

interface TextLikeInstance {
  text?: unknown;
  [GUARDED_TEXT]?: string;
  [RAW_TEXT]?: string;
}

function isRunBoundary(codePoint: number): boolean {
  return (
    codePoint <= 0x20 ||
    codePoint === 0x7f ||
    codePoint === 0x200b ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x3000
  );
}

function terminalSequenceLength(text: string, index: number): number {
  if (text.charCodeAt(index) !== 0x1b) return 0;
  const match = text
    .slice(index)
    .match(
      /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[P^_][\s\S]*?\x1b\\)/,
    );
  return match?.[0].length ?? 1;
}

/** Add invisible break opportunities to pathological unbroken text runs. */
export function guardUnbrokenRuns(value: unknown): string {
  const text = safeString(value);
  noteRenderPhase("guard-runs", text.length);
  let result = "";
  let run = 0;
  let mutated = false;
  for (let index = 0; index < text.length; ) {
    const sequenceLength = terminalSequenceLength(text, index);
    if (sequenceLength > 0) {
      if (mutated) result += text.slice(index, index + sequenceLength);
      index += sequenceLength;
      continue;
    }
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (isRunBoundary(codePoint)) {
      run = 0;
    } else {
      if (run >= SAFE_UNBROKEN_RUN_CHARS) {
        if (!mutated) {
          result = text.slice(0, index);
          mutated = true;
        }
        result += BREAK_OPPORTUNITY;
        run = 0;
      }
      run++;
    }
    if (mutated) result += character;
    index += character.length;
  }
  return mutated ? result : text;
}

function applyGuardedText(instance: TextLikeInstance, value: unknown): boolean {
  if (typeof value === "string" && instance[GUARDED_TEXT] === value) return false;
  const raw = boundDisplayText(value);
  const guarded = guardUnbrokenRuns(raw);
  instance[RAW_TEXT] = raw;
  instance[GUARDED_TEXT] = guarded;
  if (instance.text !== guarded) instance.text = guarded;
  return true;
}

/** Register a live TUI that can be painted without remounting tool rows. */
export function attachHostPainter(painter: HostPainter): () => void {
  hostPainters().add(painter);
  return () => {
    hostPainters().delete(painter);
  };
}

/** Paint the live TUI without remounting transcript tool rows. */
export function requestHostRender(): boolean {
  installRenderSafety();
  const painters = hostPainters();
  if (painters.size === 0) return false;
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

/** Prefer a host frame; remount the tool row only when no TUI is attached. */
export function paintPinnedSurface(remount: () => void): boolean {
  if (requestHostRender()) return true;
  remount();
  return false;
}

function findOwnMethod(
  start: object,
  name: string,
): { target: object; method: (...args: never[]) => unknown } | undefined {
  let current: object | null = start;
  while (current && current !== Object.prototype) {
    const candidate = (current as Record<string, unknown>)[name];
    if (typeof candidate === "function") {
      return {
        target: current,
        method: candidate as (...args: never[]) => unknown,
      };
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
  const foundRender = findOwnMethod(proto, "requestRender");
  const foundStop = findOwnMethod(proto, "stop");
  if (!foundRender) return;
  const originalRender = foundRender.method as HostPainter["requestRender"];
  proto.requestRender = function requestTrackedRender(
    this: HostPainter,
    force?: boolean,
  ): void {
    attachHostPainter(this);
    originalRender.call(this, force);
  };
  if (foundStop) {
    const originalStop = foundStop.method as (...args: unknown[]) => unknown;
    proto.stop = function stopTracked(this: HostPainter, ...args: unknown[]) {
      hostPainters().delete(this);
      return originalStop.apply(this, args);
    };
  }
  proto[HOST_WRAP_KEY] = true;
}

function wrapHostDoRender(Host: { prototype: object }): void {
  const proto = Host.prototype as {
    doRender?: () => void;
    [HOST_DO_RENDER_KEY]?: boolean;
  };
  if (proto[HOST_DO_RENDER_KEY]) return;
  const found = findOwnMethod(proto, "doRender");
  if (!found) return;
  const original = found.method as () => void;
  proto.doRender = function renderWithPhase(this: unknown): void {
    // Start-only: a native abort inside the compositor must not look stuck on
    // the last task_start/task_close breadcrumb. Do not write an exit phase;
    // that would erase a more specific text-render/guard-runs line.
    noteHostPhase("doRender");
    original.call(this);
  };
  proto[HOST_DO_RENDER_KEY] = true;
}

function wrapToolExecutionRender(): void {
  const proto = ToolExecutionComponent.prototype as unknown as {
    render?: (width: number) => unknown;
    [key: symbol]: boolean | undefined;
  };
  if (proto[TOOL_RENDER_KEY]) return;
  const found = findOwnMethod(proto, "render");
  if (!found) return;
  const original = found.method as (this: unknown, width: number) => unknown;
  (found.target as { render: (width: number) => string[] }).render =
    function renderSafeTool(this: unknown, width: number): string[] {
      try {
        return normalizeRenderedLines(original.call(this, width));
      } catch (error) {
        reportRenderFailure("tool-execution", error);
        return ["[tool output unavailable]"];
      }
    };
  proto[TOOL_RENDER_KEY] = true;
}

function installTextBoundary(): void {
  const prototype = Text.prototype as unknown as TextLikePrototype;
  const originalSetText = prototype.setText;
  const originalRender = prototype.render;

  prototype.setText = function setSafeText(value: string): void {
    const instance = this as unknown as TextLikeInstance;
    const raw = boundDisplayText(value);
    if (
      instance.text === instance[GUARDED_TEXT] &&
      (raw === instance[RAW_TEXT] || raw === instance[GUARDED_TEXT])
    ) {
      return;
    }
    const guarded = guardUnbrokenRuns(raw);
    instance[RAW_TEXT] = raw;
    instance[GUARDED_TEXT] = guarded;
    originalSetText.call(this, guarded);
  };
  prototype.render = function renderSafeText(width: number): string[] {
    try {
      const instance = this as unknown as TextLikeInstance;
      const scanned = applyGuardedText(instance, instance.text);
      if (scanned) noteRenderPhase("text", safeString(instance.text).length);
      return normalizeRenderedLines(originalRender.call(this, width));
    } catch (error) {
      reportRenderFailure("text", error);
      return ["[text unavailable]"];
    }
  };
}

function installMarkdownBoundary(): void {
  const prototype = Markdown.prototype as unknown as TextLikePrototype;
  const originalSetText = prototype.setText;
  const originalRender = prototype.render;

  prototype.setText = function setSafeMarkdown(value: string): void {
    const instance = this as unknown as TextLikeInstance;
    const raw = boundDisplayText(value);
    if (
      instance.text === instance[GUARDED_TEXT] &&
      (raw === instance[RAW_TEXT] || raw === instance[GUARDED_TEXT])
    ) {
      return;
    }
    const guarded = guardUnbrokenRuns(raw);
    instance[RAW_TEXT] = raw;
    instance[GUARDED_TEXT] = guarded;
    originalSetText.call(this, guarded);
  };
  prototype.render = function renderSafeMarkdown(width: number): string[] {
    try {
      const instance = this as unknown as TextLikeInstance;
      const scanned = applyGuardedText(instance, instance.text);
      if (scanned) noteRenderPhase("markdown", safeString(instance.text).length);
      return normalizeRenderedLines(originalRender.call(this, width));
    } catch (error) {
      reportRenderFailure("markdown", error);
      return ["[markdown unavailable]"];
    }
  };
}

/** Install once per Pi process, even when extensions are reloaded. */
export function installRenderSafety(): void {
  installSegmenterSafety();
  wrapHostPainter(TuiAltScreen);
  wrapHostPainter(TuiMainScreen);
  wrapHostDoRender(TuiAltScreen);
  wrapHostDoRender(TuiMainScreen);
  wrapToolExecutionRender();
  if (state[INSTALL_KEY]) return;
  installTextBoundary();
  installMarkdownBoundary();
  state[INSTALL_KEY] = true;
}
