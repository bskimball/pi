// peek-transcript: component-backed worker transcript for the peek overlay.
//
// Builds the same Pi components the main thread uses for a session
// (dist/modes/interactive/interactive-mode.js renderSessionItems /
// addMessageToChat): user prompts become UserMessageComponent, assistant
// messages (text + thinking) become AssistantMessageComponent, toolCall parts
// become ToolExecutionComponent, and toolResult entries resolve through
// updateResult on the pending component. Custom/compaction entries are
// skipped; only user/assistant/toolResult message entries participate.
//
// IO (bounded file reads) stays outside the render path: callers read on
// overlay open and on fleet-bus refresh, then append parsed entries here.
// Rendering caches per-component lines keyed by width + version.

import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createBuiltinToolRenderers } from "../presentation/builtin-tool-renderers.ts";
import { rememberedToolDefinition, resolveHeadlessToolRenderers } from "../presentation/headless-receipts.ts";

/** Initial read window: last 1 MiB of the worker session file. */
export const PEEK_INITIAL_BYTES = 1024 * 1024;
/** At most the last 200 message entries are kept as components. */
export const PEEK_MAX_ENTRIES = 200;
/** Hard ceiling on rendered body lines so memory/CPU stay bounded. */
export const PEEK_BODY_MAX_LINES = 5000;

export interface PeekTranscriptEnv {
  /** TUI handle for ToolExecutionComponent (image support is disabled). */
  tui: unknown;
  /** Working directory for tool rendering (parent cwd is the best available). */
  cwd: string;
  /** Initial expand-all state, mirrored from the lead's getToolsExpanded. */
  expandedAll: boolean;
  /** Initial thinking visibility (false = show thinking, the default). */
  hideThinking: boolean;
}

export interface PeekMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  // toolResult correlation + result payload (kept whole, like Pi).
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  details?: unknown;
  [key: string]: unknown;
}

export interface PeekFileEntry {
  type: string;
  message?: PeekMessage;
}

/** One parsed JSONL line that carries a session message, or undefined. */
function toFileEntry(value: unknown): PeekFileEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") return undefined;
  const entry: PeekFileEntry = { type: record.type };
  const raw = record.message;
  // JSON.parse yields plain data objects (no getters/proxies), so keeping the
  // whole message is safe and preserves toolResult correlation fields.
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const message = raw as PeekMessage;
    entry.message = message;
    if (typeof message.role !== "string" && message.role !== undefined) {
      entry.message = { ...message, role: undefined };
    }
  }
  return entry;
}

/**
 * Parse session-file text into file entries. `hasPartialTail` drops the last
 * line when the read did not end on a newline (a live worker may still be
 * appending to it). Unparseable lines are skipped.
 */
export function parsePeekText(text: string, hasPartialTail: boolean): PeekFileEntry[] {
  const rawLines = text.split("\n");
  const complete = hasPartialTail ? rawLines.slice(0, -1) : rawLines;
  const out: PeekFileEntry[] = [];
  for (const raw of complete) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const entry = toFileEntry(JSON.parse(line));
      if (entry) out.push(entry);
    } catch {
      continue;
    }
  }
  return out;
}

export interface PeekReadResult {
  entries: PeekFileEntry[];
  /** Byte offset to resume an incremental read from. */
  nextOffset: number;
  /** True when the file shrank (rotated/replaced): rebuild from scratch. */
  reset: boolean;
  /** True when the read window did not cover the whole file. */
  windowTrimmed: boolean;
}

function readBytes(path: string, start: number, end: number): string {
  let handle: number | undefined;
  try {
    const length = Math.max(0, end - start);
    if (length <= 0) return "";
    handle = openSync(path, "r");
    const buffer = Buffer.alloc(length);
    readSync(handle, buffer, 0, length, start);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // Best effort; a failed close must not break the overlay.
      }
    }
  }
}

/** Full initial read: last PEEK_INITIAL_BYTES, dropping the leading partial line. */
export function readPeekSnapshot(path: string): PeekReadResult {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0) {
      return { entries: [], nextOffset: stat.size, reset: false, windowTrimmed: false };
    }
    const size = stat.size;
    const start = Math.max(0, size - PEEK_INITIAL_BYTES);
    let text = readBytes(path, start, size);
    if (start > 0) {
      // Drop the leading partial line a windowed read starts mid-line on.
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    return {
      entries: parsePeekText(text, false),
      nextOffset: size,
      reset: false,
      windowTrimmed: start > 0,
    };
  } catch {
    return { entries: [], nextOffset: 0, reset: false, windowTrimmed: false };
  }
}

