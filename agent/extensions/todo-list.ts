// todo-list: agent-facing `todo_write` tool for a session plan/checklist.
//
// Presentation is pure and lives in apex/lib/todo-list.ts. This extension only
// owns registration, validation, session-scoped state, and the Apex receipt
// wiring that turns a structured view into a passive WidthText component.
// There are no render timers and no pi-tui Text/Markdown/Container on this path.

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildTodoList,
  renderTodoList,
  type TodoListView,
  type TodoStatus,
} from "./apex/lib/todo-list.ts";
import {
  apexPresentationEnabled,
  withApexPresentation,
} from "./apex/lib/presentation.ts";
import {
  TREE,
  WidthText,
  textContent,
  type ToolRenderContext,
} from "./apex/lib/ui-common.ts";
import {
  receiptHeader,
  safeLine,
  type StatusTheme,
} from "./apex/lib/status-view.ts";

// ---------------------------------------------------------------- types

interface TodoWriteParams {
  todos: Array<{
    content: string;
    status: TodoStatus;
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

function textResult(
  text: string,
  isError = false,
  details: TodoDetails = {},
) {
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
    view.activeIndex >= 0
      ? safeLine(view.items[view.activeIndex]?.title, 80)
      : "";
  const base = `${view.done}/${view.total} done`;
  return active ? `${base} · ${active}` : base;
}

/** Plain widget lines that inherit Pi's default UI instead of Apex chrome. */
function defaultTodoPanelLines(
  view: TodoListView,
  collapsed: boolean,
  toggleHint: string,
): string[] {
  const limit = collapsed ? 5 : 9;
  const anchor = Math.max(0, view.anchorIndex);
  const start = Math.max(
    0,
    Math.min(anchor - Math.floor(limit / 2), view.items.length - limit),
  );
  const visible = view.items.slice(start, start + limit);
  const glyph: Record<TodoStatus, string> = {
    pending: "[ ]",
    in_progress: "[>]",
    blocked: "[!]",
    completed: "[x]",
    cancelled: "[-]",
  };
  const lines = [`Todos (${view.done}/${view.total} done)  ${toggleHint}`];
  for (const item of visible) {
    lines.push(`${glyph[item.status]} ${safeLine(item.title, 180)}`);
  }
  const omitted = view.items.length - visible.length;
  if (omitted > 0) lines.push(`... ${omitted} more`);
  return lines;
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
    const note = item.note ? ` · ${item.note}` : "";
    lines.push(safeLine(`[${item.status}] ${item.title}${note}`, READ_LINE_CHARS));
  }
  const omitted = view.items.length - limit;
  if (omitted > 0) lines.push(`… ${omitted} more items`);
  return lines.join("\n");
}

/** One-line call row shown while todo_write is in flight. */
function todoCallLine(
  theme: StatusTheme,
  width: number,
  args: unknown,
  started: boolean,
): string {
  const raw =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : undefined;
  const todos = Array.isArray(raw?.todos) ? raw.todos : [];
  const count = todos.length;
  return receiptHeader(theme, width, {
    tool: "todo_write",
    subject: count ? `${count} item${count === 1 ? "" : "s"}` : undefined,
    kind: started ? "running" : "queued",
    label: started ? "updating" : "queued",
    rootGlyph: TREE.receipt,
  });
}

/** Compact fallback when no structured view is available. */
function todoFallbackLines(
  theme: StatusTheme,
  width: number,
  text: unknown,
  isError: boolean,
): string[] {
  const message = safeLine(text, 300) || (isError ? "todo_write failed" : "todo_write");
  return [
    receiptHeader(theme, width, {
      tool: "todo_write",
      kind: isError ? "failed" : "unknown",
      subject: message,
      rootGlyph: TREE.receipt,
    }),
  ];
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  /** Current plan for this process/session. Each successful write replaces it. */
  let current: TodoListView | undefined;
  let currentCtx: ExtensionContext | undefined;
  let panelCollapsed = false;
  const PANEL_KEY = "todo-list";
  const TOGGLE_HINT = "alt+t";

  function clearPanel(): void {
    const ctx = currentCtx;
    currentCtx = undefined;
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
      if (!apexPresentationEnabled()) {
        ctx.ui.setWidget(
          PANEL_KEY,
          defaultTodoPanelLines(current, panelCollapsed, TOGGLE_HINT),
          { placement: "aboveEditor" },
        );
        return;
      }
      ctx.ui.setWidget(
        PANEL_KEY,
        (_tui, theme) =>
          new WidthText(
            (width) =>
              renderTodoList(theme, width, current!, {
                collapsed: panelCollapsed,
                toggleHint: TOGGLE_HINT,
              }),
            "[todo panel unavailable]",
          ),
        { placement: "aboveEditor" },
      );
    } catch {
      // The transcript receipt remains available if the dock cannot be mounted.
    }
  }

  pi.on("session_start", (_event, ctx) => {
    clearPanel();
    current = undefined;
    panelCollapsed = false;
    currentCtx = ctx;
  });
  pi.on("session_shutdown", () => {
    clearPanel();
    current = undefined;
  });

