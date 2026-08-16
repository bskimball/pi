import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";

const { installTodoTools, reconstructTodoState } = await import(
  "../internal/todo/todo-tools.ts"
);
const { buildTodoList, renderTodoList } = await import(
  "../internal/todo/todo-view.ts"
);

function createMockPi(apexUi = "1") {
  const previousApexUi = process.env.PI_APEX_UI;
  process.env.PI_APEX_UI = apexUi;
  try {
    const tools: any[] = [];
    const shortcuts = new Map<string, any>();
    const commands = new Map<string, any>();
    const listeners = new Map<string, Array<(event: any, ctx: any) => void>>();

    const pi = {
      registerTool(definition: any) {
        tools.push(definition);
      },
      registerShortcut(shortcut: string, definition: any) {
        shortcuts.set(shortcut, definition);
      },
      registerCommand(command: string, definition: any) {
        commands.set(command, definition);
      },
      on(event: string, handler: (event: any, ctx: any) => void) {
        const list = listeners.get(event) ?? [];
        list.push(handler);
        listeners.set(event, list);
      },
    };

    installTodoTools(pi as any);

    return {
      tools,
      shortcuts,
      commands,
      listeners,
      emit(event: string, eventData: any, ctx: any) {
        for (const handler of listeners.get(event) ?? []) {
          handler(eventData, ctx);
        }
      },
    };
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

const sampleView = {
  title: "",
  items: [
    { id: "inspect", title: "Inspect the screenshot", status: "in_progress" },
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
};

describe("apex todo receipts and tools", () => {
  it("styles todo_write and todo_read through Apex chrome, not boxed default", () => {
    const mock = createMockPi("1");
    const write = mock.tools.find((tool) => tool.name === "todo_write");
    const read = mock.tools.find((tool) => tool.name === "todo_read");
    assert.ok(write, "todo_write registered");
    assert.ok(read, "todo_read registered");
    assert.equal(mock.tools.length, 2, "exactly two tools registered");

    for (const tool of [write, read]) {
      assert.equal(tool.renderShell, "self", `${tool.name} renderShell`);
      assert.equal(typeof tool.renderCall, "function", `${tool.name} renderCall`);
      assert.equal(
        typeof tool.renderResult,
        "function",
        `${tool.name} renderResult`,
      );
    }

    const writeArgs = {
      todos: [{ content: "Inspect the screenshot", status: "in_progress" }],
    };
    const writeCtx = context(writeArgs);
    const writeCall = write
      .renderCall(writeArgs, theme, writeCtx)
      .render(80)
      .join("\n");
    assert.match(writeCall, /todo_write/);
    assert.match(writeCall, /1 item/);
    assert.doesNotMatch(writeCall, /┌|┐|└|┘|│/);

    const writeResult = {
      content: [{ type: "text", text: "0/1 done · Inspect the screenshot" }],
      details: { view: sampleView },
    };
    const writeRendered = write
      .renderResult(
        writeResult,
        { expanded: false, isPartial: false },
        theme,
        writeCtx,
      )
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
        message:
          "No todo list for this session yet. Use todo_write to create one.",
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
    assert.ok(
      emptyRendered.every((line: string) => safeVisibleWidth(line) <= 80),
    );
  });

  it("blanks the original call component once the result receipt exists", () => {
    const mock = createMockPi("1");
    const write = mock.tools.find((tool) => tool.name === "todo_write");
    const read = mock.tools.find((tool) => tool.name === "todo_read");

    for (const { tool, args } of [
      {
        tool: write,
        args: { todos: [{ content: "Inspect", status: "in_progress" }] },
      },
      { tool: read, args: {} },
    ]) {
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
      assert.deepEqual(
        callComponent.render(80),
        [],
        `${tool.name} call is blanked`,
      );
    }
  });

  it("gates UI chrome and widget when PI_APEX_UI=0 but keeps tool registration and execution", async () => {
    const mock = createMockPi("0");
    const write = mock.tools.find((tool) => tool.name === "todo_write");
    const read = mock.tools.find((tool) => tool.name === "todo_read");

    assert.ok(write && read, "both todo tools register under PI_APEX_UI=0");
    assert.equal(write.renderShell, undefined, "write renderShell undefined");
    assert.equal(write.renderCall, undefined, "write renderCall undefined");
    assert.equal(write.renderResult, undefined, "write renderResult undefined");
    assert.equal(read.renderShell, undefined, "read renderShell undefined");
    assert.equal(read.renderCall, undefined, "read renderCall undefined");
    assert.equal(read.renderResult, undefined, "read renderResult undefined");

    assert.equal(
      mock.shortcuts.has("alt+t"),
      false,
      "alt+t not registered when presentation off",
    );
    assert.equal(
      mock.commands.has("todos"),
      false,
      "todos command not registered when presentation off",
    );

    let widgetMounted = false;
    const tuiCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget() {
          widgetMounted = true;
        },
        notify() {},
      },
    } as any;

    const res = await write.execute(
      "call_1",
      { todos: [{ content: "Headless step", status: "in_progress" }] },
      undefined,
      undefined,
      tuiCtx,
    );
    assert.equal(res.isError, false);
    assert.equal(widgetMounted, false, "no widget mounted when PI_APEX_UI=0");

    const readRes = await read.execute(
      "call_2",
      {},
      undefined,
      undefined,
      tuiCtx,
    );
    assert.equal(readRes.isError, false);
    assert.match(readRes.content[0].text, /\[in_progress\] Headless step/);
  });
});

describe("todo validation and atomicity", () => {
  it("rejects non-array and empty todos atomically", async () => {
    const mock = createMockPi("1");
    const write = mock.tools.find((tool) => tool.name === "todo_write");
    const ctx = { mode: "noninteractive", hasUI: false } as any;

    const resEmpty = await write.execute(
      "t",
      { todos: [] },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(resEmpty.isError, true);
    assert.match(resEmpty.content[0].text, /non-empty array/);

    const resNull = await write.execute(
      "t",
      { todos: null as any },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(resNull.isError, true);
  });

  it("rejects malformed or empty content items atomically with 1-based index", async () => {
    const mock = createMockPi("1");
    const write = mock.tools.find((tool) => tool.name === "todo_write");
    const read = mock.tools.find((tool) => tool.name === "todo_read");
    const ctx = { mode: "noninteractive", hasUI: false } as any;

    // Seed a valid state first
    await write.execute(
      "t",
      { todos: [{ content: "Initial plan", status: "in_progress" }] },
      undefined,
      undefined,
      ctx,
    );

    // Rejection at index 2
    const resBadContent = await write.execute(
      "t",
      {
        todos: [
          { content: "Valid step 1", status: "completed" },
          { content: "   ", status: "in_progress" },
          { content: "Valid step 3", status: "pending" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(resBadContent.isError, true);
    assert.match(resBadContent.content[0].text, /todo 2 requires non-empty content/);

    // Verify state was NOT mutated
    const readAfter = await read.execute("t", {}, undefined, undefined, ctx);
    assert.match(readAfter.content[0].text, /Initial plan/);
    assert.doesNotMatch(readAfter.content[0].text, /Valid step 1/);
  });

  it("rejects unknown statuses and unapproved aliases atomically with index", async () => {
    const mock = createMockPi("1");
    const write = mock.tools.find((tool) => tool.name === "todo_write");
    const ctx = { mode: "noninteractive", hasUI: false } as any;

    const aliases = ["doing", "running", "done", "complete", "dropped", "random"];
    for (const status of aliases) {
      const res = await write.execute(
        "t",
        {
          todos: [
            { content: "Step 1", status: "pending" },
            { content: "Step 2", status },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(res.isError, true, `status "${status}" rejected`);
      assert.match(res.content[0].text, /todo 2 has invalid status/);
    }
  });

  it("enforces at most one in_progress item", async () => {
    const mock = createMockPi("1");
    const write = mock.tools.find((tool) => tool.name === "todo_write");
    const ctx = { mode: "noninteractive", hasUI: false } as any;

    const res = await write.execute(
      "t",
      {
        todos: [
          { content: "Step 1", status: "in_progress" },
          { content: "Step 2", status: "in_progress" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /at most one in_progress/);
  });


  it("rejects 201 items before mutation and leaves prior list unchanged", async () => {
    const mock = createMockPi("1");
    const write = mock.tools.find((tool) => tool.name === "todo_write");
    const read = mock.tools.find((tool) => tool.name === "todo_read");
    const ctx = { mode: "noninteractive", hasUI: false } as any;

    await write.execute(
      "t",
      { todos: [{ content: "Keep me", status: "pending" }] },
      undefined,
      undefined,
      ctx,
    );

    const overflow = Array.from({ length: 201 }, (_, i) => ({
      content: `Item ${i + 1}`,
      status: "pending",
    }));
    const res = await write.execute(
      "t",
      { todos: overflow },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /at most 200 items/);
    assert.match(res.content[0].text, /201/);

    const after = await read.execute("r", {}, undefined, undefined, ctx);
    assert.equal(after.isError, false);
    assert.match(after.content[0].text, /Keep me/);
    assert.doesNotMatch(after.content[0].text, /Item 1/);
  });

  it("accepts all canonical statuses and preserves items without dropping", async () => {
    const mock = createMockPi("1");
    const write = mock.tools.find((tool) => tool.name === "todo_write");
    const read = mock.tools.find((tool) => tool.name === "todo_read");
    const ctx = { mode: "noninteractive", hasUI: false } as any;

    const payload = {
      todos: [
        { id: "s1", content: "Step 1", status: "completed", note: "done" },
        { id: "s2", content: "Step 2", status: "in_progress" },
        { id: "s3", content: "Step 3", status: "blocked", note: "waiting" },
        { id: "s4", content: "Step 4", status: "pending" },
        { id: "s5", content: "Step 5", status: "cancelled" },
      ],
    };

    const writeRes = await write.execute("t", payload, undefined, undefined, ctx);
    assert.equal(writeRes.isError, false);
    assert.match(writeRes.content[0].text, /2\/5 done · Step 2/);

    const readRes = await read.execute("t", {}, undefined, undefined, ctx);
    assert.equal(readRes.isError, false);
    const readText = readRes.content[0].text;
    assert.match(readText, /\[completed\] Step 1 · done/);
    assert.match(readText, /\[in_progress\] Step 2/);
    assert.match(readText, /\[blocked\] Step 3 · waiting/);
    assert.match(readText, /\[pending\] Step 4/);
    assert.match(readText, /\[cancelled\] Step 5/);
  });
});

describe("todo lifecycle state recovery", () => {
  it("reconstructs todo state from branch toolResult details on session resume", async () => {
    const mock = createMockPi("1");
    const read = mock.tools.find((tool) => tool.name === "todo_read");

    let widgetContent: any;
    const sessionCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget(_key: string, component: any) {
          widgetContent = component;
        },
        notify() {},
      },
      sessionManager: {
        getBranch() {
          return [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: "todo_write",
                isError: false,
                details: {
                  view: {
                    title: "Resume Mission",
                    items: [
                      { id: "t1", title: "Recovered task", status: "in_progress" },
                    ],
                  },
                },
              },
            },
          ];
        },
      },
    } as any;

    mock.emit("session_start", { reason: "resume" }, sessionCtx);

    const readRes = await read.execute("t", {}, undefined, undefined, sessionCtx);
    assert.match(readRes.content[0].text, /Recovered task/);
    assert.ok(widgetContent, "widget mounted on resume in TUI mode");
  });

  it("reconstructs todo state from assistant toolCall fallback if details stripped", async () => {
    const mock = createMockPi("1");
    const read = mock.tools.find((tool) => tool.name === "todo_read");

    const sessionCtx = {
      mode: "noninteractive",
      hasUI: false,
      sessionManager: {
        getBranch() {
          return [
            {
              type: "message",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "call_abc",
                    name: "todo_write",
                    arguments: {
                      todos: [
                        { content: "Tool call fallback item", status: "pending" },
                      ],
                    },
                  },
                ],
              },
            },
            {
              type: "message",
              message: {
                role: "toolResult",
                toolCallId: "call_abc",
                toolName: "todo_write",
                isError: false,
                details: {}, // empty details
              },
            },
          ];
        },
      },
    } as any;

    mock.emit("session_start", { reason: "reload" }, sessionCtx);

    const readRes = await read.execute("t", {}, undefined, undefined, sessionCtx);
    assert.match(readRes.content[0].text, /Tool call fallback item/);
  });

  it("clears state on fresh session startup and shutdown", async () => {
    const mock = createMockPi("1");
    const write = mock.tools.find((tool) => tool.name === "todo_write");
    const read = mock.tools.find((tool) => tool.name === "todo_read");
    const ctx = { mode: "noninteractive", hasUI: false } as any;

    await write.execute(
      "t",
      { todos: [{ content: "Pre-shutdown item", status: "in_progress" }] },
      undefined,
      undefined,
      ctx,
    );

    mock.emit("session_shutdown", {}, ctx);
    const readAfterShutdown = await read.execute("t", {}, undefined, undefined, ctx);
    assert.match(readAfterShutdown.content[0].text, /No todo list for this session yet/);

    mock.emit("session_start", { reason: "new" }, ctx);
    const readAfterNew = await read.execute("t", {}, undefined, undefined, ctx);
    assert.match(readAfterNew.content[0].text, /No todo list for this session yet/);
  });
});

describe("todo width bounds and hostile input safety", () => {
  it("enforces safeVisibleWidth bounds across widths with hostile Unicode and control characters", () => {
    const hostileItems = [
      {
        content:
          "Wide CJK 한국어와 日本語 text \u0000\u0007 with ANSI \u001b[31mred\u001b[0m and \t tabs",
        status: "in_progress",
        note: "ZeroWidth\u200b\u200c\u200dJoiner and emoji 👩‍👩‍👧‍👦🚀",
      },
      {
        content: "Combining accents e\u0301 a\u0300 u\u0308 and long token " + "x".repeat(120),
        status: "blocked",
        note: "detail\u001b[0m\u001b[32m text",
      },
      {
        content: "Short pending",
        status: "pending",
      },
    ];

    const view = buildTodoList(hostileItems, {
      title: "Hostile \u001b[1mTitle\u001b[0m with \u0000 bytes",
    });

    for (const width of [40, 60, 80, 100, 120]) {
      for (const collapsed of [true, false]) {
        const lines = renderTodoList(theme, width, view, {
          collapsed,
          toggleHint: "alt+t",
        });
        for (const line of lines) {
          const visibleWidth = safeVisibleWidth(line);
          assert.ok(
            visibleWidth <= width,
            `Line "${line}" visible width ${visibleWidth} exceeds budget ${width}`,
          );
        }
      }
    }
  });
});
