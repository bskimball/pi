import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { registerBrowserAttachTool, runDeployCommand } from "../prompt-commands/featured-commands.ts";
import { runFeaturedExtensionCommand } from "../../../packages/ui-kit/internal/runtime/featured-commands.ts";

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

    registerBrowserAttachTool({
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
    assert.match(text, /Co-browse in dedicated authenticated debug Chrome for: inspect https:\/\/example\.com/);
    assert.match(text, /\[Connect step\]/);
    assert.match(text, /status: succeeded/);
    assert.match(text, /STATUS: connected/);
    assert.match(text, /reuses an exact URL match/);
    assert.match(text, /preserving its route and state/);
    assert.match(text, /Without a URL it only lists pages/);
    assert.match(text, /Leave reused and newly opened tabs open/);
    assert.doesNotMatch(text, /Each session opens a fresh tab|tab close/);
  });
});

const deployEntryPoints: Array<[string, typeof runDeployCommand]> = [
  ["/deploy", runDeployCommand],
  ["landing screen", (pi, args, ctx) => runFeaturedExtensionCommand(pi, "deploy", args, ctx)],
];
for (const [entry, deploy] of deployEntryPoints) describe(`deploy handoff: ${entry}`, () => {
  const cwd = "/project";
  const sha = "a".repeat(40);
  const mirror = readFileSync(new URL("../../prompts/inactive/deploy.md", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const mirrorBody = mirror.slice(mirror.indexOf("\n---\n", 4) + 5).split("\n## Pre-step snapshot")[0].trim();

  for (const idle of [true, false]) {
    it(`captures the exact revision and scoped handoff ${idle ? "immediately" : "as a follow-up"} without mutating Git`, async () => {
      const responses = new Map([
        ["rev-parse --show-toplevel", cwd],
        ["branch --show-current", "feat/task"],
        ["rev-parse --verify HEAD", sha],
        ["status --short --branch", "## feat/task\n M src/task.ts\nM  unrelated.ts\n?? scratch.txt"],
        ["worktree list", `${cwd} ${sha} [feat/task]`],
        ["diff --name-only", "src/task.ts"],
        ["diff --cached --name-only", "unrelated.ts"],
        ["ls-files --others --exclude-standard", "scratch.txt"],
      ]);
      const calls: string[] = [];
      const messages: Array<{ text: string; options: unknown }> = [];
      const signal = new AbortController().signal;
      const target = "staging at the approved task revision; don't push";
      await deploy({
        async exec(command: string, args: string[], options: { cwd: string; signal: AbortSignal }) {
          assert.equal(command, "git"); assert.equal(options.cwd, cwd); assert.equal(options.signal, signal);
          const key = args.join(" ");
          assert.ok(responses.has(key), `unexpected command (only discovery reads allowed): ${key}`);
          calls.push(key);
          return { code: 0, stdout: responses.get(key), stderr: "", killed: false };
        },
        sendUserMessage(text: string, options: unknown) { messages.push({ text, options }); },
      } as any, target, { cwd, signal, hasUI: true, isIdle: () => idle, ui: { notify() {} } } as any);

      assert.equal(calls.length, responses.size); assert.equal(messages.length, 1);
      const { text, options } = messages[0];
      assert.deepEqual(options, idle ? undefined : { deliverAs: "followUp" });
      assert.equal(text.split("\n## Pre-step snapshot")[0].trim(), mirrorBody.replaceAll("$@", target));
      assert.ok(text.includes(`git_head=${sha}`));
      assert.match(text, /M  unrelated\.ts/); assert.match(text, /\?\? scratch\.txt/);
      assert.match(text, /Git mutations are not authorized/);
      assert.match(text, /shipping skill and use its task-scoped helper/);
      assert.match(text, /Preserve unrelated staged, unstaged, untracked, and ignored files/);
      assert.match(text, /Do not merge PRs or delete artifacts merely because deployment was requested/);
      assert.match(text, /required migrations must precede code/);
      assert.match(text, /pending until the rollout is confirmed/);
      assert.doesNotMatch(text, /treat the dirty tree as the release contents|deploy the entire current worktree|prefer repository-scoped/);
    });
  }

  it("keeps an omitted target unresolved until project defaults are checked and supports non-Git provenance", async () => {
    let prompt = "";
    let probes = 0;
    await deploy({
      async exec(command: string, args: string[]) {
        probes++; assert.equal(command, "git"); assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
        return { code: 128, stdout: "", stderr: "not a git repository", killed: false };
      },
      sendUserMessage(text: string) { prompt = text; },
    } as any, "  ", { cwd, hasUI: true, isIdle: () => true, ui: { notify() {} } } as any);
    assert.equal(probes, 1);
    assert.match(prompt, /resolve the documented project default/);
    assert.match(prompt, /only an unambiguous documented project default/);
    assert.match(prompt, /NOT_A_GIT_REPO=1/);
    assert.match(prompt, /For non-Git projects, identify an immutable artifact\/digest/);
    assert.doesNotMatch(prompt, /git_head=/);
  });
});
