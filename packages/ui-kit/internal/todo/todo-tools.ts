// todo-tools: registration, validation, and session state for `todo_write` /
// `todo_read`, plus the docked todos/agents panel above the editor.
//
// Presentation is pure and lives in ./todo-view.ts. Everything here is
// registration and state: no render timers, no pi-tui Text/Markdown/Container.
// Todo panel controls are always registered: the SDK offers no unregister,
// so install-time gating would leave a live off->on switch without commands
// and a live on->off switch with handlers still executing. The handlers
// below gate on the live presentation flag instead. Tool registration and
// execution are unconditional; receipts and widget chrome follow the
// presentation gate, and tool renderers are re-registered on live switches
// because renderer slots snapshot at registration time.

import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  Component,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  CANONICAL_STATUSES,
  agentRowAtY,
  buildTodoList,
  canSwitchToSession,
  clampPeekScroll,
  layoutPeekTranscript,
  peekTranscriptBudget,
  renderAgentList,
  renderPeekBody,
  renderPlainTodoList,
  renderTodoList,
  type DockPane,
  type TodoItem,
  type TodoListView,
  type TodoStatus,
} from "./todo-view.ts";
import {
  currentDockAgents,
  setAgentWorkspaceOpen,
  subscribeDockAgents,
  type DockAgentItem,
} from "./fleet-listen.ts";
import {
  apexPresentationEnabled,
  withApexPresentation,
} from "../presentation/presentation.ts";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { renderLinesSafely, padStartToWidth, safeTruncateToWidth } from "../presentation/safe-text-layout.ts";
import {
  DURATION_COLUMN,
  TREE,
  WidthText,
  cleanInline,
  fitLine,
  formatDuration,
  textContent,
  type ToolRenderContext,
} from "../presentation/ui-common.ts";
import { requestHostRender } from "../presentation/render-safety.ts";
import { skinGlyphs } from "../presentation/skin.ts";
import { writeLastPhase } from "../runtime/last-phase.ts";
import { safeLine, type StatusTheme } from "../presentation/receipt-tree.ts";

// ---------------------------------------------------------------- types

interface TodoWriteParams {
  todos: Array<{
    content: string;
    status: string;
    id?: string;
    note?: string;
  }>;
}

interface TodoDetails {
  /** Built view for the Apex receipt. Absent on validation errors. */
  view?: TodoListView;
  /** Short failure text for fallback receipts. */
  message?: string;
}

// ---------------------------------------------------------------- helpers

function textResult(text: string, isError = false, details: TodoDetails = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError,
  };
}

function todoPayload(result: unknown): TodoDetails | undefined {
  const details =
    result && typeof result === "object"
      ? (result as { details?: unknown }).details
      : undefined;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  return details as TodoDetails;
}

function summarize(view: TodoListView): string {
  const active =
    view.activeIndex >= 0 ? safeLine(view.items[view.activeIndex]?.title, 80) : "";
  const base = `${view.done}/${view.total} done`;
  return active ? `${base} \u00b7 ${active}` : base;
}

/** Cap on items serialized into the model-visible todo_read result. */
const READ_ITEM_CAP = 50;
/** Cap on each serialized item line (status + content + optional note). */
const READ_LINE_CHARS = 240;
/** Max open items enumerated in the Fusion close nudge; the rest fold into "+M more". */
const FUSION_CLOSE_NUDGE_IDS = 8;

/**
 * Mechanical close backstop for Fusion mode (see the tool_result hook at the
 * end of installTodoTools): single ASCII line naming the open items.
 * State ids/statuses are single-line and bounded on every intake path, so
 * the line cannot leak newlines into the result.
 */
function fusionCloseNudge(toolName: string, open: TodoItem[]): string {
  const shown = open.slice(0, FUSION_CLOSE_NUDGE_IDS).map(item => `#${item.id} ${item.status}`);
  const hidden = open.length - shown.length;
  const tail = hidden > 0 ? ` +${hidden} more` : "";
  return `[fusion] ${toolName} returned with ${open.length} todo items still open: ${shown.join(", ")}${tail} - resolve each (completed with evidence, or blocked/pending with reason) before the final answer.`;
}

/**
 * Bounded plain-text dump of the retained list for todo_read. The model needs
 * exact item content to refer to entries by text; summarize() alone is not enough.
 */
function serializeForRead(view: TodoListView): string {
  const lines: string[] = [summarize(view)];
  const limit = Math.min(view.items.length, READ_ITEM_CAP);
  for (let i = 0; i < limit; i++) {
    const item = view.items[i];
    const note = item.note ? ` \u00b7 ${item.note}` : "";
    lines.push(safeLine(`[${item.status}] ${item.title}${note}`, READ_LINE_CHARS));
  }
  const omitted = view.items.length - limit;
  if (omitted > 0) lines.push(`\u2026 ${omitted} more items`);
  return lines.join("\n");
}

type TodoKind = "queued" | "running" | "succeeded" | "failed";
type TodoRenderState = {
  hasResult?: boolean;
  startedAt?: number;
  endedAt?: number;
};

function markTodoStarted(context: {
  executionStarted: boolean;
  state: TodoRenderState;
}): void {
  if (context.executionStarted && context.state.startedAt === undefined) {
    context.state.startedAt = Date.now();
  }
}

function markTodoEnded(context: { state: TodoRenderState }): void {
  context.state.endedAt ??= Date.now();
}

function writeItemCount(args: unknown): string | undefined {
  const raw =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : undefined;
  const todos = Array.isArray(raw?.todos) ? raw.todos : [];
  return todos.length
    ? `${todos.length} item${todos.length === 1 ? "" : "s"}`
    : undefined;
}

/**
 * Same header shape as the generic Apex tool receipt:
 *   ● todo_read
 *   ● todo_read  1/3 done · Align the receipt
 */
