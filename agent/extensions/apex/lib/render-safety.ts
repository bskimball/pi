// Defensive boundary around Pi TUI rendering.
//
// A malformed extension/model value must not be able to terminate the whole
// interactive process. Keep valid strings byte-for-byte intact (including ANSI
// and image protocol sequences), but coerce invalid line/text values and isolate
// individual component failures.

import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { reportRenderFailure } from "./tool-receipt.ts";

const INSTALL_KEY = Symbol.for("pi.apex.renderSafety.installed");
const state = globalThis as typeof globalThis & { [INSTALL_KEY]?: boolean };

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

interface ChildOwner {
  children?: unknown;
}

function safeChildLines(owner: ChildOwner, width: number): string[] {
  const children = Array.isArray(owner.children) ? owner.children : [];
  const lines: string[] = [];
  for (const child of children) {
    try {
      const component = child as { render?: (renderWidth: number) => unknown };
      if (typeof component?.render !== "function") {
        throw new TypeError("Container child has no render(width) method");
      }
      lines.push(...normalizeRenderedLines(component.render(width)));
    } catch (error) {
      reportRenderFailure("component", error);
      lines.push("[display unavailable]");
    }
  }
  return lines;
}

function installContainerBoundary(): void {
  const prototype = Container.prototype as unknown as {
    render(width: number): string[];
  };
  prototype.render = function renderSafely(width: number): string[] {
    return safeChildLines(this as unknown as ChildOwner, width);
  };
}

interface TextLikePrototype {
  setText(value: string): void;
  render(width: number): string[];
}

interface TextLikeInstance {
  text?: unknown;
}

function installTextBoundary(): void {
  const prototype = Text.prototype as unknown as TextLikePrototype;
  const originalSetText = prototype.setText;
  const originalRender = prototype.render;

  prototype.setText = function setSafeText(value: string): void {
    originalSetText.call(this, safeString(value));
  };
  prototype.render = function renderSafeText(width: number): string[] {
    try {
      const instance = this as unknown as TextLikeInstance;
      if (typeof instance.text !== "string")
        instance.text = safeString(instance.text);
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
    originalSetText.call(this, safeString(value));
  };
  prototype.render = function renderSafeMarkdown(width: number): string[] {
    try {
      const instance = this as unknown as TextLikeInstance;
      if (typeof instance.text !== "string")
        instance.text = safeString(instance.text);
      return normalizeRenderedLines(originalRender.call(this, width));
    } catch (error) {
      reportRenderFailure("markdown", error);
      return ["[markdown unavailable]"];
    }
  };
}

/** Install once per Pi process, even when extensions are reloaded. */
export function installRenderSafety(): void {
  if (state[INSTALL_KEY]) return;
  installTextBoundary();
  installMarkdownBoundary();
  installContainerBoundary();
  state[INSTALL_KEY] = true;
}
