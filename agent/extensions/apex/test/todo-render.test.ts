import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { safeVisibleWidth } from "@pi/ui-kit/internal/presentation/safe-text-layout.ts";

const { dockClickResult, installTodoTools } = await import("@pi/ui-kit/internal/todo/todo-tools.ts");
const { publishDockAgents, resetDockAgents } = await import(
  "@pi/ui-kit/internal/todo/fleet-listen.ts"
);
const {
  TODO_LIST_MAX_LINES,
  agentRowAtY,
  buildTodoList,
  canSwitchToSession,
  renderAgentList,
  renderPeekBody,
  renderPlainTodoList,
  renderTodoList,
  turnCountText,
} = await import("@pi/ui-kit/internal/todo/todo-view.ts");

function createMockPi(apexUi = "1") {
  const previousApexUi = process.env.PI_APEX_UI;
  const previousSkin = process.env.PI_UI_SKIN;
  process.env.PI_APEX_UI = apexUi;
  // Pin the apex skin so a leaked PI_UI_SKIN=claude never changes assertions.
  delete process.env.PI_UI_SKIN;
  try {
    const tools: any[] = [];
    const shortcuts = new Map<string, any>();
    const commands = new Map<string, any>();
    const listeners = new Map<string, Array<(event: any, ctx: any) => void>>();
    const eventListeners = new Map<string, Array<(...args: any[]) => void>>();

    const pi = {
      events: { on(name: string, fn: (...args: any[]) => void) {
        const list = eventListeners.get(name) ?? [];
        list.push(fn);
        eventListeners.set(name, list);
      } },
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
      emitEvent(name: string, ...args: any[]) {
        for (const handler of eventListeners.get(name) ?? []) {
          handler(...args);
        }
      },
      latestTool(name: string) {
        const matches = tools.filter((tool) => tool.name === name);
        return matches[matches.length - 1];
      },
    };
  } finally {
    if (previousApexUi === undefined) delete process.env.PI_APEX_UI;
    else process.env.PI_APEX_UI = previousApexUi;
    if (previousSkin === undefined) delete process.env.PI_UI_SKIN;
    else process.env.PI_UI_SKIN = previousSkin;
  }
}

const theme = {
  fg: (_key: string, text: string) => text,
  bg: (_key: string, text: string) => text,
};