function todoReceiptLine(
  theme: StatusTheme,
  width: number,
  options: {
    tool: "todo_write" | "todo_read";
    kind: TodoKind;
    subject?: string;
    startedAt?: number;
    endedAt?: number;
  },
): string {
  const glyph =
    options.kind === "running"
      ? theme.fg("warning", skinGlyphs().statusActive)
      : options.kind === "queued"
        ? theme.fg("dim", skinGlyphs().statusIdle)
        : options.kind === "failed"
          ? theme.fg("error", skinGlyphs().statusActive)
          : theme.fg("success", skinGlyphs().statusActive);
  const lead = `${glyph} ${theme.fg("toolTitle", options.tool)}`;
  const subject = safeLine(options.subject, 120);
  const left = subject ? `${lead} ${theme.fg("muted", subject)}` : lead;
  if (options.startedAt === undefined) return safeTruncateToWidth(left, width);
  const elapsedMs = (options.endedAt ?? Date.now()) - options.startedAt;
  const elapsed = theme.fg(
    "dim",
    padStartToWidth(formatDuration(elapsedMs), DURATION_COLUMN),
  );
  return fitLine(left, elapsed, width);
}

function todoFallbackLines(
  theme: StatusTheme,
  width: number,
  tool: "todo_write" | "todo_read",
  text: unknown,
  isError: boolean,
  timing: { startedAt?: number; endedAt?: number } = {},
): string[] {
  const message = safeLine(text, 300) || (isError ? `${tool} failed` : tool);
  return [
    todoReceiptLine(theme, width, {
      tool,
      kind: isError ? "failed" : "succeeded",
      subject: message,
      startedAt: timing.startedAt,
      endedAt: timing.endedAt,
    }),
  ];
}

function todoEmptyReadLines(
  theme: StatusTheme,
  width: number,
  timing: { startedAt?: number; endedAt?: number } = {},
): string[] {
  return [
    todoReceiptLine(theme, width, {
      tool: "todo_read",
      kind: "succeeded",
      subject: "no todos yet",
      startedAt: timing.startedAt,
      endedAt: timing.endedAt,
    }),
    safeTruncateToWidth(
      `${theme.fg("dim", TREE.last)} ${theme.fg("dim", "todo_write to start a plan")}`,
      width,
    ),
  ];
}

// ---------------------------------------------------------------- lifecycle

/**
 * Reconstruct the active plan from the current session branch.
 * Scans tool results and matching tool calls in branch order, recovering the
 * latest valid plan on session resume/reload or branch switches.
 */
export function reconstructTodoState(
  ctx: ExtensionContext,
): TodoListView | undefined {
  if (!ctx?.sessionManager?.getBranch) return undefined;
  let lastValidView: TodoListView | undefined;
  try {
    const branch = ctx.sessionManager.getBranch();
    const callArgs = new Map<string, unknown[]>();
    for (const entry of branch) {
      if (entry?.type !== "message" || !entry.message) continue;
      const msg = entry.message as any;
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (
            part?.type === "toolCall" &&
            part.name === "todo_write" &&
            part.id &&
            part.arguments?.todos &&
            Array.isArray(part.arguments.todos)
          ) {
            callArgs.set(part.id, part.arguments.todos);
          }
        }
      } else if (
        msg.role === "toolResult" &&
        msg.toolName === "todo_write" &&
        !msg.isError
      ) {
        const details = msg.details as any;
        if (details?.view?.items && Array.isArray(details.view.items)) {
          lastValidView = buildTodoList(details.view.items, {
            title: details.view.title,
          });
        } else if (Array.isArray(details?.todos)) {
          lastValidView = buildTodoList(details.todos);
        } else if (msg.toolCallId && callArgs.has(msg.toolCallId)) {
          lastValidView = buildTodoList(callArgs.get(msg.toolCallId));
        }
      }
    }
  } catch {
    // Fail soft if the session manager cannot read the branch.
  }
  return lastValidView;
}

/**
 * Dock panel: the WidthText render path plus row click handling for the
 * agents pane. Clicks map box-local y to a rendered agent row (header at
 * row 0, one row per worker after it); only agent rows claim the click.
 * Keyboard selection lives on the shortcuts/commands below; this class
 * only routes pointer input into the same row callback.
 */
class DockPanel implements Component {
  constructor(
    private readonly build: (width: number) => string[],
    private readonly hooks: {
      fallback: string;
      onAgentRow: (rowIndex: number) => void;
      rowCount: () => number;
    },
  ) {}
  render(width: number): string[] {
    return renderLinesSafely(this.build, width, this.hooks.fallback);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return dockClickResult(event, this.hooks);
  }
  invalidate(): void {}
}

/**
 * Pure click-result contract for the dock panel, extracted so tests bind
 * the exact object without instantiating the module-local class. Agent-row
 * clicks are claimed without requesting focus or mouse capture.
 */
export function dockClickResult(
  event: Pick<TuiMouseEvent, "type" | "button" | "y">,
  hooks: {
    onAgentRow: (rowIndex: number) => void;
    rowCount: () => number;
  },
): TuiMouseEventResult | undefined {
  if (event.type !== "click" || event.button !== "left") return undefined;
  const rowIndex = agentRowAtY(Math.trunc(event.y), hooks.rowCount());
  if (rowIndex === undefined) return undefined;
  try {
    hooks.onAgentRow(rowIndex);
  } catch {
    // A dock failure must not interrupt the TUI input path.
  }
  return { handled: true, focus: false, capture: false };
}

// ---------------------------------------------------------------- install

