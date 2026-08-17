import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeVisibleWidth } from "../internal/presentation/safe-text-layout.ts";

const { installTodoTools, reconstructTodoState } = await import(
  "../internal/todo/todo-tools.ts"
);
const {
  TODO_LIST_MAX_LINES,
  buildTodoList,
  renderPlainTodoList,
  renderTodoList,
} = await import("../internal/todo/todo-view.ts");

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

  it("gates tool chrome/shortcuts/commands when PI_APEX_UI=0 and mounts plain persistent widget after state exists", async () => {
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

    let mountedKey: string | undefined;
    let mountedComponent: any;
    let mountedOptions: any;
    const tuiCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget(key: string, component: any, options?: any) {
          mountedKey = key;
          mountedComponent = component;
          mountedOptions = options;
        },
        notify() {},
      },
    } as any;

    // Prior to any todo state, no widget is mounted
    assert.equal(mountedComponent, undefined, "no widget mounted before state exists");

    // Calling todo_read in empty state returns expected text and keeps widget unmounted
    const emptyReadRes = await read.execute("call_0", {}, undefined, undefined, tuiCtx);
    assert.equal(emptyReadRes.isError, false);
    assert.match(emptyReadRes.content[0].text, /No todo list for this session yet/);
    assert.equal(mountedComponent, undefined, "no widget mounted on empty read");

    // Creating initial plan mounts plain widget
    const res = await write.execute(
      "call_1",
      {
        todos: [
          { content: "Headless step", status: "in_progress" },
          { content: "Follow-up step", status: "pending", note: "next" },
        ],
      },
      undefined,
      undefined,
      tuiCtx,
    );
    assert.equal(res.isError, false);
    assert.equal(mountedKey, "todo-list");
    assert.deepEqual(mountedOptions, { placement: "aboveEditor" });

    // Render plain widget lines
    const getLines = (width = 80): string[] => {
      const comp =
        typeof mountedComponent === "function"
          ? mountedComponent(null, theme)
          : mountedComponent;
      return comp?.render ? comp.render(width) : [];
    };

    const initialLines = getLines(80);
    assert.ok(initialLines.length > 0, "plain widget renders lines");
    assert.ok(
      initialLines.every((line: string) => !/\u001b\[/.test(line)),
      "plain widget has no ANSI escape codes",
    );
    assert.ok(
      initialLines.every((line: string) => safeVisibleWidth(line) <= 80),
      "all plain widget lines within width budget",
    );
    assert.match(initialLines[0], /^Todos \(0\/2 done\)$/);
    assert.match(initialLines[1], /^\[>\] Headless step$/);
    assert.match(initialLines[2], /^\[ \] Follow-up step · next$/);

    // Updating plan updates plain widget
    const updateRes = await write.execute(
      "call_2",
      {
        todos: [
          { content: "Headless step", status: "completed" },
          { content: "Follow-up step", status: "in_progress", note: "active" },
        ],
      },
      undefined,
      undefined,
      tuiCtx,
    );
    assert.equal(updateRes.isError, false);

    const updatedLines = getLines(80);
    assert.ok(
      updatedLines.every((line: string) => !/\u001b\[/.test(line)),
      "updated plain widget has no ANSI",
    );
    assert.ok(
      updatedLines.every((line: string) => safeVisibleWidth(line) <= 80),
      "updated plain widget within width budget",
    );
    assert.match(updatedLines[0], /^Todos \(1\/2 done\)$/);
    assert.match(updatedLines[1], /^\[x\] Headless step$/);
    assert.match(updatedLines[2], /^\[>\] Follow-up step · active$/);

    // Reading back state in disabled mode returns model text
    const readRes = await read.execute("call_3", {}, undefined, undefined, tuiCtx);
    assert.equal(readRes.isError, false);
    assert.match(readRes.content[0].text, /1\/2 done/);
    assert.match(readRes.content[0].text, /\[completed\] Headless step/);
    assert.match(readRes.content[0].text, /\[in_progress\] Follow-up step · active/);
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

  it("reconstructs and mounts plain widget under PI_APEX_UI=0 on session resume and clears on shutdown", async () => {
    const mock = createMockPi("0");
    const read = mock.tools.find((tool) => tool.name === "todo_read");

    let mountedKey: string | undefined;
    let mountedComponent: any;
    let mountedOptions: any;
    const sessionCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget(key: string, component: any, options?: any) {
          mountedKey = key;
          mountedComponent = component;
          mountedOptions = options;
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
                    title: "Recovered Plan",
                    items: [
                      { id: "t1", title: "Resumed headless task", status: "in_progress" },
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

    assert.equal(mountedKey, "todo-list");
    assert.deepEqual(mountedOptions, { placement: "aboveEditor" });
    assert.ok(mountedComponent, "plain widget mounted on resume in TUI mode");

    const comp =
      typeof mountedComponent === "function"
        ? mountedComponent(null, theme)
        : mountedComponent;
    const lines = comp.render(80);
    assert.ok(
      lines.every((line: string) => !/\u001b\[/.test(line)),
      "no ANSI in reconstructed plain widget",
    );
    assert.ok(
      lines.every((line: string) => safeVisibleWidth(line) <= 80),
      "reconstructed plain widget within width budget",
    );
    assert.match(lines[0], /^Todos: Recovered Plan \(0\/1 done\)$/);
    assert.match(lines[1], /^\[>\] Resumed headless task$/);

    const readRes = await read.execute("t", {}, undefined, undefined, sessionCtx);
    assert.match(readRes.content[0].text, /Resumed headless task/);

    // session_tree event also updates the plain widget
    mock.emit("session_tree", {}, sessionCtx);
    assert.equal(mountedKey, "todo-list");
    assert.ok(mountedComponent, "plain widget remounted on session_tree");

    // session_shutdown clears the widget
    mock.emit("session_shutdown", {}, sessionCtx);
    assert.equal(mountedComponent, undefined, "widget cleared on shutdown");

    // session_start with "new" clears state
    mock.emit("session_start", { reason: "new" }, sessionCtx);
    assert.equal(mountedComponent, undefined, "widget remains cleared on fresh new session");
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

describe("renderPlainTodoList (PI_APEX_UI=0 persistent widget)", () => {
  const plainView = (
    items: Array<Record<string, unknown>>,
    title?: string,
  ) => buildTodoList(items, title === undefined ? {} : { title });

  const WIDTHS = [1, 4, 8, 20, 40, 80];

  it("keeps every line within the width budget at 1/4/8/20/40/80 columns", () => {
    const view = plainView(
      [
        { content: "Read the Observatory conventions", status: "completed" },
        {
          content:
            "Render bounded rows that keep working past the right edge of a very narrow terminal",
          status: "in_progress",
          note: "width-safety pass over the plain fallback renderer",
        },
        { content: "Blocked on theme tokens", status: "blocked", note: "waiting" },
        { content: "Ship the harness", status: "pending" },
        { content: "Abandoned branch", status: "cancelled" },
      ],
      "Ship the fallback",
    );

    for (const width of WIDTHS) {
      const lines = renderPlainTodoList(view, width);
      assert.ok(lines.length > 0, `width ${width} renders at least one line`);
      for (const line of lines) {
        const visibleWidth = safeVisibleWidth(line);
        assert.ok(
          visibleWidth <= width,
          `width ${width}: "${line}" measured ${visibleWidth}`,
        );
      }
      assert.ok(
        lines.length <= TODO_LIST_MAX_LINES,
        `width ${width} within ${TODO_LIST_MAX_LINES} lines`,
      );
    }
  });

  it("renders an empty list as a single bounded header at every width", () => {
    const empty = plainView([], "Nothing Yet");
    for (const width of WIDTHS) {
      const lines = renderPlainTodoList(empty, width);
      assert.equal(lines.length, 1, `width ${width} empty list is one line`);
      assert.ok(safeVisibleWidth(lines[0]) <= width);
    }
    assert.equal(renderPlainTodoList(empty, 80)[0], "Todos: Nothing Yet (empty)");
    assert.equal(renderPlainTodoList(plainView([]), 80)[0], "Todos (empty)");
    assert.deepEqual(renderPlainTodoList(empty, 0), [], "width 0 renders nothing");
  });

  it("stays under TODO_LIST_MAX_LINES with 200 items and windows on the active item", () => {
    const items = Array.from({ length: 200 }, (_, index) => ({
      content: `Item ${index + 1}`,
      status: index === 150 ? "in_progress" : index < 150 ? "completed" : "pending",
    }));
    const view = plainView(items);
    assert.equal(view.total, 200);

    for (const width of WIDTHS) {
      const lines = renderPlainTodoList(view, width);
      assert.ok(
        lines.length <= TODO_LIST_MAX_LINES,
        `width ${width}: ${lines.length} lines exceeds ${TODO_LIST_MAX_LINES}`,
      );
      for (const line of lines) {
        assert.ok(safeVisibleWidth(line) <= width, `width ${width}: "${line}"`);
      }
    }

    const wide = renderPlainTodoList(view, 80);
    assert.equal(wide[0], "Todos (150/200 done)");
    assert.match(wide[1], /^\.\.\. \d+ earlier$/);
    assert.match(wide[wide.length - 1], /^\.\.\. \d+ more$/);
    assert.ok(
      wide.some((line) => line === "[>] Item 151"),
      "active item stays inside the window",
    );
  });

  it("normalizes hostile ANSI and control input with no escape bytes at any width", () => {
    const view = plainView(
      [
        {
          content:
            "ANSI \u001b[31mred\u001b[0m \u001b]0;title\u0007 with \u0000\u0007\u001b bytes\tand\ttabs",
          status: "in_progress",
          note: "note \u001b[1mbold\u001b[0m \u200b\u200c\u200d zero width",
        },
        {
          content: `Wide CJK 한국어와 日本語 e\u0301 plus long token ${"x".repeat(200)}`,
          status: "blocked",
          note: "emoji 👩‍👩‍👧‍👦🚀 detail",
        },
        { content: "Plain step", status: "pending" },
      ],
      "Hostile \u001b[1mTitle\u001b[0m with \u0000 bytes",
    );

    for (const width of WIDTHS) {
      const lines = renderPlainTodoList(view, width);
      for (const line of lines) {
        assert.ok(
          !line.includes("\u001b"),
          `width ${width}: ESC leaked into "${JSON.stringify(line)}"`,
        );
        // ESC is covered above; C0 controls and DEL must not survive either.
        assert.doesNotMatch(
          line,
          /[\u0000-\u001f\u007f]/,
          `width ${width}: control byte leaked into ${JSON.stringify(line)}`,
        );
        assert.ok(
          safeVisibleWidth(line) <= width,
          `width ${width}: "${line}" exceeds budget`,
        );
      }
      assert.ok(lines.length <= TODO_LIST_MAX_LINES);
    }

    assert.match(renderPlainTodoList(view, 80)[0], /^Todos: Hostile Title with bytes/);
  });

  it("replaces the mounted plain widget on session_tree and clears it for an empty branch", () => {
    const mock = createMockPi("0");

    let mountedKey: string | undefined;
    let mountedComponent: any;
    let branch: any[] = [];
    const branchEntry = (title: string, itemTitle: string) => ({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo_write",
        isError: false,
        details: {
          view: {
            title,
            items: [{ id: "t1", title: itemTitle, status: "in_progress" }],
          },
        },
      },
    });
    const sessionCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget(key: string, component: any) {
          mountedKey = key;
          mountedComponent = component;
        },
        notify() {},
      },
      sessionManager: {
        getBranch() {
          return branch;
        },
      },
    } as any;
    const renderMounted = (width = 80): string[] => {
      const comp =
        typeof mountedComponent === "function"
          ? mountedComponent(null, theme)
          : mountedComponent;
      return comp?.render ? comp.render(width) : [];
    };

    branch = [branchEntry("First Branch", "First branch task")];
    mock.emit("session_tree", {}, sessionCtx);
    assert.equal(mountedKey, "todo-list");
    const first = renderMounted();
    assert.match(first[0], /^Todos: First Branch \(0\/1 done\)$/);
    assert.match(first[1], /^\[>\] First branch task$/);

    // Switching to another branch replaces the rendered state.
    branch = [branchEntry("Second Branch", "Second branch task")];
    mock.emit("session_tree", {}, sessionCtx);
    const second = renderMounted();
    assert.match(second[0], /^Todos: Second Branch \(0\/1 done\)$/);
    assert.match(second[1], /^\[>\] Second branch task$/);
    assert.ok(
      second.every((line: string) => !line.includes("\u001b")),
      "no ANSI after branch switch",
    );
    assert.ok(second.every((line: string) => safeVisibleWidth(line) <= 80));

    // A branch with no todo history clears the widget entirely.
    branch = [];
    mock.emit("session_tree", {}, sessionCtx);
    assert.equal(
      mountedComponent,
      undefined,
      "widget cleared when the branch has no todo state",
    );
  });
});
