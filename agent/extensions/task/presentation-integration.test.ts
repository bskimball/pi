import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ampTask from "./amp-task.ts";
import asyncTask from "./async-task.ts";

interface RegisteredTool {
  name: string;
  execute?: unknown;
  renderShell?: unknown;
  renderCall?: unknown;
  renderResult?: unknown;
}

function register(extension: (pi: ExtensionAPI) => void): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
    registerShortcut() {},
    registerCommand() {},
    registerMessageRenderer() {},
    on() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  extension(pi);
  return tools;
}

function loadAsyncDispatch() {
  const commands: Record<
    string,
    (args: string, ctx: unknown) => unknown | Promise<unknown>
  > = {};
  const listeners: Record<string, Array<() => void>> = {};
  const entries: Array<{ type: string; data: unknown }> = [];
  const messages: Array<{ payload: unknown; opts?: unknown }> = [];
  const userMessages: unknown[] = [];
  const notices: string[] = [];
  asyncTask({
    registerTool() {},
    registerShortcut() {},
    registerCommand(name: string, spec: { handler: typeof commands[string] }) {
      commands[name] = spec.handler;
    },
    registerMessageRenderer() {},
    on(event: string, handler: () => void) {
      (listeners[event] ??= []).push(handler);
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    sendMessage(payload: unknown, opts?: unknown) {
      messages.push({ payload, opts });
    },
    sendUserMessage() {
      userMessages.push(true);
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    isIdle: () => false,
    ui: {
      notify(message: string) {
        notices.push(message);
      },
    },
  };
  return {
    commands,
    entries,
    messages,
    userMessages,
    notices,
    ctx,
    sessionStart() {
      for (const h of listeners.session_start ?? []) h();
    },
    sessionShutdown() {
      for (const h of listeners.session_shutdown ?? []) h();
    },
  };
}

describe("standalone Task presentation", () => {
  it("supports both the global emergency opt-out and PI_TASK_UI", () => {
    const previousTask = process.env.PI_TASK_UI;
    const previousApex = process.env.PI_APEX_UI;
    try {
      process.env.PI_APEX_UI = "1";
      delete process.env.PI_TASK_UI;
      const enabled = [...register(ampTask), ...register(asyncTask)];
      assert.ok(enabled.some((tool) => typeof tool.renderResult === "function"));

      process.env.PI_APEX_UI = "0";
      const globallyDisabled = [...register(ampTask), ...register(asyncTask)];
      for (const tool of globallyDisabled) {
        assert.equal(tool.renderCall, undefined, `${tool.name} global renderCall`);
        assert.equal(tool.renderResult, undefined, `${tool.name} global renderResult`);
      }

      process.env.PI_APEX_UI = "1";
      process.env.PI_TASK_UI = "0";
      const disabled = [...register(ampTask), ...register(asyncTask)];
      for (const tool of disabled) {
        assert.equal(typeof tool.execute, "function", `${tool.name} execute`);
        assert.equal(tool.renderShell, undefined, `${tool.name} renderShell`);
        assert.equal(tool.renderCall, undefined, `${tool.name} renderCall`);
        assert.equal(tool.renderResult, undefined, `${tool.name} renderResult`);
      }
    } finally {
      if (previousTask === undefined) delete process.env.PI_TASK_UI;
      else process.env.PI_TASK_UI = previousTask;
      if (previousApex === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previousApex;
    }
  });
});

describe("/dispatch command", () => {
  it("records unique session entries, steers parent once, and does not claim assignment", async () => {
    const harness = loadAsyncDispatch();
    await harness.commands.dispatch!("first extra slice", harness.ctx);
    await harness.commands.dispatch!("second extra slice", harness.ctx);
    assert.equal(harness.entries.length, 2);
    assert.equal(harness.messages.length, 2);
    assert.equal(harness.userMessages.length, 0);
    const ids = harness.entries.map((e) => (e.data as { id: string }).id);
    assert.notEqual(ids[0], ids[1]);
    assert.equal(harness.entries[0]!.type, "async-task-dispatch");
    const first = harness.messages[0]!;
    const payload = first.payload as {
      customType: string;
      content: string;
      display: boolean;
      details: { id: string };
    };
    assert.equal(payload.customType, "async-task-dispatch");
    assert.equal(payload.display, false);
    assert.equal(payload.details.id, ids[0]);
    assert.match(payload.content, /first extra slice/);
    assert.deepEqual(first.opts, { triggerTurn: true, deliverAs: "steer" });
    assert.match(harness.notices[0]!, /parent steering requested/);
    assert.match(harness.notices[0]!, /Route under active delegation policy/);
    assert.ok(harness.notices[0]!.includes(ids[0]!));
  });

  it("prints usage on empty args and does not record or send", async () => {
    const harness = loadAsyncDispatch();
    await harness.commands.dispatch!("   ", harness.ctx);
    assert.equal(harness.entries.length, 0);
    assert.equal(harness.messages.length, 0);
    assert.equal(harness.userMessages.length, 0);
    assert.equal(harness.notices[0], "Usage: /dispatch <request>");
  });

  it("isolates dispatch sequence across session_start", async () => {
    const a = loadAsyncDispatch();
    const b = loadAsyncDispatch();
    await a.commands.dispatch!("from a", a.ctx);
    await b.commands.dispatch!("from b", b.ctx);
    const idA = (a.entries[0]!.data as { id: string }).id;
    const idB = (b.entries[0]!.data as { id: string }).id;
    assert.ok(idA);
    assert.ok(idB);
    a.sessionStart();
    await a.commands.dispatch!("from a again", a.ctx);
    assert.equal(a.entries.length, 2);
    a.sessionShutdown();
  });
});
