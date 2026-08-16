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