  pi.registerShortcut("alt+t", {
    description: "Collapse or expand the todo panel",
    handler: (ctx) => {
      currentCtx = ctx;
      if (!current) {
        ctx.ui.notify("No todo list for this session yet.", "info");
        return;
      }
      panelCollapsed = !panelCollapsed;
      renderPanel();
    },
  });

  pi.registerCommand("todos", {
    description: "Collapse or expand the todo panel above the input",
    handler: async (_args, ctx) => {
      currentCtx = ctx;
      if (!current) {
        ctx.ui.notify("No todo list for this session yet.", "info");
        return;
      }
      panelCollapsed = !panelCollapsed;
      renderPanel();
    },
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
      "Keep at most one item in_progress — normally exactly one while actionable work remains, and zero when every open item is blocked — and mark work completed as it finishes rather than in a batch at the end.",
      "Add newly discovered work as new items instead of silently widening an existing one, and mark abandoned work cancelled rather than deleting it.",
      "Never mark an item completed on the strength of an edit alone when it still needs verification; the list is a commitment to the user and must stay truthful.",
      "Refer to an item by its exact content text rather than a positional id; call todo_read to recover the exact text instead of guessing from memory.",
      "Mark an item blocked with the reason in its note when it is waiting on a user decision, another agent, or an external service; return it to pending when it becomes actionable again.",
      "Batch the list update into the same message as the work it accompanies rather than spending a turn on the list alone; a solo update is fine when revising the plan is the only remaining state change.",
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({
            description: "Task text shown in the list (required).",
          }),
          status: StringEnum(
            ["pending", "in_progress", "blocked", "completed", "cancelled"] as const,
            {
              description:
                "pending | in_progress | blocked | completed | cancelled. Keep at most one in_progress; use blocked when waiting on a user decision, another agent, or an external service.",
            },
          ),
          id: Type.Optional(
            Type.String({
              description: "Stable id for the item (optional; positional id is assigned if omitted).",
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
        context: ToolRenderContext<{ hasResult?: boolean }, TodoWriteParams>,
      ) {
        return new WidthText(
          (width) =>
            context.state.hasResult
              ? []
              : [todoCallLine(theme, width, args, context.executionStarted)],
          "[todo_write call unavailable]",
        );
      },
      renderResult(
        result: { content?: unknown; details?: TodoDetails; isError?: boolean },
        options: { expanded: boolean; isPartial: boolean },
        theme: StatusTheme,
        context: ToolRenderContext<{ hasResult?: boolean }, TodoWriteParams>,
      ) {
        context.state.hasResult = true;
        const payload = todoPayload(result);
        const isError = Boolean(result?.isError) || Boolean(payload?.message);
        return new WidthText((width) => {
          const view = payload?.view;
          if (!view) {
            return todoFallbackLines(
              theme,
              width,
              payload?.message ?? textContent(result),
              isError,
            );
          }
          // In the interactive TUI the dock above the editor is the canonical
          // todo surface. Keep successful writes out of the transcript so the
          // same list is not shown twice; non-TUI modes retain the receipt.
          if (currentCtx?.mode === "tui") return [];
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
      const todos = Array.isArray(params?.todos) ? params.todos : [];
      if (todos.length === 0) {
        const message =
          "todos must be a non-empty array. Pass the full list to replace; use at least one item.";
        return textResult(message, true, { message });
      }

      let inProgress = 0;
      for (const item of todos) {
        if (item?.status === "in_progress") inProgress++;
      }
      if (inProgress > 1) {
        const message = `todos may have at most one in_progress item (got ${inProgress}). Mark other active work completed/blocked/cancelled/pending first.`;
        return textResult(message, true, { message });
      }

      const view = buildTodoList(todos);
      if (view.total === 0) {
        const message =
          "todos produced no renderable items. Each entry needs non-empty content (or title/text).";
        return textResult(message, true, { message });
      }

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
      "Read back the current session todo list. Use when returning to long-running work or after compaction to recover what is done and what remains.",
    promptSnippet:
      "Read back the current session todo list (use after compaction or when resuming long work).",
    promptGuidelines: [
      "Call todo_read when resuming long-running work or after compaction, rather than assuming the remembered plan is still accurate.",
    ],
    parameters: Type.Object({}),
    executionMode: "sequential",
    ...withApexPresentation({
      renderShell: "self" as const,
    renderResult(
        result: { content?: unknown; details?: TodoDetails; isError?: boolean },
        options: { expanded: boolean; isPartial: boolean },
        theme: StatusTheme,
        context: ToolRenderContext<{ hasResult?: boolean }, unknown>,
      ) {
        context.state.hasResult = true;
        const payload = todoPayload(result);
        return new WidthText((width) => {
          const view = payload?.view;
          if (!view) {
            return [
              receiptHeader(theme, width, {
                tool: "todo_read",
                kind: "unknown",
                subject: safeLine(payload?.message ?? textContent(result), 300),
                rootGlyph: TREE.receipt,
              }),
            ];
          }
          if (currentCtx?.mode === "tui") return [];
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