/** Incremental read: bytes appended since offset; reset when the file shrank. */
export function readPeekIncremental(path: string, offset: number): PeekReadResult {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { entries: [], nextOffset: offset, reset: false, windowTrimmed: false };
    if (stat.size < offset) {
      const snap = readPeekSnapshot(path);
      return { ...snap, reset: true };
    }
    if (stat.size === offset) {
      return { entries: [], nextOffset: offset, reset: false, windowTrimmed: false };
    }
    const text = readBytes(path, offset, stat.size);
    const complete = text.endsWith("\n");
    return {
      entries: parsePeekText(text, !complete),
      nextOffset: complete ? stat.size : offset + Buffer.byteLength(text),
      reset: false,
      windowTrimmed: false,
    };
  } catch {
    return { entries: [], nextOffset: offset, reset: false, windowTrimmed: false };
  }
}

// bash/write are kit re-registrations (see builtin-tools.ts), so no headless
// receipt covers them the way read/edit/grep/ls/find enjoy. Pass the same
// render-only kit renderers so peek matches the main thread. Other tools use
// the definition the main thread last rendered for that name (custom and MCP
// renderers included), then the process-wide kit wrap (receipts key on tool
// name), then Pi's fallback.
const renderOnlyDefs = new Map<string, any>();

function renderOnlyDefinition(name: string): any {
  if (name !== "bash" && name !== "write") return undefined;
  let def = renderOnlyDefs.get(name);
  if (!def) {
    def = { ...createBuiltinToolRenderers(name), renderShell: "self" as const };
    renderOnlyDefs.set(name, def);
  }
  return def;
}

/** Mirror Pi's getUserMessageText: string content or joined text parts. */
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  const count = Math.min(content.length, 64);
  for (let index = 0; index < count; index++) {
    const part = content[index] as Record<string, unknown> | null;
    if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("");
}

function toolCallParts(content: unknown): Array<{ id: string; name: string; args: unknown }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; args: unknown }> = [];
  const count = Math.min(content.length, 32);
  for (let index = 0; index < count; index++) {
    const part = content[index] as Record<string, unknown> | null;
    if (!part || typeof part !== "object" || part.type !== "toolCall") continue;
    const id = typeof part.id === "string" ? part.id : "";
    const name = typeof part.name === "string" ? part.name : "";
    if (!id || !name) continue;
    out.push({ id, name, args: part.arguments ?? {} });
  }
  return out;
}

interface PeekItem {
  entryIndex: number;
  component: Component;
  kind: "user" | "assistant" | "tool" | "assistant-tools";
  version: number;
  cacheKey?: string;
  cacheLines?: string[];
}

/**
 * Component transcript with Pi's session-rebuild correlation: toolCall parts
 * create pending ToolExecutionComponents, toolResult entries resolve them via
 * updateResult. Unmatched results (trimmed or pre-window calls) are ignored,
 * exactly like Pi's renderSessionItems.
 */
export class PeekTranscript {
  private readonly tui: unknown;
  private readonly cwd: string;
  private expandedAll: boolean;
  private hideThinking: boolean;
  private readonly markdownTheme = getMarkdownTheme();
  private items: PeekItem[] = [];
  private pending = new Map<string, PeekItem>();
  private entryIndex = 0;
  private firstEntryIndex = 0;
  private trimmed = false;

  constructor(env: PeekTranscriptEnv) {
    this.tui = env.tui;
    this.cwd = env.cwd;
    this.expandedAll = env.expandedAll;
    this.hideThinking = env.hideThinking;
  }

  get entryCount(): number {
    return this.entryIndex - this.firstEntryIndex;
  }

  get isTrimmed(): boolean {
    return this.trimmed;
  }

  /** Parse raw session-file text and append it (convenience for tests). */
  appendText(text: string, hasPartialTail: boolean): void {
    this.appendFileEntries(parsePeekText(text, hasPartialTail));
  }

  /** Drop all state (agent switch inside the overlay). */
  reset(): void {
    this.items = [];
    this.pending.clear();
    this.firstEntryIndex = this.entryIndex;
    this.trimmed = false;
  }

  setExpandedAll(expanded: boolean): void {
    if (this.expandedAll === expanded) return;
    this.expandedAll = expanded;
    for (const item of this.items) {
      if (item.kind === "tool") {
        try {
          (item.component as ToolExecutionComponent).setExpanded(expanded);
        } catch {
          continue;
        }
        item.version += 1;
      }
    }
  }

  setHideThinking(hide: boolean): void {
    if (this.hideThinking === hide) return;
    this.hideThinking = hide;
    for (const item of this.items) {
      if (item.kind === "assistant") {
        try {
          (item.component as AssistantMessageComponent).setHideThinkingBlock(hide);
        } catch {
          continue;
        }
        item.version += 1;
      }
    }
  }

  appendFileEntries(entries: readonly PeekFileEntry[]): void {
    for (const entry of entries) this.appendFileEntry(entry);
    this.enforceEntryBound();
  }

