// Standalone session todo-list extension. Uses Pi's stock tool rendering and a
// small plain-text above-editor widget; no Apex presentation dependency.

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface TodoWriteParams {
  todos: Array<{ content: string; status: string; id?: string; note?: string }>;
}

type TodoStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";
type TodoItem = { id: string; content: string; status: TodoStatus; note?: string };

const STATUSES = new Set<TodoStatus>([
  "pending", "in_progress", "blocked", "completed", "cancelled",
]);
const READ_ITEM_CAP = 50;
const READ_LINE_CHARS = 240;

function clean(value: unknown, cap: number): string {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length <= cap ? text : `${text.slice(0, Math.max(0, cap - 3))}...`;
}

function textResult(text: string, isError = false, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details, isError };
}

function summary(items: TodoItem[]): string {
  const done = items.filter((item) => item.status === "completed").length;
  const active = items.find((item) => item.status === "in_progress");
  return `${done}/${items.length} done${active ? ` · ${clean(active.content, 80)}` : ""}`;
}

function serialize(items: TodoItem[]): string {
  const lines = [summary(items)];
  for (const item of items.slice(0, READ_ITEM_CAP)) {
    lines.push(clean(`[${item.status}] ${item.content}${item.note ? ` · ${item.note}` : ""}`, READ_LINE_CHARS));
  }
  if (items.length > READ_ITEM_CAP) lines.push(`... ${items.length - READ_ITEM_CAP} more items`);
  return lines.join("\n");
}

function panelLines(items: TodoItem[], collapsed: boolean): string[] {
  const glyph: Record<TodoStatus, string> = {
    pending: "[ ]", in_progress: "[>]", blocked: "[!]", completed: "[x]", cancelled: "[-]",
  };
  const limit = collapsed ? 5 : 9;
  const active = Math.max(0, items.findIndex((item) => item.status === "in_progress"));
  const start = Math.max(0, Math.min(active - Math.floor(limit / 2), Math.max(0, items.length - limit)));
  const visible = items.slice(start, start + limit);
  const lines = [`Todos (${summary(items)})  alt+t`];
  for (const item of visible) lines.push(`${glyph[item.status]} ${clean(item.content, 180)}`);
  if (visible.length < items.length) lines.push(`... ${items.length - visible.length} more`);
  return lines;
}

export default function (pi: ExtensionAPI): void {
  let current: TodoItem[] | undefined;
  let currentCtx: ExtensionContext | undefined;
  let collapsed = false;
  const PANEL_KEY = "todo-list";

  function renderPanel(): void {
    if (!current || !currentCtx?.hasUI || currentCtx.mode !== "tui") return;
    try { currentCtx.ui.setWidget(PANEL_KEY, panelLines(current, collapsed), { placement: "aboveEditor" }); } catch {}
  }
  function clearPanel(): void {
    try { currentCtx?.ui.setWidget(PANEL_KEY, undefined); } catch {}
  }

  pi.on("session_start", (_event, ctx) => {
    clearPanel(); current = undefined; currentCtx = ctx; collapsed = false;
  });
  pi.on("session_shutdown", () => { clearPanel(); current = undefined; currentCtx = undefined; });
  pi.registerShortcut("alt+t", {
    description: "Collapse or expand the todo panel",
    handler: (ctx) => {
      currentCtx = ctx;
      if (!current) return void ctx.ui.notify("No todo list for this session yet.", "info");
      collapsed = !collapsed; renderPanel();
    },
  });
  pi.registerCommand("todos", {
    description: "Collapse or expand the todo panel above the input",
    handler: async (_args, ctx) => {
      currentCtx = ctx;
      if (!current) return void ctx.ui.notify("No todo list for this session yet.", "info");
      collapsed = !collapsed; renderPanel();
    },
  });

  pi.registerTool({
    name: "todo_write", label: "Todo Write", executionMode: "sequential",
    description: "Replace the session todo list with the complete plan. Keep at most one item in_progress.",
    promptSnippet: "Plan multi-step work before the first edit; one in_progress, blocked when waiting, complete promptly.",
    promptGuidelines: [
      "Call todo_write before the first edit for 3+ steps, multiple files, delegation, or several requests.",
      "Each call replaces the whole list. Keep at most one in_progress and preserve exact content text.",
      "Do not mark work completed until its required verification is finished.",
    ],
    parameters: Type.Object({ todos: Type.Array(Type.Object({
      content: Type.String(), status: Type.String({ enum: [...STATUSES] }),
      id: Type.Optional(Type.String()), note: Type.Optional(Type.String()),
    }), { minItems: 1 }) }),
    async execute(_id, params: TodoWriteParams, _signal, _update, ctx) {
      const todos = Array.isArray(params?.todos) ? params.todos : [];
      if (!todos.length) return textResult("todos must be a non-empty array.", true);
      if (todos.filter((item) => item?.status === "in_progress").length > 1) {
        return textResult("todos may have at most one in_progress item.", true);
      }
      const next: TodoItem[] = [];
      for (let index = 0; index < todos.length; index++) {
        const item = todos[index];
        const content = clean(item?.content, 500);
        if (!content) return textResult(`todo ${index + 1} requires non-empty content.`, true);
        if (!STATUSES.has(item.status as TodoStatus)) return textResult(`todo ${index + 1} has invalid status.`, true);
        next.push({ id: clean(item.id, 80) || String(index + 1), content, status: item.status as TodoStatus, note: clean(item.note, 240) || undefined });
      }
      current = next; currentCtx = ctx; renderPanel();
      return textResult(summary(current), false, { todos: current });
    },
  });

  pi.registerTool({
    name: "todo_read", label: "Todo Read", executionMode: "sequential",
    description: "Read the current session todo list, especially after compaction or resume.",
    promptSnippet: "Read back the current session todo list.",
    parameters: Type.Object({}),
    async execute() {
      if (!current) return textResult("No todo list for this session yet. Use todo_write to create one.");
      return textResult(serialize(current), false, { todos: current });
    },
  });
}
