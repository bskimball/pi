import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { default: todoList } = await import("../todo-list.ts");

function registeredTools(session?: Record<string, unknown>): any[] {
  const previousApexUi = process.env.PI_APEX_UI;
  process.env.PI_APEX_UI = "1";
  try {
    const tools: any[] = [];
    const listeners: Record<string, Array<(event: unknown, ctx: unknown) => void>> = {};
    todoList({
      registerTool(definition: any) {
        tools.push(definition);
      },
      registerShortcut() {},
      registerCommand() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => void) {
        (listeners[event] ??= []).push(handler);
      },
    } as any);
    if (session) {
      for (const handler of listeners.session_start ?? []) {
        handler({}, session);
      }
    }
    return tools;
  } finally {
    if (previousApexUi === undefined) delete process.env.PI_APEX_UI;
    else process.env.PI_APEX_UI = previousApexUi;
  }
}

const theme = {
  fg: (_key: string, text: string) => text,
  bg: (_key: string, text: string) => text,
};

function context(args: any, overrides: Record<string, unknown> = {}): any {
  return {
    args,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    invalidate() {},
    ...overrides,
  };
}

describe("todo receipts", () => {
  it("styles todo_write and todo_read through Apex chrome, not the boxed default", () => {
    const tools = registeredTools();
    const write = tools.find((tool) => tool.name === "todo_write");
    const read = tools.find((tool) => tool.name === "todo_read");
    assert.ok(write, "todo_write registered");
    assert.ok(read, "todo_read registered");

    for (const tool of [write, read]) {
      assert.equal(tool.renderShell, "self", `${tool.name} renderShell`);
      assert.equal(typeof tool.renderCall, "function", `${tool.name} renderCall`);
      assert.equal(typeof tool.renderResult, "function", `${tool.name} renderResult`);
    }

    const writeArgs = {
      todos: [{ content: "Inspect the screenshot", status: "in_progress" }],
    };
    const writeCtx = context(writeArgs);
    const writeCall = write.renderCall(writeArgs, theme, writeCtx).render(80).join("\n");
    assert.match(writeCall, /todo_write/);
    assert.match(writeCall, /1 item/);
    assert.doesNotMatch(writeCall, /┌|┐|└|┘|│/);

    const writeResult = {
      content: [{ type: "text", text: "0/1 done · Inspect the screenshot" }],
      details: {
        view: {
          title: "",
          items: [
            {
              id: "inspect",
              title: "Inspect the screenshot",
              status: "in_progress",
            },
          ],
          counts: {
            pending: 0,
            in_progress: 1,
            blocked: 0,
            completed: 0,
            cancelled: 0,
          },
          total: 1,
          done: 0,
          activeIndex: 0,
          anchorIndex: 0,
          dropped: 0,
        },
      },
    };
    const writeRendered = write
      .renderResult(writeResult, { expanded: false, isPartial: false }, theme, writeCtx)
      .render(80)
      .join("\n");
    assert.match(writeRendered, /todos/);
    assert.match(writeRendered, /Inspect the screenshot/);
    assert.doesNotMatch(writeRendered, /┌|┐|└|┘/);

    const readCtx = context({});
    const readCall = read.renderCall({}, theme, readCtx).render(80).join("\n");
    assert.match(readCall, /todo_read/);
    assert.match(readCall, /\u25cf/);
    assert.doesNotMatch(readCall, /┌|┐|└|┘|│/);

    const emptyRead = {
      content: [
        {
          type: "text",
          text: "No todo list for this session yet. Use todo_write to create one.",
        },
      ],
      details: {
        message: "No todo list for this session yet. Use todo_write to create one.",
      },
    };
    const emptyRendered = read
      .renderResult(emptyRead, { expanded: false, isPartial: false }, theme, readCtx)
      .render(80);
    const emptyText = emptyRendered.join("\n");
    assert.match(emptyText, /todo_read/);
    assert.match(emptyText, /no todos yet/);
    assert.match(emptyText, /todo_write to start a plan/);
    assert.doesNotMatch(emptyText, /No todo list for this session yet/);
    assert.doesNotMatch(emptyText, /┌|┐|└|┘/);
    assert.ok(emptyRendered.every((line: string) => line.length <= 80));

    const populatedRead = {
      content: [{ type: "text", text: "0/1 done · Inspect the screenshot" }],
      details: writeResult.details,
    };
    const populatedCtx = context({});
    const populatedRendered = read
      .renderResult(
        populatedRead,
        { expanded: false, isPartial: false },
        theme,
        populatedCtx,
      )
      .render(80)
      .join("\n");
    assert.match(populatedRendered, /todos/);
    assert.match(populatedRendered, /Inspect the screenshot/);
    assert.doesNotMatch(populatedRendered, /┌|┐|└|┘/);

    const errorCtx = context({}, { isError: true });
    const errorRendered = read
      .renderResult(
        {
          content: [{ type: "text", text: "todo_read failed" }],
          details: { message: "todo_read failed" },
          isError: true,
        },
        { expanded: false, isPartial: false },
        theme,
        errorCtx,
      )
      .render(80)
      .join("\n");
    assert.match(errorRendered, /todo_read/);
    assert.match(errorRendered, /todo_read failed/);
    assert.doesNotMatch(errorRendered, /┌|┐|└|┘/);
  });

  it("blanks the original call component once the result receipt exists", () => {
    const tools = registeredTools();
    const cases = [
      {
        tool: tools.find((tool) => tool.name === "todo_write"),
        args: { todos: [{ content: "Inspect", status: "in_progress" }] },
      },
      {
        tool: tools.find((tool) => tool.name === "todo_read"),
        args: {},
      },
    ];

    for (const { tool, args } of cases) {
      const ctx = context(args);
      const callComponent = tool.renderCall(args, theme, ctx);
      assert.match(callComponent.render(80).join("\n"), new RegExp(tool.name));

      tool.renderResult(
        {
          content: [{ type: "text", text: "empty" }],
          details: { message: "empty" },
        },
        { expanded: false, isPartial: false },
        theme,
        ctx,
      );
      assert.deepEqual(callComponent.render(80), [], `${tool.name} call is blanked`);
    }
  });

  it("keeps a compact Apex receipt for TUI todo tools instead of a blank fallback", () => {
    const tools = registeredTools({
      mode: "tui",
      hasUI: true,
      ui: { setWidget() {}, notify() {} },
    });
    const write = tools.find((tool) => tool.name === "todo_write");
    const read = tools.find((tool) => tool.name === "todo_read");
    const details = {
      view: {
        title: "",
        items: [
          {
            id: "inspect",
            title: "Inspect the screenshot",
            status: "in_progress",
          },
        ],
        counts: {
          pending: 0,
          in_progress: 1,
          blocked: 0,
          completed: 0,
          cancelled: 0,
        },
        total: 1,
        done: 0,
        activeIndex: 0,
        anchorIndex: 0,
        dropped: 0,
      },
    };
    const result = {
      content: [{ type: "text", text: "0/1 done · Inspect the screenshot" }],
      details,
    };

    for (const tool of [write, read]) {
      const rendered = tool
        .renderResult(result, { expanded: false, isPartial: false }, theme, context({}))
        .render(80);
      const text = rendered.join("\n");
      assert.equal(rendered.length, 1, `${tool.name} stays one compact row`);
      assert.match(text, new RegExp(tool.name));
      assert.match(text, /0\/1 done/);
      assert.match(text, /Inspect the screenshot/);
      assert.match(text, /\u2713/);
      assert.doesNotMatch(text, /┌|┐|└|┘/);
      assert.doesNotMatch(text, /\u25cb|\u25cf/);
    }
  });
});
