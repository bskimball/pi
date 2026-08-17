// todo-tools: registration, validation, and session state for `todo_write` /
// `todo_read`, plus the docked todo panel above the editor.
//
// Presentation is pure and lives in ./todo-view.ts. Everything here is
// registration and state: no render timers, no pi-tui Text/Markdown/Container.
// Tool registration and execution are unconditional; only the receipt and
// widget chrome pass through the Apex presentation gate.

import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CANONICAL_STATUSES,
  buildTodoList,
  renderPlainTodoList,
  renderTodoList,
  type TodoItem,
  type TodoListView,
  type TodoStatus,
} from "./todo-view.ts";
import {
  apexPresentationEnabled,
  withApexPresentation,
} from "../presentation/presentation.ts";
import {
  padStartToWidth,
  safeTruncateToWidth,
} from "../presentation/safe-text-layout.ts";
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
 *   ✓ todo_read  1/3 done · Align the receipt
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
      ? theme.fg("warning", "\u25cf")
      : options.kind === "queued"
        ? theme.fg("dim", "\u25cb")
        : options.kind === "failed"
          ? theme.fg("error", "\u00d7")
          : theme.fg("success", "\u2713");
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

// ---------------------------------------------------------------- install

export function installTodoTools(pi: ExtensionAPI): void {
  /** Current plan for this process/session. Each successful write replaces it. */
  let current: TodoListView | undefined;
  let currentCtx: ExtensionContext | undefined;
  let panelCollapsed = false;
  const PANEL_KEY = "todo-list";
  const TOGGLE_HINT = "alt+t";
  const presentationEnabled = apexPresentationEnabled();

  function clearPanel(): void {
    const ctx = currentCtx;
    if (!ctx?.hasUI || ctx.mode !== "tui") return;
    try {
      ctx.ui.setWidget(PANEL_KEY, undefined);
    } catch {
      // UI teardown must not interrupt a session transition.
    }
  }

  function renderPanel(): void {
    const ctx = currentCtx;
    if (!ctx?.hasUI || ctx.mode !== "tui" || !current) return;
    try {
      ctx.ui.setWidget(
        PANEL_KEY,
        (_tui, theme) =>
          new WidthText(
            (width) =>
              presentationEnabled
                ? renderTodoList(theme, width, current!, {
                    collapsed: panelCollapsed,
                    toggleHint: TOGGLE_HINT,
                  })
                : renderPlainTodoList(current!, width),
            "[todo panel unavailable]",
          ),
        { placement: "aboveEditor" },
      );
    } catch {
      // The transcript receipt remains available if the dock cannot be mounted.
    }
  }

  function togglePanel(ctx: ExtensionContext): void {
    currentCtx = ctx;
    if (!current) {
      ctx.ui.notify("No todo list for this session yet.", "info");
      return;
    }
    panelCollapsed = !panelCollapsed;
    renderPanel();
  }
  if (presentationEnabled) {
    pi.registerShortcut("alt+t", {
      description: "Collapse or expand the todo panel",
      handler: (ctx) => togglePanel(ctx),
    });

    pi.registerCommand("todos", {
      description: "Collapse or expand the todo panel above the input",
      handler: async (_args, ctx) => togglePanel(ctx),
    });
  }

  pi.on("session_start", (event: any, ctx: ExtensionContext) => {
    clearPanel();
    panelCollapsed = false;
    currentCtx = ctx;
    current = event?.reason === "new" ? undefined : reconstructTodoState(ctx);
    if (current) renderPanel();
  });

  pi.on("session_tree", (_event: any, ctx: ExtensionContext) => {
    clearPanel();
    currentCtx = ctx;
    current = reconstructTodoState(ctx);
    if (current) renderPanel();
  });

  pi.on("session_shutdown", () => {
    clearPanel();
    current = undefined;
    currentCtx = undefined;
  });

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

  // The plan is otherwise write-only: after compaction the lead agent has no way
  // to recover what it committed to, which makes the list easy to abandon
  // mid-task. This makes it durable state that can be read back.
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