// Pin the apex skin for every test in this file: the live shell may export
// PI_UI_SKIN=claude, but these assertions target apex chrome (●/○). Glyphs
// are read dynamically at render time, so the pin must span the test body,
// not just tool installation. Saved/restored around each test.
let previousSkin: string | undefined;
beforeEach(() => {
  previousSkin = process.env.PI_UI_SKIN;
  delete process.env.PI_UI_SKIN;
});
afterEach(() => {
  if (previousSkin === undefined) delete process.env.PI_UI_SKIN;
  else process.env.PI_UI_SKIN = previousSkin;
});

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

    // Controls stay registered (the SDK has no unregister) but refuse while
    // presentation is disabled, keeping the plain widget as the sole surface.
    assert.equal(mock.shortcuts.has("alt+t"), true, "alt+t registered");
    assert.equal(mock.shortcuts.has("alt+a"), true, "alt+a registered");
    assert.equal(mock.commands.has("todos"), true, "todos registered");
    assert.equal(mock.commands.has("agents"), true, "agents registered");

    let mountedKey: string | undefined;
    let mountedComponent: any;
    let mountedOptions: any;
    const notices: string[] = [];
    const tuiCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget(key: string, component: any, options?: any) {
          mountedKey = key;
          mountedComponent = component;
          mountedOptions = options;
        },
        notify(message: string) {
          notices.push(message);
        },
      },
    } as any;

    // Gated controls refuse while disabled instead of touching the panel.
    await mock.commands.get("todos").handler("", tuiCtx);
    await mock.commands.get("agents").handler("", tuiCtx);
    mock.shortcuts.get("alt+t").handler(tuiCtx);
    mock.shortcuts.get("alt+a").handler(tuiCtx);
    assert.equal(notices.length, 4, "each gated control notifies");
    assert.ok(notices.every((text) => /inactive while Apex presentation is disabled/.test(text)));
    assert.equal(mountedComponent, undefined, "gated controls mount nothing");

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

  it("re-registers todo receipts on live presentation switches without losing the plan", async () => {
    const mock = createMockPi("1");
    const previous = process.env.PI_APEX_UI;
    const ctx = { mode: "noninteractive", hasUI: false } as any;
    try {
      const write = mock.latestTool("todo_write");
      assert.equal(typeof write.renderCall, "function", "Apex chrome attached while enabled");
      await write.execute(
        "call_1",
        { todos: [{ content: "Surviving step", status: "in_progress" }] },
        undefined,
        undefined,
        ctx,
      );

      process.env.PI_APEX_UI = "0";
      mock.emitEvent("pi:ui:changed");
      const stripped = mock.latestTool("todo_write");
      assert.equal(stripped.renderShell, undefined, "receipt stripped when disabled live");
      assert.equal(stripped.renderCall, undefined, "call chrome stripped when disabled live");
      assert.equal(stripped.renderResult, undefined, "result chrome stripped when disabled live");
      assert.equal(mock.latestTool("todo_read").renderCall, undefined, "read chrome stripped too");

      process.env.PI_APEX_UI = "1";
      mock.emitEvent("pi:ui:changed");
      const restored = mock.latestTool("todo_write");
      assert.equal(typeof restored.renderCall, "function", "chrome restored on re-enable");
      assert.equal(typeof restored.renderResult, "function", "result chrome restored on re-enable");

      const readAfter = await mock.latestTool("todo_read").execute("r", {}, undefined, undefined, ctx);
      assert.match(readAfter.content[0].text, /Surviving step/, "plan survives re-registration");
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
      mock.emit("session_shutdown", {}, ctx);
    }
  });

  it("drops the agents pane to plain todos on a live switch to disabled", async () => {
    resetDockAgents();
    const mock = createMockPi("1");
    const previous = process.env.PI_APEX_UI;
    const notices: string[] = [];
    let mountedComponent: any;
    const tuiCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget(_key: string, component: any) {
          mountedComponent = component;
        },
        notify(message: string) {
          notices.push(message);
        },
      },
    } as any;
    const renderMounted = (width = 80): string[] => {
      const comp = typeof mountedComponent === "function" ? mountedComponent(null, theme) : mountedComponent;
      return comp?.render ? comp.render(width) : [];
    };
    try {
      mock.emit("session_start", { reason: "new" }, tuiCtx);
      await mock.latestTool("todo_write").execute(
        "call_1",
        { todos: [{ content: "Plain fallback step", status: "in_progress" }] },
        undefined,
        undefined,
        tuiCtx,
      );
      publishDockAgents([{ id: "task_1", agent: "scout", lifecycle: "running", createdAt: Date.now() }]);
      await mock.commands.get("agents").handler("", tuiCtx);
      assert.match(renderMounted().join("\n"), /scout/, "agents pane active while enabled");

      process.env.PI_APEX_UI = "0";
      mock.emitEvent("pi:ui:changed");
      const plain = renderMounted();
      assert.match(plain.join("\n"), /Plain fallback step/, "dock falls back to the plan");
      assert.ok(plain.every((line: string) => !/\u001b\[/.test(line)), "no styled chrome while disabled");
      assert.doesNotMatch(plain.join("\n"), /scout/, "agents pane cleared while disabled");

      await mock.commands.get("agents").handler("", tuiCtx);
      assert.match(notices[notices.length - 1], /inactive while Apex presentation is disabled/);
      assert.match(renderMounted().join("\n"), /Plain fallback step/, "gated switch leaves the plain list");
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
      publishDockAgents([]);
      mock.emit("session_shutdown", {}, tuiCtx);
    }
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

describe("dock tabs and agents pane", () => {
  it("renders a tab strip when live agents share the todo dock", () => {
    const view = buildTodoList([
      { content: "Inspect the screenshot", status: "in_progress" },
    ]);
    const lines = renderTodoList(theme, 80, view, {
      tabs: { pane: "todos", agentCount: 1, switchHint: "alt+a" },
    });
    assert.match(lines[0], /\[todos\]/);
    assert.match(lines[0], /agents 1/);
    assert.match(lines[0], /alt\+a/);
    assert.match(lines.join("\n"), /Inspect the screenshot/);
    assert.doesNotMatch(lines[0], /^◆ todos /);
  });

  it("renders a gutterless flat checklist with no diamond or tree rails", () => {
    const items = Array.from({ length: 24 }, (_, index) => ({
      content: `Item ${index + 1} with enough text to reach the right edge`,
      status: index === 12 ? "in_progress" : index < 12 ? "completed" : "pending",
      note: index === 12 ? "flat checklist identity" : undefined,
    }));
    const view = buildTodoList(items, { title: "Ship the dock" });

    for (const width of [40, 60, 80, 120]) {
      for (const options of [
        { collapsed: true, toggleHint: "alt+t" },
        { toggleHint: "alt+t" },
        { expanded: true },
        { tabs: { pane: "todos" as const, agentCount: 2, switchHint: "alt+a" } },
      ]) {
        const text = renderTodoList(theme, width, view, options).join("\n");
        assert.ok(!text.includes("\u25c6"), `width ${width}: diamond header glyph`);
        assert.ok(!text.includes("\u251c\u2500"), `width ${width}: branch rail`);
        assert.ok(!text.includes("\u2570\u2500"), `width ${width}: last-branch rail`);
        assert.ok(!text.includes("\u2502"), `width ${width}: continuation gutter`);
      }
    }

    // Status glyph is the left anchor; head/tail elision uses the same column.
    const wide = renderTodoList(theme, 100, view, { expanded: true });
    assert.match(wide[0], /^todos Ship the dock \(/);
    assert.match(wide[1], /^ {2}\u22ee \d+ earlier$/);
    assert.ok(
      wide.slice(1).every((line) => line.startsWith("  ")),
      "every row hangs at the flat two-space inset",
    );
    assert.ok(
      wide.some((line) => line.includes("\u22ee") && line.includes("earlier")),
      "head elision row present",
    );
    assert.ok(
      wide.some((line) => line.includes("\u22ee") && line.includes("more")),
      "tail elision row present",
    );
  });

  it("renders live agents as a flat shared-dock list, never a tree", () => {
    const now = 1_000_000;
    const lines = renderAgentList(
      theme,
      80,
      [
        {
          id: "task_1",
          agent: "oracle",
          lifecycle: "running",
          createdAt: now - 4 * 60_000,
          lastEventAt: now - 4 * 60_000,
        },
        {
          id: "task_2",
          agent: "artisan",
          lifecycle: "done",
          createdAt: now - 9 * 60_000,
          lastEventAt: now - 60_000,
        },
      ],
      {
        tabs: { pane: "agents", agentCount: 2, switchHint: "alt+a" },
        now,
      },
    );
    assert.match(lines[0], /\[agents 2\]/);
    const text = lines.join("\n");
    assert.match(text, /oracle/);
    assert.match(text, /running/);
    assert.match(text, /artisan/);
    // The agents pane shares the todo dock's flat identity: no receipt-tree
    // chrome, and body rows hang at the same two-space inset as todo rows.
    assert.ok(!text.includes("\u25c6"), "diamond header glyph");
    assert.ok(!text.includes("\u251c\u2500"), "branch rail");
    assert.ok(!text.includes("\u2570\u2500"), "last-branch rail");
    assert.ok(!text.includes("\u2502"), "continuation gutter");
    assert.ok(
      lines.slice(1).every((line) => line.startsWith("  ")),
      "every agent row hangs at the flat two-space inset",
    );
  });

  it("mounts the agents pane on a live snapshot even without todos", () => {
    resetDockAgents();
    const mock = createMockPi("1");
    assert.equal(mock.shortcuts.has("alt+a"), true);
    assert.equal(mock.commands.has("agents"), true);

    let mountedKey: string | undefined;
    let mountedComponent: any;
    const tuiCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget(key: string, component: any) {
          mountedKey = key;
          mountedComponent = component;
        },
        notify() {},
      },
    } as any;

    mock.emit("session_start", { reason: "new" }, tuiCtx);
    assert.equal(mountedComponent, undefined);

    publishDockAgents([
      {
        id: "task_1",
        agent: "scout",
        lifecycle: "running",
        createdAt: Date.now(),
      },
    ]);
    assert.equal(mountedKey, "todo-list");
    const getLines = (width = 80): string[] => {
      const factory = mountedComponent as
        | ((tui: unknown, theme: unknown) => { render: (width: number) => string[] })
        | { render: (width: number) => string[] }
        | undefined;
      const comp = typeof factory === "function" ? factory(null, theme) : factory;
      return comp?.render ? comp.render(width) : [];
    };
    const lines = getLines();
    assert.match(lines[0], /\[agents 1\]/);
    assert.match(lines.join("\n"), /scout/);

    publishDockAgents([]);
    assert.equal(
      mountedComponent,
      undefined,
      "clears the dock when no todos or agents remain",
    );
  });

  it("paints a live dock in place instead of remounting on fleet and todo updates", async () => {
    resetDockAgents();
    const mock = createMockPi("1");
    const write = mock.tools.find((tool) => tool.name === "todo_write");
    let mountedComponent: any;
    let mountedSurface:
      | { render: (width: number) => string[] }
      | undefined;
    let setWidgetCalls = 0;
    const tuiCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget(_key: string, component: any) {
          setWidgetCalls += 1;
          mountedComponent = component;
          mountedSurface =
            component == null
              ? undefined
              : typeof component === "function"
                ? component(null, theme)
                : component;
        },
        notify() {},
      },
    } as any;
    const renderMounted = (width = 80): string[] =>
      mountedSurface?.render ? mountedSurface.render(width) : [];

    mock.emit("session_start", { reason: "new" }, tuiCtx);
    assert.equal(setWidgetCalls, 0);

    await write.execute(
      "call_1",
      { todos: [{ content: "Review the crash", status: "in_progress" }] },
      undefined,
      undefined,
      tuiCtx,
    );
    assert.equal(setWidgetCalls, 1, "first todo_write mounts the dock");
    const mountedOnce = mountedComponent;
    assert.match(renderMounted().join("\n"), /Review the crash/);

    publishDockAgents([
      {
        id: "task_1",
        agent: "oracle",
        lifecycle: "settled",
        createdAt: 1,
        lastEventAt: 10,
      },
    ]);
    assert.equal(setWidgetCalls, 1, "first live snapshot does not remount");
    assert.equal(mountedComponent, mountedOnce);
    assert.match(renderMounted()[0] ?? "", /agents 1/);

    publishDockAgents([
      {
        id: "task_1",
        agent: "oracle",
        lifecycle: "running",
        createdAt: 1,
        lastEventAt: 99_999,
      },
    ]);
    assert.equal(setWidgetCalls, 1, "task_send lifecycle tick does not remount");
    assert.equal(mountedComponent, mountedOnce);

    await write.execute(
      "call_2",
      { todos: [{ content: "Finish the review", status: "completed" }] },
      undefined,
      undefined,
      tuiCtx,
    );
    assert.equal(setWidgetCalls, 1, "todo_write does not remount a live dock");
    assert.equal(mountedComponent, mountedOnce);
    assert.match(renderMounted().join("\n"), /Finish the review/);

    publishDockAgents([]);
    assert.equal(setWidgetCalls, 1, "agents leaving does not remount a todo dock");
    assert.equal(mountedComponent, mountedOnce);
    const afterAgentsLeave = renderMounted();
    assert.match(afterAgentsLeave.join("\n"), /Finish the review/);
    assert.doesNotMatch(afterAgentsLeave[0] ?? "", /\[agents/);
  });
});