  private appendFileEntry(entry: PeekFileEntry): void {
    if (entry.type !== "message" || !entry.message) return;
    const message = entry.message;
    const role = message.role ?? "";
    if (role === "user") {
      const text = userText(message.content);
      if (!text) return;
      this.pushItem("user", () => new UserMessageComponent(text, this.markdownTheme, 1, []));
      this.entryIndex += 1;
      return;
    }
    if (role === "assistant") {
      const assistantMessage = message as unknown as Parameters<typeof AssistantMessageComponent.prototype.updateContent>[0];
      this.pushItem("assistant", () =>
        new AssistantMessageComponent(
          assistantMessage as never,
          this.hideThinking,
          this.markdownTheme,
          "Thinking...",
          1,
          [],
        ),
      );
      const created: PeekItem[] = [];
      for (const call of toolCallParts(message.content)) {
        const item = this.pushItem("tool", () => {
          const component = new ToolExecutionComponent(
            call.name,
            call.id,
            call.args,
            { showImages: false },
            resolveHeadlessToolRenderers(call.name, () =>
              (renderOnlyDefinition(call.name) ?? rememberedToolDefinition(call.name)) as import("@earendil-works/pi-coding-agent").ToolRenderers | undefined,
            ),
            this.tui as never,
            this.cwd,
          );
          component.setExpanded(this.expandedAll);
          return component;
        });
        if (item) {
          created.push(item);
          this.pending.set(call.id, item);
        }
      }
      // Mirror Pi: an aborted/errored assistant settles its own tools inline.
      if (message.stopReason === "aborted" || message.stopReason === "error") {
        const errorMessage =
          message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";
        for (const item of created) {
          try {
            (item.component as ToolExecutionComponent).updateResult({
              content: [{ type: "text", text: errorMessage }],
              isError: true,
            });
          } catch {
            // A failed inline result still clears the pending slot below.
          }
          item.version += 1;
          for (const [id, pending] of this.pending) {
            if (pending === item) this.pending.delete(id);
          }
        }
      }
      this.entryIndex += 1;
      return;
    }
    if (role === "toolResult") {
      const toolCallId = (message as Record<string, unknown>).toolCallId;
      if (typeof toolCallId !== "string") return;
      const item = this.pending.get(toolCallId);
      if (!item) return;
      try {
        (item.component as ToolExecutionComponent).updateResult(message as never);
      } catch {
        return;
      }
      item.version += 1;
      this.pending.delete(toolCallId);
      return;
    }
    // system / bashExecution / custom / compaction entries: not part of the
    // peek subset (Pi renders those through separate paths with session
    // services the overlay does not have).
  }

  private pushItem(kind: PeekItem["kind"], build: () => Component): PeekItem | undefined {
    try {
      const component = build();
      const item: PeekItem = { entryIndex: this.entryIndex, component, kind, version: 0 };
      this.items.push(item);
      return item;
    } catch {
      return undefined;
    }
  }

  /** Keep at most the last PEEK_MAX_ENTRIES message entries. */
  private enforceEntryBound(): void {
    const over = this.entryIndex - this.firstEntryIndex - PEEK_MAX_ENTRIES;
    if (over <= 0) return;
    this.trimmed = true;
    this.firstEntryIndex += over;
    const cutoff = this.firstEntryIndex;
    this.items = this.items.filter((item) => item.entryIndex >= cutoff);
    for (const [id, item] of this.pending) {
      if (item.entryIndex < cutoff) this.pending.delete(id);
    }
  }

  private renderItem(item: PeekItem, width: number): string[] {
    const key = `${width}:${item.version}`;
    if (item.cacheKey === key && item.cacheLines) return item.cacheLines;
    let lines: string[];
    try {
      const rendered = item.component.render(width);
      lines = Array.isArray(rendered) ? rendered.filter((line) => typeof line === "string") : [];
    } catch {
      lines = [];
    }
    item.cacheKey = key;
    item.cacheLines = lines;
    return lines;
  }

  /**
   * Render every component at width with a blank separator between message
   * entries, like Pi's Spacer(1) between chat children. Hard-capped at
   * PEEK_BODY_MAX_LINES (oldest dropped, reported as trimmed).
   */
  renderBody(width: number): { lines: string[]; trimmed: boolean } {
    const safeWidth = Math.max(1, Math.trunc(width) || 80);
    const lines: string[] = [];
    let lastEntry = -1;
    let first = true;
    for (const item of this.items) {
      if (!first && item.entryIndex !== lastEntry) lines.push("");
      first = false;
      lastEntry = item.entryIndex;
      lines.push(...this.renderItem(item, safeWidth));
    }
    if (lines.length > PEEK_BODY_MAX_LINES) {
      return { lines: lines.slice(lines.length - PEEK_BODY_MAX_LINES), trimmed: true };
    }
    return { lines, trimmed: this.trimmed };
  }

  /** Total rendered rows at width (cached render makes this cheap). */
  lineCount(width: number): number {
    return this.renderBody(width).lines.length;
  }
}
