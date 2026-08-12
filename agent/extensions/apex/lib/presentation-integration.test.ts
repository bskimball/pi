import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ampTask from "../amp-task.ts";
import asyncTask from "../async-task.ts";
import bgProcess from "../../bg-process.ts";
import powershell from "../../powershell.ts";
import todoList from "../../todo-list.ts";
import webSearch from "../../web-search.ts";

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

describe("default UI tool registration", () => {
  it("preserves execution and omits Apex renderer slots", () => {
    const previous = process.env.PI_APEX_UI;
    try {
      process.env.PI_APEX_UI = "0";
      const tools = [
        ...register(ampTask),
        ...register(asyncTask),
        ...register(bgProcess),
        ...register(powershell),
        ...register(todoList),
        ...register(webSearch),
      ];
      assert.ok(tools.length >= 15, `expected core tools, got ${tools.length}`);
      for (const tool of tools) {
        assert.equal(
          typeof tool.execute,
          "function",
          `${tool.name} must retain execute in default UI`,
        );
        assert.equal(tool.renderShell, undefined, `${tool.name} renderShell`);
        assert.equal(tool.renderCall, undefined, `${tool.name} renderCall`);
        assert.equal(tool.renderResult, undefined, `${tool.name} renderResult`);
      }
    } finally {
      if (previous === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previous;
    }
  });
});