describe("fusion close backstop", () => {
  function fireToolResult(mock: any, toolName: string, content: any[] = [{ type: "text", text: "ok" }]) {
    const event = { toolName, content, isError: false };
    for (const handler of mock.listeners.get("tool_result") ?? []) {
      const out = handler(event, {});
      if (out) return out;
    }
    return undefined;
  }

  async function withFusionEnv(fn: () => void | Promise<void>) {
    const priorMode = process.env.PI_BEHAVIOR_MODE;
    const priorSidekick = process.env.PI_FUSION_SIDEKICK;
    process.env.PI_BEHAVIOR_MODE = "fusion";
    delete process.env.PI_FUSION_SIDEKICK;
    try {
      await fn();
    } finally {
      if (priorMode === undefined) delete process.env.PI_BEHAVIOR_MODE;
      else process.env.PI_BEHAVIOR_MODE = priorMode;
      if (priorSidekick === undefined) delete process.env.PI_FUSION_SIDEKICK;
      else process.env.PI_FUSION_SIDEKICK = priorSidekick;
    }
  }

  async function writeTodos(mock: any, todos: any[]) {
    const res = await mock.latestTool("todo_write").execute("call", { todos }, undefined, undefined, {});
    assert.equal(res.isError, false, "plan write must succeed");
  }

  it("appends one line naming open items on task_wait/task_close", async () => {
    await withFusionEnv(async () => {
      const mock = createMockPi();
      try {
        await writeTodos(mock, [
          { id: "a", content: "Do the work", status: "in_progress" },
          { id: "b", content: "Verify it", status: "pending" },
          { id: "c", content: "Done already", status: "completed" },
        ]);
        for (const toolName of ["task_wait", "task_close"]) {
          const out = fireToolResult(mock, toolName);
          assert.ok(out, `${toolName} nudges with open items`);
          assert.equal(out.content.length, 2, "original blocks preserved");
          assert.equal(out.content[0].text, "ok", "original text untouched");
          const line = out.content[1].text as string;
          assert.equal(line.includes("\n"), false, "nudge is a single line");
          assert.match(line, /^\[fusion\] task_(wait|close) returned with 2 todo items still open:/);
          assert.match(line, /#a in_progress/);
          assert.match(line, /#b pending/);
          assert.doesNotMatch(line, /#c/, "completed items are not listed");
        }
      } finally {
        mock.emit("session_shutdown", {}, {});
      }
    });
  });

  it("returns undefined when every item is done", async () => {
    await withFusionEnv(async () => {
      const mock = createMockPi();
      try {
        await writeTodos(mock, [
          { content: "Finished", status: "completed" },
          { content: "Dropped", status: "cancelled" },
          { content: "Waiting out", status: "blocked" },
        ]);
        assert.equal(fireToolResult(mock, "task_close"), undefined);
        assert.equal(fireToolResult(mock, "task_wait"), undefined);
      } finally {
        mock.emit("session_shutdown", {}, {});
      }
    });
  });

  it("ignores unrelated tool results", async () => {
    await withFusionEnv(async () => {
      const mock = createMockPi();
      try {
        await writeTodos(mock, [{ content: "Open work", status: "pending" }]);
        assert.equal(fireToolResult(mock, "read"), undefined);
        assert.equal(fireToolResult(mock, "todo_write"), undefined);
      } finally {
        mock.emit("session_shutdown", {}, {});
      }
    });
  });

  it("stays silent outside fusion mode", async () => {
    const priorMode = process.env.PI_BEHAVIOR_MODE;
    const priorSidekick = process.env.PI_FUSION_SIDEKICK;
    process.env.PI_BEHAVIOR_MODE = "apex";
    delete process.env.PI_FUSION_SIDEKICK;
    try {
      const mock = createMockPi();
      try {
        await writeTodos(mock, [{ content: "Open work", status: "pending" }]);
        assert.equal(fireToolResult(mock, "task_close"), undefined);
      } finally {
        mock.emit("session_shutdown", {}, {});
      }
    } finally {
      if (priorMode === undefined) delete process.env.PI_BEHAVIOR_MODE;
      else process.env.PI_BEHAVIOR_MODE = priorMode;
      if (priorSidekick === undefined) delete process.env.PI_FUSION_SIDEKICK;
      else process.env.PI_FUSION_SIDEKICK = priorSidekick;
    }
  });

  it("stays silent for the sidekick itself", async () => {
    const priorMode = process.env.PI_BEHAVIOR_MODE;
    const priorSidekick = process.env.PI_FUSION_SIDEKICK;
    process.env.PI_BEHAVIOR_MODE = "fusion";
    process.env.PI_FUSION_SIDEKICK = "1";
    try {
      const mock = createMockPi();
      try {
        await writeTodos(mock, [{ content: "Open work", status: "pending" }]);
        assert.equal(fireToolResult(mock, "task_close"), undefined);
      } finally {
        mock.emit("session_shutdown", {}, {});
      }
    } finally {
      if (priorMode === undefined) delete process.env.PI_BEHAVIOR_MODE;
      else process.env.PI_BEHAVIOR_MODE = priorMode;
      if (priorSidekick === undefined) delete process.env.PI_FUSION_SIDEKICK;
      else process.env.PI_FUSION_SIDEKICK = priorSidekick;
    }
  });

  it("caps the enumeration at 8 ids with a +M more tail", async () => {
    await withFusionEnv(async () => {
      const mock = createMockPi();
      try {
        await writeTodos(
          mock,
          Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, content: `Work ${i}`, status: "pending" })),
        );
        const out = fireToolResult(mock, "task_close");
        assert.ok(out, "nudges with many open items");
        const line = out.content.at(-1).text as string;
        assert.equal(line.includes("\n"), false, "nudge is a single line");
        assert.match(line, /10 todo items still open/);
        assert.match(line, /#t7 pending/);
        assert.doesNotMatch(line, /#t8/, "9th id is folded into the tail");
        assert.match(line, /\+2 more/);
      } finally {
        mock.emit("session_shutdown", {}, {});
      }
    });
  });
});

describe("agents tab in all modes with selection and peek", () => {
  function mountPlan(apexUi = "1") {
    resetDockAgents();
    const mock = createMockPi(apexUi);
    let mountedComponent: any;
    let setWidgetCalls = 0;
    const tuiCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget(_key: string, component: any) {
          setWidgetCalls += 1;
          mountedComponent = component;
        },
        notify() {},
      },
    } as any;
    mock.emit("session_start", { reason: "new" }, tuiCtx);
    return {
      mock,
      tuiCtx,
      setWidgetCalls: () => setWidgetCalls,
      render: (width = 80): string[] => {
        const factory = mountedComponent as
          | ((tui: unknown, theme: unknown) => { render: (width: number) => string[] })
          | undefined;
        const comp = typeof factory === "function" ? factory(null, theme) : undefined;
        return comp?.render ? comp.render(width) : [];
      },
      shutdown() {
        publishDockAgents([]);
        mock.emit("session_shutdown", {}, tuiCtx);
      },
    };
  }

  async function writePlan(mock: any, tuiCtx: any) {
    await mock.latestTool("todo_write").execute(
      "call_1",
      { todos: [{ content: "Review the crash", status: "in_progress" }] },
      undefined,
      undefined,
      tuiCtx,
    );
  }

  const worker = (overrides: Record<string, unknown> = {}) => ({
    id: "task_sidekick",
    agent: "sidekick",
    lifecycle: "running",
    createdAt: Date.now() - 2 * 60_000,
    lastEventAt: Date.now() - 2 * 60_000,
    phase: "tool",
    tool: "bash",
    turns: 7,
    maxTurns: 40,
    generation: 3,
    waitingUi: 0,
    mission: "Steer the dock",
    fusion: true,
    sessionFile: "/tmp/worker-session.jsonl",
    activity: [
      { tool: "read", status: "completed" },
      { tool: "bash", status: "running" },
    ],
    ...overrides,
  });

  it("shows the agents tab for N==1 in a non-Fusion mode", async () => {
    const dock = mountPlan("1");
    try {
      await writePlan(dock.mock, dock.tuiCtx);
      const mountedOnce = dock.setWidgetCalls();
      publishDockAgents([worker({ fusion: false, agent: "scout", id: "task_1" })]);
      assert.equal(dock.setWidgetCalls(), mountedOnce, "agent tick repaints in place");
      const lines = dock.render(80);
      assert.ok(lines.length <= TODO_LIST_MAX_LINES, `within ${TODO_LIST_MAX_LINES} lines`);
      assert.match(lines.join("\n"), /Review the crash/, "todos stay visible");
      assert.match(lines[0], /\[todos\]/, "tab strip shows for N==1");
      assert.match(lines[0], /agents 1/);
      for (const line of lines) {
        assert.ok(safeVisibleWidth(line) <= 80, `"${line}" exceeds width budget`);
      }
      await dock.mock.commands.get("agents").handler("", dock.tuiCtx);
      const agents = dock.render(80);
      assert.match(agents.join("\n"), /scout/, "agents pane lists the worker");
      assert.ok(agents.length <= TODO_LIST_MAX_LINES);
    } finally {
      dock.shutdown();
    }
  });

  it("renders the todos pane with no agents exactly as at HEAD", async () => {
    const dock = mountPlan("1");
    try {
      await writePlan(dock.mock, dock.tuiCtx);
      const lines = dock.render(80);
      assert.match(lines.join("\n"), /Review the crash/);
      assert.doesNotMatch(lines.join("\n"), /agents/);
      assert.doesNotMatch(lines.join("\n"), /sidekick/);
      assert.ok(lines.length <= TODO_LIST_MAX_LINES);
    } finally {
      dock.shutdown();
    }
  });

  it("declines focus and capture on agent-row clicks", () => {
    // Regression test for the input freeze: a click result that omits
    // `focus`/`capture` lets dispatchMouseEvent default them in ways that
    // steal the editor (focusTarget) or wedge gestures (mouseCapture).
    // The dock must claim the row WITHOUT either.
    const seen: string[] = [];
    const hit = dockClickResult(
      {
        type: "click",
        button: "left",
        y: 1,
      } as any,
      {
        onAgentRow: (rowIndex: number) => {
          seen.push(`row:${rowIndex}`);
        },
        rowCount: () => 1,
      },
    );
    assert.ok(hit, "agent row claims the click");
    assert.equal(hit?.handled, true);
    assert.equal((hit as any)?.focus, false, "must not take keyboard focus from the editor");
    assert.equal((hit as any)?.capture, false, "must not capture the press/release gesture");
    assert.deepEqual(seen, ["row:0"]);
    assert.equal(
      dockClickResult({ type: "click", button: "left", y: 0 } as any, {
        onAgentRow: () => seen.push("header"),
        rowCount: () => 1,
      }),
      undefined,
      "header clicks pass through",
    );
    assert.equal(
      dockClickResult({ type: "move", button: "none", y: 1 } as any, {
        onAgentRow: () => seen.push("move"),
        rowCount: () => 1,
      }),
      undefined,
      "non-click input passes through",
    );
    assert.deepEqual(seen, ["row:0"], "passed-through input fires no row callback");
  });

  it("maps click y to the rendered agent row", () => {
    assert.equal(agentRowAtY(0, 2), undefined, "header row is not a worker");
    assert.equal(agentRowAtY(1, 2), 0);
    assert.equal(agentRowAtY(2, 2), 1);
    assert.equal(agentRowAtY(3, 2), undefined, "past the last row");
    assert.equal(agentRowAtY(1, 0), undefined, "no rows");
    assert.equal(agentRowAtY(7, 8), undefined, "beyond the visible window");
    assert.equal(agentRowAtY(NaN, 2), undefined);
  });

  it("renders the peek body bounded with transcript tail", () => {
    const transcript = [
      "lead: please audit the proxy",
      "worker: reading the config",
      "tool read",
      "worker: done",
    ];
    const live = renderPeekBody(theme, 80, worker({ lifecycle: "running" }), { transcript });
    assert.match(live.join("\n"), /sidekick/);
    assert.match(live.join("\n"), /Steer the dock/);
    assert.match(live.join("\n"), /gen 3/);
    assert.match(live.join("\n"), /running bash/);
    assert.match(live.join("\n"), /7\/40 turns/);
    assert.match(live.join("\n"), /read/);
    assert.match(live.join("\n"), /worker: reading the config/);
    assert.match(live.join("\n"), /session still writing — open after settle/);
    assert.doesNotMatch(live.join("\n"), /o: open session/);
    assert.ok(live.length <= TODO_LIST_MAX_LINES);
    assert.ok(live.every((line: string) => safeVisibleWidth(line) <= 80));

    const settled = renderPeekBody(theme, 80, worker({ lifecycle: "settled" }), { transcript });
    assert.match(settled.join("\n"), /o: open session/);

    const torn = renderPeekBody(theme, 80, worker({ lifecycle: "settled" }), {});
    assert.match(torn.join("\n"), /transcript unavailable/);
    assert.ok(torn.length <= TODO_LIST_MAX_LINES);
  });

  it("gates session switch on settled/failed only", () => {
    assert.equal(canSwitchToSession("settled"), true);
    assert.equal(canSwitchToSession("failed"), true);
    assert.equal(canSwitchToSession("running"), false);
    assert.equal(canSwitchToSession("starting"), false);
    assert.equal(canSwitchToSession("retrying"), false);
    assert.equal(canSwitchToSession("compacting"), false);
    assert.equal(canSwitchToSession("aborting"), false);
    assert.equal(canSwitchToSession(undefined), false);
  });

  it("guards unbounded turn caps in shared turn text", () => {
    assert.equal(turnCountText(7, 40), "7/40 turns");
    assert.equal(turnCountText(38, Number.MAX_SAFE_INTEGER), "38 turns");
    assert.equal(turnCountText(38, 0), "38 turns");
    assert.equal(turnCountText(undefined, 40), undefined);
  });

  it("marks selection distinctly and keeps keyboard order", async () => {
    const dock = mountPlan("1");
    try {
      await writePlan(dock.mock, dock.tuiCtx);
      publishDockAgents([
        worker({ id: "task_1", agent: "oracle", fusion: false }),
        worker({ id: "task_2", agent: "artisan", fusion: false }),
      ]);
      await dock.mock.commands.get("agents").handler("", dock.tuiCtx);
      const agents = dock.render(80);
      assert.match(agents[1], /\u25b8/, "first row selected with a distinct marker");
      assert.doesNotMatch(agents[1], /^  [\u25cb\u25cf\u25a1\u25a0] /, "selection marker is not a todo glyph");
    } finally {
      dock.shutdown();
    }
  });

  it("withholds the switch affordance for live workers in peek", async () => {
    const dock = mountPlan("1");
    try {
      await writePlan(dock.mock, dock.tuiCtx);
      publishDockAgents([worker({ waitingUi: 2, tool: "bash" })]);
      await dock.mock.commands.get("agents").handler("", dock.tuiCtx);
      const rows = dock.render(80).filter((line) => line.includes("waiting for reply"));
      assert.equal(rows.length, 1, "blocked signal wins over the tool name");
    } finally {
      dock.shutdown();
    }
  });

  it("peeks the agents pane with rows, selection, and toggle", async () => {
    const dock = mountPlan("1");
    try {
      await writePlan(dock.mock, dock.tuiCtx);
      publishDockAgents([worker()]);
      await dock.mock.commands.get("agents").handler("", dock.tuiCtx);
      const agents = dock.render(80);
      assert.match(agents.join("\n"), /sidekick/, "pane names the actor");
      assert.match(agents.join("\n"), /running/);
      assert.ok(agents.length <= TODO_LIST_MAX_LINES, `within ${TODO_LIST_MAX_LINES} lines`);
      assert.ok(agents.every((line: string) => safeVisibleWidth(line) <= 80));
      // Toggling back lands on todos; settling the sidekick cannot strand
      // the dock on an empty agents pane (liveAgents empty resets to todos).
      await dock.mock.shortcuts.get("alt+a").handler(dock.tuiCtx);
      assert.match(dock.render(80).join("\n"), /Review the crash/);
      await dock.mock.commands.get("agents").handler("", dock.tuiCtx);
      publishDockAgents([]);
      assert.match(dock.render(80).join("\n"), /Review the crash/, "empty agents resets to todos");
    } finally {
      dock.shutdown();
    }
  });

  it("never exceeds TODO_LIST_MAX_LINES with a full plan", async () => {
    const dock = mountPlan("1");
    try {
      await dock.mock.latestTool("todo_write").execute(
        "call_1",
        {
          todos: Array.from({ length: 24 }, (_, index) => ({
            content: `Item ${index + 1} with enough text to reach the edge`,
            status: index === 0 ? "in_progress" : "pending",
          })),
        },
        undefined,
        undefined,
        dock.tuiCtx,
      );
      publishDockAgents([worker()]);
      for (const width of [40, 80, 120]) {
        const lines = dock.render(width);
        assert.ok(
          lines.length <= TODO_LIST_MAX_LINES,
          `width ${width}: ${lines.length} lines exceeds ${TODO_LIST_MAX_LINES}`,
        );
        for (const line of lines) {
          assert.ok(safeVisibleWidth(line) <= width, `width ${width}: "${line}"`);
        }
      }
    } finally {
      dock.shutdown();
    }
  });

  it("keeps the multi-worker agents tab path unchanged", async () => {
    const dock = mountPlan("1");
    try {
      await writePlan(dock.mock, dock.tuiCtx);
      publishDockAgents([
        { id: "task_1", agent: "oracle", lifecycle: "running", createdAt: 1 },
        { id: "task_2", agent: "artisan", lifecycle: "running", createdAt: 2 },
      ]);
      const lines = dock.render(80);
      assert.match(lines[0], /\[todos\]/, "tab strip stays for N>1");
      assert.match(lines[0], /agents 2/);
      assert.doesNotMatch(lines.join("\n"), /sidekick/, "no inline line for N>1");
      await dock.mock.commands.get("agents").handler("", dock.tuiCtx);
      const agents = dock.render(80);
      assert.match(agents.join("\n"), /oracle/, "agents pane still reachable via /agents");
      assert.match(agents.join("\n"), /artisan/);
    } finally {
      dock.shutdown();
    }
  });

  it("shows the agents tab for a lone worker without special-casing", async () => {
    const dock = mountPlan("1");
    try {
      await writePlan(dock.mock, dock.tuiCtx);
      publishDockAgents([
        { id: "task_1", agent: "scout", lifecycle: "running", createdAt: 1 },
      ]);
      const lines = dock.render(80);
      assert.match(lines[0], /\[todos\]/, "tab strip shows for N==1");
      assert.match(lines[0], /agents 1/);
      assert.doesNotMatch(lines.join("\n"), /sidekick/, "no legacy inline strip");
    } finally {
      dock.shutdown();
    }
  });

  it("stays a plain todo list under PI_APEX_UI=0", async () => {
    const dock = mountPlan("0");
    try {
      await writePlan(dock.mock, dock.tuiCtx);
      publishDockAgents([worker()]);
      const lines = dock.render(80);
      assert.match(lines.join("\n"), /Review the crash/);
      assert.doesNotMatch(lines.join("\n"), /sidekick/, "no chrome while disabled");
      assert.ok(lines.every((line: string) => !/\u001b\[/.test(line)));
    } finally {
      dock.shutdown();
    }
  });

  it("keeps renderPeekBody bounded with torn or missing transcripts", () => {
    const item = worker({
      tool: "bash",
      turns: 38,
      mission: "A mission label that keeps going past any sane dock width",
      maxTurns: Number.MAX_SAFE_INTEGER,
    });
    const transcript = [
      "lead: please audit the proxy",
      "worker: reading the config",
      "tool read",
    ];
    for (const width of [20, 40, 80]) {
      const body = renderPeekBody(theme, width, item, { transcript });
      assert.ok(body.length >= 2, `width ${width}: header + state`);
      for (const row of body) {
        assert.equal(row.includes("\n"), false, `width ${width}: single row each`);
        assert.ok(safeVisibleWidth(row) <= width, `width ${width}: "${row}"`);
      }
      assert.doesNotMatch(body.join("\n"), /9007199254740991/, "no raw MAX_SAFE_INTEGER in the overlay");
    }
    const wide = renderPeekBody(theme, 80, item, { transcript });
    assert.match(wide.join("\n"), /38 turns/, "unbounded fusion cap renders as N turns");
    assert.deepEqual(renderPeekBody(theme, 0, item), []);
    const capped = renderPeekBody(theme, 80, worker({
      activity: [
        { tool: "x".repeat(100), status: "completed" },
        { tool: "bash", status: "error" },
        { tool: "read", status: "running" },
        { tool: "write", status: "completed" },
        { tool: "extra", status: "completed" },
      ],
    }), { transcript });
    const activityRows = capped.filter((line: string) => line.includes("\u25aa"));
    assert.ok(activityRows.length <= 4, "activity list capped at 4 rows");
    assert.ok(capped.every((line: string) => safeVisibleWidth(line) <= 80));
    assert.ok(capped.length <= TODO_LIST_MAX_LINES);
    const missing = renderPeekBody(theme, 80, item, {});
    assert.match(missing.join("\n"), /transcript unavailable/);
  });
});

describe("installUiHost once-owner across skins", () => {
  function mockPi() {
    const tools = new Map<string, unknown>();
    const shortcuts = new Map<string, unknown>();
    const commands = new Map<string, unknown>();
    const events = { on() {} };
    return {
      tools,
      shortcuts,
      commands,
      events,
      on() {},
      registerTool(def: { name: string }) {
        tools.set(def.name, def);
      },
      registerShortcut(key: string, def: unknown) {
        shortcuts.set(key, def);
      },
      registerCommand(name: string, def: unknown) {
        commands.set(name, def);
      },
      getCommands() {
        return [];
      },
      getFlag() {
        return undefined;
      },
      sendUserMessage() {},
      registerMessageRenderer() {},
    };
  }

  const dummyLanding = {
    prelude() { return []; },
    logo() { return { rows: [], blockWidth: 0 }; },
    invitation() { return ""; },
  };
  const noopIndicator = () => ({ frames: ["·"], intervalMs: 1000, message: "" });

  it("registers shared tools and shortcuts on only the first pi", async () => {
    const previousSkin = process.env.PI_UI_SKIN;
    delete process.env.PI_UI_SKIN;
    const { resetUiKitInstallForTests, installUiHost, registerObservatoryLanding } = await import("@pi/ui-kit");
    resetUiKitInstallForTests();
    const apex = mockPi();
    const claude = mockPi();
    const hal = mockPi();
    try {
      registerObservatoryLanding("apex", dummyLanding as any);
      registerObservatoryLanding("claude", dummyLanding as any);
      registerObservatoryLanding("hal", dummyLanding as any);
      installUiHost(apex as any, { skin: "apex", thinkingLabel: "· thinking", buildWorkingIndicator: noopIndicator });
      installUiHost(claude as any, { skin: "claude", thinkingLabel: "· thinking", buildWorkingIndicator: noopIndicator });
      installUiHost(hal as any, { skin: "hal", thinkingLabel: "· thinking", buildWorkingIndicator: noopIndicator });
      for (const name of ["todo_write", "todo_read", "bash", "write"]) {
        assert.ok(apex.tools.has(name), `${name} on first pi`);
        assert.equal(claude.tools.has(name), false, `${name} not on claude`);
        assert.equal(hal.tools.has(name), false, `${name} not on hal`);
      }
      for (const key of ["alt+t", "alt+a", "alt+o"]) {
        assert.ok(apex.shortcuts.has(key), `${key} on first pi`);
        assert.equal(claude.shortcuts.has(key), false);
        assert.equal(hal.shortcuts.has(key), false);
      }
      for (const name of ["todos", "agents", "observatory"]) {
        assert.ok(apex.commands.has(name), `${name} on first pi`);
        assert.equal(claude.commands.has(name), false);
        assert.equal(hal.commands.has(name), false);
      }
      // Isolated jiti copies of the kit still share this interned process bag.
      const bag = (process as any)[Symbol.for("pi.ui-kit.shared")];
      assert.ok(bag?.toolsPi, "process bag claimed by first skin");
      assert.equal(bag.hosts.size, 3, "later skins still join the hosts map");
      assert.equal(bag.landings.size, 3, "later skins still join the landings map");
    } finally {
      resetUiKitInstallForTests();
      if (previousSkin === undefined) delete process.env.PI_UI_SKIN;
      else process.env.PI_UI_SKIN = previousSkin;
    }
  });

  it("re-claims tools and shortcuts after the first pi is invalidated", async () => {
    const previousSkin = process.env.PI_UI_SKIN;
    delete process.env.PI_UI_SKIN;
    const { resetUiKitInstallForTests, installUiHost, registerObservatoryLanding } = await import("@pi/ui-kit");
    resetUiKitInstallForTests();
    const first = mockPi();
    const next = mockPi();
    const later = mockPi();
    try {
      registerObservatoryLanding("apex", dummyLanding as any);
      registerObservatoryLanding("claude", dummyLanding as any);
      registerObservatoryLanding("hal", dummyLanding as any);
      installUiHost(first as any, { skin: "apex", thinkingLabel: "· thinking", buildWorkingIndicator: noopIndicator });
      first.getFlag = () => {
        throw new Error("stale after reload");
      };
      installUiHost(next as any, { skin: "claude", thinkingLabel: "· thinking", buildWorkingIndicator: noopIndicator });
      installUiHost(later as any, { skin: "hal", thinkingLabel: "· thinking", buildWorkingIndicator: noopIndicator });
      for (const name of ["todo_write", "todo_read", "bash", "write"]) {
        assert.ok(next.tools.has(name), `${name} on reclaimed pi`);
        assert.equal(later.tools.has(name), false, `${name} not re-registered on later skin`);
      }
      for (const key of ["alt+t", "alt+a", "alt+o"]) {
        assert.ok(next.shortcuts.has(key), `${key} on reclaimed pi`);
        assert.equal(later.shortcuts.has(key), false);
      }
      for (const name of ["todos", "agents", "observatory"]) {
        assert.ok(next.commands.has(name), `${name} on reclaimed pi`);
        assert.equal(later.commands.has(name), false);
      }
      const bag = (process as any)[Symbol.for("pi.ui-kit.shared")];
      assert.equal(bag?.toolsPi, next, "bag claimant is the new generation");
      assert.equal(bag.hostListeners, true);
      assert.equal(bag.hosts.size, 3, "hosts map kept and re-populated");
    } finally {
      resetUiKitInstallForTests();
      if (previousSkin === undefined) delete process.env.PI_UI_SKIN;
      else process.env.PI_UI_SKIN = previousSkin;
    }
  });
});