export function installTodoTools(pi: ExtensionAPI): void {
  /** Current plan for this process/session. Each successful write replaces it. */
  let current: TodoListView | undefined;
  let currentCtx: ExtensionContext | undefined;
  let panelCollapsed = false;
  let dockPane: DockPane = "todos";
  let liveAgents: DockAgentItem[] = currentDockAgents();
  /** Selected agents-pane row; clamped on every fleet update. */
  let selectedAgent = 0;
  let dockMounted = false;
  let unsubscribeFleet = () => {};
  let removeDockInput: (() => void) | undefined;
  let uiPromptDepth = 0;
  const PANEL_KEY = "todo-list";
  const TOGGLE_HINT = "alt+t";
  const SWITCH_HINT = "alt+a";
  let presentationEnabled = apexPresentationEnabled();

  function clearPanel(): void {
    const ctx = currentCtx;
    const wasMounted = dockMounted;
    dockMounted = false;
    removeDockInput?.();
    removeDockInput = undefined;
    if (wasMounted) writeLastPhase("todo-dock:unmount");
    if (!ctx?.hasUI || ctx.mode !== "tui") return;
    try {
      ctx.ui.setWidget(PANEL_KEY, undefined);
    } catch {
      // UI teardown must not interrupt a session transition.
    }
  }

  function dockHasSurface(): boolean {
    return Boolean(current) || (presentationEnabled && liveAgents.length > 0);
  }

  function dockTabs() {
    if (!liveAgents.length) return undefined;
    return {
      pane: dockPane,
      agentCount: liveAgents.length,
      switchHint: presentationEnabled ? SWITCH_HINT : undefined,
    };
  }

  /** Clamp the selection after the fleet changes; open rows stay valid. */
  function clampSelection(): void {
    if (selectedAgent >= liveAgents.length) selectedAgent = Math.max(0, liveAgents.length - 1);
    if (selectedAgent < 0) selectedAgent = 0;
  }

  /**
   * Move the agents-pane selection and repaint the live host. No remount:
   * the DockPanel factory closes over this state, so a state change plus
   * requestHostRender is the whole update path.
   */
  function moveSelection(delta: number): void {
    if (!liveAgents.length) return;
    clampSelection();
    const next = Math.max(0, Math.min(liveAgents.length - 1, selectedAgent + delta));
    if (next === selectedAgent) return;
    selectedAgent = next;
    if (currentCtx) renderPanel();
  }

  /**
   * Dock keyboard input. Active while the agents pane is visible:
   * up/down move the row selection, Enter peeks the selected worker,
   * Esc returns to todos. Wired through onTerminalInput (raw data) with
   * the shared tui.select keybindings plus literal-sequence fallback.
   */
  function dockInputHandler(data: string): { consume?: boolean } | undefined {
    if (!presentationEnabled || !currentCtx?.hasUI || currentCtx.mode !== "tui") return undefined;
    // ui.custom owns keyboard input while its overlay is focused. The editor
    // owns navigation and submit as soon as the user has composed any text,
    // including a prepared `/agents open` command. Fusion's Escape abort is
    // gated on the shared workspace-open flag, not consume, so overlay Esc
    // still reaches handleInput and closes the view.
    if (peekOpen || uiPromptDepth > 0) return undefined;
    if (!dockMounted || dockPane !== "agents" || panelCollapsed || !liveAgents.length) return undefined;
    try {
      if (currentCtx.ui.getEditorText().length > 0) return undefined;
    } catch {
      // If editor state is unavailable, keep the bounded dock shortcuts.
    }
    if (data === "\u001b") {
      switchPane(currentCtx, "todos");
      return { consume: true };
    }
    const up = data === "\u001b[A" || data === "\u001b[D";
    const down = data === "\u001b[B" || data === "\u001b[C" || data === "\t";
    if (up || down) {
      moveSelection(up ? -1 : 1);
      return { consume: true };
    }
    if (data === "\r" || data === "\n") {
      const host = currentCtx;
      if (host) void peekSelected(host);
      return { consume: true };
    }
    return undefined;
  }

  /**
   * Read one property from a hostile value. Getters, proxy traps, and
   * revoked proxies all throw on plain member access, so every read here
   * is guarded; the peer helper in todo-view.ts stays presentation-side.
   */
  function readProp(source: unknown, key: string): unknown {
    if (source === null || (typeof source !== "object" && typeof source !== "function")) {
      return undefined;
    }
    try {
      return (source as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  }

  /** Number of entries in a hostile array value, capped. */
  function boundedLength(value: unknown, cap: number): number {
    if (!Array.isArray(value)) return 0;
    try {
      const length = value.length;
      if (typeof length !== "number" || !Number.isFinite(length)) return 0;
      return Math.max(0, Math.min(cap, Math.trunc(length)));
    } catch {
      return 0;
    }
  }

  /** Bounded tail read of a worker session file for the session view. */
  const TRANSCRIPT_TAIL_BYTES = 32 * 1024;
  const TRANSCRIPT_TAIL_LINES = 160;

  /**
   * Minimal transcript line formatter: role + text, tool calls as names.
   * The kit cannot import task-side extractAssistantText (no
   * cross-extension imports), so this hand-rolls the same shape from the
   * parsed JSONL entries with kit text helpers only.
   */
  function formatTranscriptTail(text: string): string[] {
    const rawLines = text.split("\n");
    // Skip the trailing partial line a live worker may still be writing.
    const complete = text.endsWith("\n") ? rawLines : rawLines.slice(0, -1);
    const out: string[] = [];
    for (const raw of complete) {
      const line = raw.trim();
      if (!line) continue;
      let entry: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          entry = parsed as Record<string, unknown>;
        }
      } catch {
        continue;
      }
      if (!entry) continue;
      const formatted = formatTranscriptEntry(entry);
      if (formatted) out.push(formatted);
    }
    return out.slice(-TRANSCRIPT_TAIL_LINES);
  }

  function formatTranscriptEntry(entry: Record<string, unknown>): string | undefined {
    let message: Record<string, unknown> | undefined;
    try {
      const raw = entry.message;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        message = raw as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
    if (!message) return undefined;
    const role = (() => {
      try {
        return String(message.role ?? "");
      } catch {
        return "";
      }
    })();
    if (role === "toolResult") {
      const name = cleanInline((() => {
        try {
          return message.toolName ?? "";
        } catch {
          return "";
        }
      })(), 40);
      return name ? `tool ${name}` : undefined;
    }
    const content = (() => {
      try {
        return message.content;
      } catch {
        return undefined;
      }
    })();
    if (typeof content === "string") {
      return transcriptLine(role, cleanInline(content, 120));
    }
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    const count = boundedLength(content, 8);
    for (let index = 0; index < count; index++) {
      let part: Record<string, unknown> | undefined;
      try {
        const raw = (content as unknown[])[index];
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          part = raw as Record<string, unknown>;
        }
      } catch {
        continue;
      }
      if (!part) continue;
      let kind = "";
      try {
        kind = String(part.type ?? "");
      } catch {
        continue;
      }
      if (kind === "text") {
        const text = cleanInline((() => {
          try {
            return part.text ?? "";
          } catch {
            return "";
          }
        })(), 120);
        if (text) parts.push(text);
      } else if (kind === "toolCall") {
        const name = cleanInline((() => {
          try {
            return part.name ?? "";
          } catch {
            return "";
          }
        })(), 40);
        if (name) parts.push(`tool ${name}`);
      }
      if (parts.length >= 2) break;
    }
    if (!parts.length) return undefined;
    return transcriptLine(role, parts.join(" · "));
  }

  function transcriptLine(role: string, text: string): string | undefined {
    if (!text) return undefined;
    const speaker = role === "assistant" ? "worker" : role === "user" ? "lead" : role || "msg";
    return `${cleanInline(speaker, 12)}: ${cleanInline(text, 120)}`;
  }

  function readTranscriptTail(path: string): string[] {
    let handle: number | undefined;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return [];
      const size = Math.max(0, Math.min(stat.size, TRANSCRIPT_TAIL_BYTES));
      if (size <= 0) return [];
      handle = openSync(path, "r");
      const buffer = Buffer.alloc(size);
      readSync(handle, buffer, 0, size, Math.max(0, stat.size - size));
      return formatTranscriptTail(buffer.toString("utf8"));
    } catch {
      return [];
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
  function peekTranscript(item: DockAgentItem): string[] {
    try {
      const path = typeof readProp(item, "sessionFile") === "string"
        ? (readProp(item, "sessionFile") as string)
        : undefined;
      if (!path) return [];
      return readTranscriptTail(path);
    } catch {
      return [];
    }
  }

  /**
   * Opaque full-pane workspace for one worker. Overlay input is raw handleInput:
   * Esc/q returns to the lead without aborting the worker, `o`/Enter resolves
   * "open" for settled/failed workers only. Live workers stay read-only with
   * the reason shown inline. Guarded so repeated clicks/Enters cannot stack
   * views: extra requests while one is open resolve immediately without opening
   * another. Fusion's Escape abort is gated on this flag because overlay
   * handleInput does not consume TUI input listeners.
   */
  let peekOpen = false;
  let peekItemId: string | undefined;
  let peekSnapshot: DockAgentItem | undefined;
  let peekTranscriptLines: string[] = [];
  let peekScrollOffset: number | undefined;
  let peekInvalidate: (() => void) | undefined;

  function refreshOpenPeek(items: readonly DockAgentItem[]): void {
    if (!peekOpen || !peekItemId) return;
    const next = items.find((item) => item.id === peekItemId);
    if (!next) return;
    peekSnapshot = next;
    // Structural fleet publications are the refresh boundary. This bounded
    // file read never occurs in render and streaming heartbeat deltas do not
    // publish a new snapshot. Pinned views stay pinned so new tail lines
    // appear; an explicit scroll offset is left in place.
    peekTranscriptLines = peekTranscript(next);
    peekInvalidate?.();
  }

  async function openPeek(
    ctx: ExtensionContext,
    item: DockAgentItem,
    canOpenHere = false,
  ): Promise<{ open: boolean }> {
    if (peekOpen) return { open: false };
    peekOpen = true;
    setAgentWorkspaceOpen(true);
    peekItemId = item.id;
    peekSnapshot = item;
    peekTranscriptLines = peekTranscript(item);
    peekScrollOffset = undefined;
    let result: { open: boolean } | undefined;
    try {
      let currentRows = () => 24;
      let currentWidth = 80;
      result = await ctx.ui.custom<{ open: boolean }>(
        (tui, theme, keys, done) => {
          currentRows = () => Math.max(3, Math.min(80, tui.terminal?.rows ?? 24));
          peekInvalidate = () => {
            requestHostRender();
            try {
              tui.requestRender();
            } catch {
              // Overlay paint is best-effort; the host path still runs.
            }
          };
          const scrollBy = (delta: number): void => {
            const current = peekSnapshot ?? item;
            const body = peekTranscriptBudget(currentWidth, current, currentRows());
            const rows = layoutPeekTranscript(theme, currentWidth, peekTranscriptLines);
            peekScrollOffset = clampPeekScroll(rows.length, body, peekScrollOffset, delta);
            peekInvalidate?.();
          };
          return {
            render(width: number): string[] {
              currentWidth = width;
              return renderPeekBody(theme, width, peekSnapshot ?? item, {
                transcript: peekTranscriptLines,
                canOpenHere,
                maxLines: currentRows(),
                scrollOffset: peekScrollOffset,
              });
            },
            handleInput(data: string): void {
              if (
                keys.matches(data, "tui.select.cancel") ||
                data === "\u0003" ||
                data === "q" ||
                data === "Q"
              ) {
                done({ open: false });
                return;
              }
              if (data === "\u001b[A" || data === "\u001bOA") {
                scrollBy(-1);
                return;
              }
              if (data === "\u001b[B" || data === "\u001bOB") {
                scrollBy(1);
                return;
              }
              if (data === "\u001b[5~") {
                const current = peekSnapshot ?? item;
                const body = peekTranscriptBudget(currentWidth, current, currentRows());
                scrollBy(-Math.max(1, body));
                return;
              }
              if (data === "\u001b[6~") {
                const current = peekSnapshot ?? item;
                const body = peekTranscriptBudget(currentWidth, current, currentRows());
                scrollBy(Math.max(1, body));
                return;
              }
              if (data === "g" || data === "\u001b[H" || data === "\u001b[1~") {
                peekScrollOffset = 0;
                peekInvalidate?.();
                return;
              }
              if (data === "G" || data === "\u001b[F" || data === "\u001b[4~") {
                peekScrollOffset = undefined;
                peekInvalidate?.();
                return;
              }
              if (
                data === "o" ||
                data === "O" ||
                keys.matches(data, "tui.select.confirm")
              ) {
                const current = peekSnapshot ?? item;
                if (canSwitchToSession(current.lifecycle)) done({ open: true });
              }
            },
            invalidate(): void {},
          };
        },
        {
          overlay: true,
          overlayOptions: () => ({
            width: "100%",
            maxHeight: "100%",
            anchor: "top-left",
            margin: 0,
          }),
        },
      );
    } finally {
      peekOpen = false;
      setAgentWorkspaceOpen(false);
      peekItemId = undefined;
      peekSnapshot = undefined;
      peekTranscriptLines = [];
      peekScrollOffset = undefined;
      peekInvalidate = undefined;
    }
    return result ?? { open: false };
  }

  /** Peek the selected agents-pane row; stash nothing, resolve inline. */
  async function peekSelected(ctx: ExtensionContext): Promise<void> {
    if (!presentationEnabled || dockPane !== "agents" || panelCollapsed) return;
    clampSelection();
    const item = liveAgents[selectedAgent];
    if (!item) {
      ctx.ui.notify("No agents.", "info");
      return;
    }
    currentCtx = ctx;
    const resolved = await openPeek(ctx, item);
    if (resolved.open) prepareOpenCommand(ctx, item);
    if (currentCtx) renderPanel();
  }

  /**
   * Click/shortcut contexts cannot switch sessions. Prepare the explicit
   * command only when the editor is empty, preserving every user draft.
   */
  function prepareOpenCommand(ctx: ExtensionContext, item: DockAgentItem): void {
    const command = `/agents open ${item.id}`;
    try {
      if (ctx.ui.getEditorText() === "") {
        ctx.ui.setEditorText(command);
        ctx.ui.notify("Press Enter to open this settled worker session.", "info");
        return;
      }
    } catch {
      // Fall through to a non-destructive instruction.
    }
    ctx.ui.notify(`Run ${command} to open this settled worker session.`, "info");
  }

  function renderPanel(): void {
    const ctx = currentCtx;
    if (!ctx?.hasUI || ctx.mode !== "tui") return;
    if (process.env.PI_BEHAVIOR_MODE === "pi") { clearPanel(); return; }
    if (!dockHasSurface()) {
      if (dockMounted) clearPanel();
      return;
    }
    if (dockPane === "agents" && liveAgents.length === 0) dockPane = "todos";
    // The WidthText factory closes over this state. Remounting via setWidget
    // on every todo_write / fleet lifecycle tick rebuilds the above-editor
    // widget and has coincided with unclean Windows parent deaths. Paint
    // the live host instead; remount only to create or destroy the surface.
    if (dockMounted) {
      requestHostRender();
      return;
    }
    writeLastPhase("todo-dock:mount");
    try {
      // Keyboard selection rides onTerminalInput while the dock is mounted;
      // the handler self-gates to the visible agents pane. One listener
      // per mount, removed on unmount, so input never stacks.
      removeDockInput?.();
      removeDockInput = undefined;
      try {
        const host = ctx;
        if (host?.hasUI && host.mode === "tui" && presentationEnabled) {
          removeDockInput = host.ui.onTerminalInput(dockInputHandler);
        }
      } catch {
        removeDockInput = undefined;
      }
      ctx.ui.setWidget(
        PANEL_KEY,
        (_tui, theme) =>
          new DockPanel(
            (width) => {
              if (dockPane === "agents") {
                return renderAgentList(theme, width, liveAgents, {
                  collapsed: panelCollapsed,
                  tabs: dockTabs(),
                  selectedIndex: selectedAgent,
                });
              }
              if (!current) {
                return renderAgentList(theme, width, liveAgents, {
                  collapsed: panelCollapsed,
                  tabs: dockTabs(),
                });
              }
              if (!presentationEnabled) return renderPlainTodoList(current, width);
              return renderTodoList(theme, width, current, {
                collapsed: panelCollapsed,
                toggleHint: TOGGLE_HINT,
                tabs: dockTabs(),
              });
            },
            {
              fallback: "[todo panel unavailable]",
              onAgentRow: (rowIndex) => {
                if (!presentationEnabled || dockPane !== "agents" || panelCollapsed) return;
                clampSelection();
                selectedAgent = rowIndex;
                const item = liveAgents[rowIndex];
                const host = currentCtx;
                if (currentCtx) renderPanel();
                if (item && host) void openPeek(host, item).then((resolved) => {
                  if (resolved.open) prepareOpenCommand(host, item);
                  if (currentCtx) renderPanel();
                });
              },
              rowCount: () => (dockPane === "agents" && !panelCollapsed ? liveAgents.length : 0),
            },
          ),
        { placement: "aboveEditor" },
      );
      dockMounted = true;
    } catch {
      // The transcript receipt remains available if the dock cannot be mounted.
    }
  }

  function togglePanel(ctx: ExtensionContext): void {
    currentCtx = ctx;
    if (!presentationEnabled) {
      ctx.ui.notify("Todo panel controls are inactive while Apex presentation is disabled.", "info");
      return;
    }
    if (!dockHasSurface()) {
      ctx.ui.notify("No todo list or retained agent history for this session yet.", "info");
      return;
    }
    panelCollapsed = !panelCollapsed;
    renderPanel();
  }

  function switchPane(ctx: ExtensionContext, pane: DockPane): void {
    currentCtx = ctx;
    if (!presentationEnabled) {
      ctx.ui.notify("Todo panel controls are inactive while Apex presentation is disabled.", "info");
      return;
    }
    if (pane === "agents" && liveAgents.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }
    if (pane === "todos" && !current && liveAgents.length > 0) {
      dockPane = "agents";
      renderPanel();
      return;
    }
    dockPane = pane;
    renderPanel();
  }

  unsubscribeFleet = subscribeDockAgents((items) => {
    liveAgents = [...items];
    refreshOpenPeek(liveAgents);
    clampSelection();
    if (liveAgents.length === 0 && dockPane === "agents") dockPane = "todos";
    if (presentationEnabled && liveAgents.length > 0 && !current) {
      dockPane = "agents";
    }
    if (currentCtx) renderPanel();
  });

  /**
   * Switch to a settled/failed worker's session. Called only from the
   * /agents open handler, which holds ExtensionCommandContext — the one
   * context that carries switchSession. Live workers are refused: the
   * child is still appending to that file (no lock, append-per-entry).
   */
  async function openAgentSession(ctx: ExtensionContext, rawId: string): Promise<void> {
    currentCtx = ctx;
    if (!presentationEnabled) {
      ctx.ui.notify("Todo panel controls are inactive while Apex presentation is disabled.", "info");
      return;
    }
    const id = rawId.trim();
    const item = liveAgents.find((entry) => entry.id === id);
    if (!id || !item) {
      ctx.ui.notify(id ? `No agent "${cleanInline(id, 40)}".` : "Usage: /agents open <id>.", "info");
      return;
    }
    if (!canSwitchToSession(item.lifecycle)) {
      ctx.ui.notify(`${item.id} is still ${item.lifecycle}; its session is still being written. Open it after it settles.`, "info");
      return;
    }
    const path = typeof readProp(item, "sessionFile") === "string"
      ? (readProp(item, "sessionFile") as string)
      : undefined;
    if (!path) {
      ctx.ui.notify(`${item.id} has no session file recorded.`, "info");
      return;
    }
    const privileged = ctx as ExtensionContext & {
      switchSession?: (path: string) => Promise<{ cancelled: boolean }>;
    };
    if (typeof privileged.switchSession !== "function") {
      ctx.ui.notify("Session switch is unavailable from this context.", "info");
      return;
    }
    const otherLive = liveAgents.filter(
      (entry) => entry.id !== item.id && !canSwitchToSession(entry.lifecycle),
    );
    if (otherLive.length > 0) {
      const confirmed = await ctx.ui.confirm(
        "Stop running agents and switch session?",
        `Opening ${item.id} replaces this session and stops ${otherLive.length} other running ${otherLive.length === 1 ? "worker" : "workers"}. Continue?`,
      );
      if (!confirmed) return;
    }
    const current = liveAgents.find((entry) => entry.id === item.id);
    if (!current || !canSwitchToSession(current.lifecycle)) {
      ctx.ui.notify(`${item.id} is still ${current?.lifecycle ?? "unavailable"}; its session cannot be opened.`, "info");
      return;
    }
    try {
      // Core switchSession awaits outgoing session_shutdown before opening the
      // target runtime. task owns that shutdown and synchronously closes all
      // retained workers, preventing a later task_send from reusing this file.
      await privileged.switchSession(path);
    } catch {
      try {
        ctx.ui.notify(`Could not open ${item.id}'s session.`, "info");
      } catch {
        // A successful replacement invalidates this context; only real switch
        // failures can normally reach here with a usable notification surface.
      }
    }
  }

  /** Open peek for one worker from a command/shortcut context. */
  async function peekAgent(ctx: ExtensionContext, rawId: string): Promise<void> {
    currentCtx = ctx;
    if (!presentationEnabled) {
      ctx.ui.notify("Todo panel controls are inactive while Apex presentation is disabled.", "info");
      return;
    }
    const id = rawId.trim();
    if (!liveAgents.length) {
      ctx.ui.notify("No agents.", "info");
      return;
    }
    const item = id
      ? liveAgents.find((entry) => entry.id === id)
      : liveAgents[Math.min(selectedAgent, liveAgents.length - 1)];
    if (!item) {
      ctx.ui.notify(id ? `No agent "${cleanInline(id, 40)}".` : "No agents.", "info");
      return;
    }
    const privileged = ctx as ExtensionContext & {
      switchSession?: (path: string) => Promise<{ cancelled: boolean }>;
    };
    const resolved = await openPeek(ctx, item, typeof privileged.switchSession === "function");
    if (resolved.open) {
      if (typeof privileged.switchSession === "function") {
        // Re-resolve and recheck lifecycle immediately before activation.
        await openAgentSession(ctx, item.id);
      } else {
        prepareOpenCommand(ctx, item);
      }
    }
    if (currentCtx) renderPanel();
  }

  // Always registered (no SDK unregister exists); togglePanel/switchPane
  // refuse while presentation is disabled, keeping the plain widget mounted.
  {
    pi.registerShortcut("alt+t", {
      description: "Collapse or expand the todo panel",
      handler: (ctx) => togglePanel(ctx),
    });
    pi.registerShortcut("alt+a", {
      description: "Show the agents tab in the todo dock",
      handler: (ctx) => switchPane(ctx, dockPane === "agents" ? "todos" : "agents"),
    });

    pi.registerCommand("todos", {
      description: "Collapse or expand the todo panel above the input",
      handler: async (_args, ctx) => togglePanel(ctx),
    });
    pi.registerCommand("agents", {
      description: "Show live sub-agents in the todo dock; /agents peek [id] opens a read-only view, /agents open <id> switches to a settled worker's session",
      handler: async (args, ctx) => {
        const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (verb === "peek") {
          await peekAgent(ctx, rest.join(" "));
          return;
        }
        if (verb === "open") {
          await openAgentSession(ctx, rest.join(" "));
          return;
        }
        if (verb !== undefined) {
          ctx.ui.notify(`Unknown /agents subcommand "${cleanInline(verb, 24)}". Use /agents, /agents peek [id], or /agents open <id>.`, "info");
          return;
        }
        switchPane(ctx, "agents");
      },
    });
  }

  pi.events.on("pi:ui:changed", () => {
    presentationEnabled = apexPresentationEnabled();
    // Disabled mode is a plain todo list: never leave the dock on agents.
    if (!presentationEnabled && dockPane === "agents") dockPane = "todos";
    registerTodoWriteTool();
    registerTodoReadTool();
    renderPanel();
  });
  pi.events.on("pi:modes:changed", () => renderPanel());

  pi.on("ui_prompt_start", () => {
    uiPromptDepth += 1;
  });
  pi.on("ui_prompt_end", () => {
    uiPromptDepth = Math.max(0, uiPromptDepth - 1);
  });

  pi.on("session_start", (event: any, ctx: ExtensionContext) => {
    clearPanel();
    panelCollapsed = false;
    dockPane = "todos";
    currentCtx = ctx;
    uiPromptDepth = 0;
    current = event?.reason === "new" ? undefined : reconstructTodoState(ctx);
    liveAgents = currentDockAgents();
    if (presentationEnabled && liveAgents.length > 0 && !current) {
      dockPane = "agents";
    }
    if (dockHasSurface()) renderPanel();
  });

  pi.on("session_tree", (_event: any, ctx: ExtensionContext) => {
    clearPanel();
    currentCtx = ctx;
    current = reconstructTodoState(ctx);
    liveAgents = currentDockAgents();
    if (presentationEnabled && liveAgents.length > 0 && !current) {
      dockPane = "agents";
    }
    if (dockHasSurface()) renderPanel();
  });

  pi.on("session_shutdown", () => {
    clearPanel();
    current = undefined;
    currentCtx = undefined;
    uiPromptDepth = 0;
    liveAgents = [];
    selectedAgent = 0;
    dockPane = "todos";
    unsubscribeFleet();
  });

  // Renderer slots snapshot at registration, so both tools re-register on
  // every live presentation switch (see pi:ui:changed above). The closures
  // below share this scope's plan state, which survives re-registration.
  function registerTodoWriteTool(): void {
  pi.registerTool({
    name: "todo_write",
    label: "Todo Write",
    description:
      "Replace the session todo list with a full plan. Write the plan BEFORE the first edit whenever the task spans 3+ steps, touches more than one file, involves delegation, or bundles several user requests. Keep at most one item in_progress, mark items blocked when waiting on something external, and mark items completed as they finish. Each call replaces the entire list, so always send the complete set.",
    promptSnippet:
      "Plan multi-step work here before the first edit (3+ steps, multiple files, delegation, or several requests at once); one in_progress, blocked when waiting, complete promptly.",
    promptGuidelines: [
      "Call todo_write before the first edit when work spans three or more steps, touches more than one file, involves delegation, or bundles several user requests. This is a threshold, not a judgment call.",
      "Call todo_write with the complete list on every update; each call replaces the whole list rather than patching individual items.",
      "Keep at most one item in_progress \u2014 normally exactly one while actionable work remains, and zero when every open item is blocked \u2014 and mark work completed as it finishes rather than in a batch at the end.",
      "Add newly discovered work as new items instead of silently widening an existing one, and mark abandoned work cancelled rather than deleting it.",
      "Never mark an item completed on the strength of an edit alone when it still needs verification; the list is a commitment to the user and must stay truthful.",
      "Refer to an item by its exact content text rather than a positional id. todo_read returns a bounded prefix of the list and may omit later items; do not assume every item's exact text is recoverable from that result.",
      "Mark an item blocked with the reason in its note when it is waiting on a user decision, another agent, or an external service; return it to pending when it becomes actionable again.",
      "Batch the list update into the same message as the work it accompanies rather than spending a turn on the list alone; a solo update is fine when revising the plan is the only remaining state change.",
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({
            description: "Task text shown in the list (required).",
          }),
          status: Type.String({
            enum: [
              "pending",
              "in_progress",
              "blocked",
              "completed",
              "cancelled",
            ],
            description:
              "pending | in_progress | blocked | completed | cancelled. Keep at most one in_progress; use blocked when waiting on a user decision, another agent, or an external service.",
          }),
          id: Type.Optional(
            Type.String({
              description:
                "Stable id for the item (optional; positional id is assigned if omitted).",
            }),
          ),
          note: Type.Optional(
            Type.String({
              description:
                "Short dim detail: owner, blocker, or follow-up (optional). When status is blocked, put the blocking reason here.",
            }),
          ),
        }),
        {
          maxItems: 200,
          description:
            "Full replacement list. Must be non-empty and contain at most one in_progress item.",
        },
      ),
    }),
    executionMode: "sequential",
    ...withApexPresentation({
      renderShell: "self" as const,
      renderCall(
        args: TodoWriteParams,
        theme: StatusTheme,
        context: ToolRenderContext<TodoRenderState, TodoWriteParams>,
      ) {
        markTodoStarted(context);
        return new WidthText(
          (width) =>
            context.state.hasResult
              ? []
              : [
                  todoReceiptLine(theme, width, {
                    tool: "todo_write",
                    kind: context.executionStarted ? "running" : "queued",
                    subject: writeItemCount(args),
                    startedAt: context.state.startedAt,
                  }),
                ],
          "[todo_write call unavailable]",
        );
      },
      renderResult(
        result: { content?: unknown; details?: TodoDetails; isError?: boolean },
        options: { expanded: boolean; isPartial: boolean },
        theme: StatusTheme,
        context: ToolRenderContext<TodoRenderState, TodoWriteParams>,
      ) {
        context.state.hasResult = true;
        markTodoEnded(context);
        const payload = todoPayload(result);
        const isError = Boolean(context.isError) || Boolean(result?.isError);
        return new WidthText((width) => {
          const view = payload?.view;
          if (!view) {
            return todoFallbackLines(
              theme,
              width,
              "todo_write",
              payload?.message ?? textContent(result),
              isError,
              context.state,
            );
          }
          // In the interactive TUI the dock above the editor is the canonical
          // todo surface. Keep successful writes out of the transcript so the
          // same list is not shown twice. Still emit a compact receipt so Pi
          // does not fall back to the default blue tool name.
          if (currentCtx?.mode === "tui") {
            return [
              todoReceiptLine(theme, width, {
                tool: "todo_write",
                kind: isError ? "failed" : "succeeded",
                subject: summarize(view),
                startedAt: context.state.startedAt,
                endedAt: context.state.endedAt,
              }),
            ];
          }
          return renderTodoList(theme, width, view, {
            expanded: context.expanded || options.expanded,
            emptyHint: "todo_write to start a plan",
          });
        }, "[todo_write result unavailable]");
      },
    }),
    async execute(
      _toolCallId: string,
      params: TodoWriteParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const rawTodos = (params as any)?.todos;
      if (!Array.isArray(rawTodos) || rawTodos.length === 0) {
        const message =
          "todos must be a non-empty array. Pass the full list to replace; use at least one item.";
        return textResult(message, true, { message });
      }

      if (rawTodos.length > 200) {
        const message = `todos may have at most 200 items (got ${rawTodos.length}). Rejected without changing the current list.`;
        return textResult(message, true, { message });
      }

      let inProgress = 0;
      const validated: TodoItem[] = [];

      for (let i = 0; i < rawTodos.length; i++) {
        const item = rawTodos[i];
        const index = i + 1;

        if (!item || typeof item !== "object") {
          const message = `todo ${index} must be an object.`;
          return textResult(message, true, { message });
        }

        const rawContent =
          typeof item.content === "string"
            ? item.content
            : typeof (item as any).title === "string"
              ? (item as any).title
              : typeof (item as any).text === "string"
                ? (item as any).text
                : "";
        const content = cleanInline(rawContent, 200);
        if (!content) {
          const message = `todo ${index} requires non-empty content.`;
          return textResult(message, true, { message });
        }

        const rawStatus =
          typeof item.status === "string"
            ? item.status.trim().toLowerCase()
            : typeof (item as any).state === "string"
              ? (item as any).state.trim().toLowerCase()
              : "";

        if (!CANONICAL_STATUSES.includes(rawStatus as TodoStatus)) {
          const message = `todo ${index} has invalid status "${item.status ?? ""}". Allowed: ${CANONICAL_STATUSES.join(", ")}.`;
          return textResult(message, true, { message });
        }

        const status = rawStatus as TodoStatus;
        if (status === "in_progress") inProgress++;

        const rawId = typeof item.id === "string" ? item.id : "";
        const id = cleanInline(rawId, 40) || `todo_${index}`;

        const rawNote =
          typeof item.note === "string"
            ? item.note
            : typeof (item as any).detail === "string"
              ? (item as any).detail
              : "";
        const note = cleanInline(rawNote, 200) || undefined;

        validated.push({
          id,
          title: content,
          status,
          note,
        });
      }

      if (inProgress > 1) {
        const message = `todos may have at most one in_progress item (got ${inProgress}). Mark other active work completed/blocked/cancelled/pending first.`;
        return textResult(message, true, { message });
      }

      const view = buildTodoList(validated);
      current = view;
      currentCtx = ctx;
      renderPanel();
      return textResult(summarize(current), false, { view: current });
    },
  });
  }

  // The plan is otherwise write-only: after compaction the lead agent has no way
  // to recover what it committed to, which makes the list easy to abandon
  // mid-task. This makes it durable state that can be read back.
  function registerTodoReadTool(): void {
  pi.registerTool({
    name: "todo_read",
    label: "Todo Read",
    description:
      "Read back a bounded prefix of the current session todo list. Use when returning to long-running work or after compaction to recover what is done and what remains. Later items may be omitted; the result is not a guarantee of every item's exact content.",
    promptSnippet:
      "Read back a bounded prefix of the session todo list (use after compaction or when resuming long work); later items may be omitted.",
    promptGuidelines: [
      "Call todo_read when resuming long-running work or after compaction, rather than assuming the remembered plan is still accurate. The result is a bounded prefix and may omit later items.",
    ],
    parameters: Type.Object({}),
    executionMode: "sequential",
    ...withApexPresentation({
      renderShell: "self" as const,
      renderCall(
        _args: object,
        theme: StatusTheme,
        context: ToolRenderContext<TodoRenderState, object>,
      ) {
        markTodoStarted(context);
        return new WidthText(
          (width) =>
            context.state.hasResult
              ? []
              : [
                  todoReceiptLine(theme, width, {
                    tool: "todo_read",
                    kind: context.executionStarted ? "running" : "queued",
                    startedAt: context.state.startedAt,
                  }),
                ],
          "[todo_read call unavailable]",
        );
      },
      renderResult(
        result: { content?: unknown; details?: TodoDetails; isError?: boolean },
        options: { expanded: boolean; isPartial: boolean },
        theme: StatusTheme,
        context: ToolRenderContext<TodoRenderState, object>,
      ) {
        context.state.hasResult = true;
        markTodoEnded(context);
        const payload = todoPayload(result);
        const isError = Boolean(context.isError) || Boolean(result?.isError);
        return new WidthText((width) => {
          const view = payload?.view;
          if (!view) {
            if (!isError) {
              return todoEmptyReadLines(theme, width, context.state);
            }
            return todoFallbackLines(
              theme,
              width,
              "todo_read",
              payload?.message ?? textContent(result),
              true,
              context.state,
            );
          }
          // Same TUI rule as todo_write: the dock owns the list, but a blank
          // result lets Pi paint the default tool-name row instead of Apex.
          if (currentCtx?.mode === "tui") {
            return [
              todoReceiptLine(theme, width, {
                tool: "todo_read",
                kind: isError ? "failed" : "succeeded",
                subject: summarize(view),
                startedAt: context.state.startedAt,
                endedAt: context.state.endedAt,
              }),
            ];
          }
          return renderTodoList(theme, width, view, {
            expanded: context.expanded || options.expanded,
            emptyHint: "todo_write to start a plan",
          });
        }, "[todo_read result unavailable]");
      },
    }),
    async execute() {
      if (!current) {
        const message =
          "No todo list for this session yet. Use todo_write to create one.";
        return textResult(message, false, { message });
      }
      return textResult(serializeForRead(current), false, { view: current });
    },
  });
  }

  registerTodoWriteTool();
  registerTodoReadTool();

  // Fusion close backstop: model-facing, not chrome. Registered alongside
  // the tools so it fires under PI_APEX_UI=0 too; the handler gates on live
  // env per call (same dynamic-read pattern as the PI_UI_SKIN glyphs) and
  // reads this scope's plan state, so no import-boundary crossing is needed.
  pi.on("tool_result", event => {
    if (process.env.PI_BEHAVIOR_MODE !== "fusion") return;
    if (process.env.PI_FUSION_SIDEKICK === "1") return;
    if (event.toolName !== "task_wait" && event.toolName !== "task_close") return;
    const open = (current?.items ?? []).filter(
      item => item.status === "pending" || item.status === "in_progress",
    );
    if (open.length === 0) return;
    const existing = Array.isArray(event.content) ? event.content : [];
    return {
      content: [...existing, { type: "text" as const, text: fusionCloseNudge(event.toolName, open) }],
    };
  });
}
