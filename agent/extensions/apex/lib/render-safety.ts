// Defensive boundary around Pi TUI rendering.
//
// A malformed extension/model value must not be able to terminate the whole
// interactive process. Keep valid strings byte-for-byte intact (including ANSI
// and image protocol sequences), but coerce invalid line/text values and contain
// failures in the text renderers that consume model and extension payloads.

import { Markdown, Text } from "@earendil-works/pi-tui";
import { installSegmenterSafety } from "../../lib/segmenter-safety.ts";
import { reportRenderFailure } from "./tool-receipt.ts";

// Native Intl.Segmenter can terminate Node on Windows while pi-tui breaks very
// long unbroken words. Keep native wrapping for ordinary text, but insert
// zero-width break opportunities before a run becomes large enough to enter
// that pathological segmenter path. U+200B is consumed as a break point by the
// TUI and does not change model-facing/session content.
export const SAFE_UNBROKEN_RUN_CHARS = 256;
const BREAK_OPPORTUNITY = "\u200b";

const INSTALL_KEY = Symbol.for("pi.apex.renderSafety.installed");
const state = globalThis as typeof globalThis & { [INSTALL_KEY]?: boolean };

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
  return lines;
}

interface TextLikePrototype {
  setText(value: string): void;
  render(width: number): string[];
}

interface TextLikeInstance {
  text?: unknown;
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
  let result = "";
  let run = 0;
  for (let index = 0; index < text.length; ) {
    const sequenceLength = terminalSequenceLength(text, index);
    if (sequenceLength > 0) {
      result += text.slice(index, index + sequenceLength);
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
        result += BREAK_OPPORTUNITY;
        run = 0;
      }
      run++;
    }
    result += character;
    index += character.length;
  }
  return result;
}

function installTextBoundary(): void {
  const prototype = Text.prototype as unknown as TextLikePrototype;
  const originalSetText = prototype.setText;
  const originalRender = prototype.render;

  prototype.setText = function setSafeText(value: string): void {
    originalSetText.call(this, guardUnbrokenRuns(value));
  };
  prototype.render = function renderSafeText(width: number): string[] {
    try {
      const instance = this as unknown as TextLikeInstance;
      instance.text = guardUnbrokenRuns(instance.text);
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
    originalSetText.call(this, guardUnbrokenRuns(value));
  };
  prototype.render = function renderSafeMarkdown(width: number): string[] {
    try {
      const instance = this as unknown as TextLikeInstance;
      instance.text = guardUnbrokenRuns(instance.text);
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
  if (state[INSTALL_KEY]) return;
  installTextBoundary();
  installMarkdownBoundary();
  state[INSTALL_KEY] = true;
}
