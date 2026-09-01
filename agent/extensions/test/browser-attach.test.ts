import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { default: promptCommands } = await import("../prompt-commands.ts");

type ToolExecute = (
  id: string,
  params: { task?: string },
  signal: AbortSignal,
  update: unknown,
  ctx: { cwd: string },
) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }>;

describe("browser_attach", () => {
  it("runs the shared connect step and returns the custom browser prompt", async () => {
    let tool: ToolExecute | undefined;
    let execArgs: string[] | undefined;

    promptCommands({
      registerTool(spec: { name: string; execute: ToolExecute }) {
        if (spec.name === "browser_attach") tool = spec.execute;
      },
      registerCommand() {},
      registerShortcut() {},
      appendEntry() {},
      on() {},
      getCommands() { return []; },
      async exec(_command: string, args: string[]) {
        execArgs = args;
        return {
          code: 0,
          stdout: "STATUS: connected\nMode: classic\nPort: 29300\nTabs: Example",
          stderr: "",
          killed: false,
        };
      },
    } as any);

    assert.ok(tool, "browser_attach tool should be registered");
    const result = await tool(
      "call-1",
      { task: "inspect https://example.com" },
      new AbortController().signal,
      undefined,
      { cwd: process.cwd() },
    );

    assert.equal(result.isError, false);
    assert.deepEqual(result.details, {});
    assert.deepEqual(execArgs?.slice(-2), ["connect", "inspect https://example.com"]);
    const text = result.content[0]?.text ?? "";
    assert.match(text, /You are co-browsing with me/);
    assert.match(text, /Task\/URL from me: inspect https:\/\/example\.com/);
    assert.match(text, /\[Connect step\]/);
    assert.match(text, /status: succeeded/);
    assert.match(text, /STATUS: connected/);
  });
});
