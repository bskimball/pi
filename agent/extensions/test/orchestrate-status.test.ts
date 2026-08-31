import assert from "node:assert/strict";
import { describe, it } from "node:test";

const {
  default: promptCommands,
  ORCHESTRATE_SYSTEM_BLOCK,
  orchestrateStatusText,
} = await import("../prompt-commands.ts");

type StatusCall = [string, string | undefined];

function loadExtension(persisted: Array<{ enabled: boolean }> = []) {
  const commands: Record<
    string,
    (args: string, ctx: unknown) => unknown | Promise<unknown>
  > = {};
  const listeners: Record<string, Array<(e: unknown, c: unknown) => unknown>> = {};
  const entries: Array<{ type: string; data: unknown }> = [];

  promptCommands({
    registerCommand(name: string, spec: { handler: typeof commands[string] }) {
      commands[name] = spec.handler;
    },
    registerTool() {},
    registerShortcut() {},
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    on(event: string, handler: (e: unknown, c: unknown) => unknown) {
      (listeners[event] ??= []).push(handler);
    },
  } as any);

  const statuses: StatusCall[] = [];
  const notices: string[] = [];
  let setFooterCalls = 0;
  const ctx = {
    hasUI: true,
    ui: {
      theme: undefined,
      setStatus(key: string, text: string | undefined) {
        statuses.push([key, text]);
      },
      setFooter() {
        setFooterCalls++;
      },
      notify(message: string) {
        notices.push(message);
      },
    },
    sessionManager: {
      getEntries: () =>
        persisted.map(({ enabled }) => ({
          type: "custom",
          customType: "orchestrate-mode",
          data: { enabled },
        })),
    },
  };

  return {
    statuses,
    notices,
    entries,
    get setFooterCalls() {
      return setFooterCalls;
    },
    orchestrate: (args: string) =>
      Promise.resolve(commands.orchestrate!(args, ctx)),
    emit: async (event: string) => {
      for (const handler of listeners[event] ?? []) await handler({}, ctx);
    },
    beforeAgentStart: async (systemPrompt = "base prompt") => {
      const results = [];
      for (const handler of listeners.before_agent_start ?? []) {
        results.push(await handler({ systemPrompt }, ctx));
      }
      return results.at(-1);
    },
  };
}

describe("orchestrateStatusText", () => {
  it("uses a compact ASCII label and warning theme", () => {
    const calls: Array<[string, string]> = [];
    assert.equal(
      orchestrateStatusText(true, {
        fg(key, text) {
          calls.push([key, text]);
          return `<${text}>`;
        },
      }),
      "<orchestrator>",
    );
    assert.deepEqual(calls, [["warning", "orchestrator"]]);
  });

  it("clears when off and falls back when theme throws", () => {
    assert.equal(orchestrateStatusText(false), undefined);
    assert.equal(
      orchestrateStatusText(true, { fg() { throw new Error("theme"); } }),
      "orchestrator",
    );
  });
});

describe("strict orchestrator prompt", () => {
  it("injects only while enabled and carries bounded delegation semantics", async () => {
    const state = loadExtension();
    assert.equal(await state.beforeAgentStart(), undefined);

    await state.orchestrate("on");
    const active = (await state.beforeAgentStart()) as {
      systemPrompt: string;
    };
    assert.ok(active.systemPrompt.startsWith("base prompt"));
    assert.ok(active.systemPrompt.endsWith(ORCHESTRATE_SYSTEM_BLOCK));
    assert.match(active.systemPrompt, /Delegate implementation units/);
    assert.match(active.systemPrompt, /When implementation needs repository scanning/);
    assert.match(active.systemPrompt, /Parallel writers require isolated worktrees/);
    assert.match(active.systemPrompt, /fan out up to 5/);
    assert.match(active.systemPrompt, /at most 3 live at once/);
    assert.match(active.systemPrompt, /rolling pipeline instead of lockstep waves/);
    assert.match(active.systemPrompt, /Merge or `worktree remove` a writer tree only after that tree's Oracle returns/);
    assert.match(active.systemPrompt, /do not hold a settled worker for possible follow-up/);
    assert.match(active.systemPrompt, /a clean sequential merge does not get a second Oracle review/);
    assert.match(active.systemPrompt, /reaches acceptance stops/);
    assert.match(active.systemPrompt, /cheapest-applicable local correctness check/);
    assert.match(active.systemPrompt, /After all writers have settled/);
    assert.match(
      active.systemPrompt,
      /Every implementation diff gets a fresh-eyes Oracle review/,
    );
    assert.match(active.systemPrompt, /Oracle returns an exact diagnostic experiment plan and stops/);
    assert.match(active.systemPrompt, /absolute target worktree\/root/);
    assert.match(active.systemPrompt, /persistent repository fixtures go through a normal writer and Oracle review first/);
    assert.match(active.systemPrompt, /fresh Stevedore verification-only pass/);
    assert.match(active.systemPrompt, /Run another combined pass only after those fixes settle/);
    assert.match(
      active.systemPrompt,
      /Never run integrated gates inside Artisan\/Machinist/,
    );
    assert.match(active.systemPrompt, /UI and interaction slices are proven on the live page through Inspector/);
    assert.match(active.systemPrompt, /writer-local checks and a passing Stevedore gate are not that proof/);
    assert.match(active.systemPrompt, /Route live browser and screenshot checks to Inspector/);
    assert.match(active.systemPrompt, /use Artisan only when verification requires design judgment/);
    assert.match(active.systemPrompt, /security-sensitive architecture, migrations/);
    assert.match(active.systemPrompt, /destructive data changes, public API architecture/);
    assert.match(active.systemPrompt, /other consequential approach choices/);
    assert.match(active.systemPrompt, /specialists return conflicting findings/);
    assert.match(active.systemPrompt, /do not implement code inline in this mode/);
    assert.doesNotMatch(active.systemPrompt, /tiny integration fixes/);
    assert.match(active.systemPrompt, /one `task_wait` per worker/);
    assert.match(active.systemPrompt, /900s machinist\/artisan; 1200s oracle\/stevedore\/inspector/);
    assert.match(active.systemPrompt, /Do not poll with `task_status`\/`task_wait` loops/);
    assert.match(active.systemPrompt, /Timeout is not a poll cue and does not kill the worker/);
    assert.match(active.systemPrompt, /blocked for 60s unless `timeoutSec` is longer than the last wait/);
    assert.match(active.systemPrompt, /Keep returned evidence compact/);

    await state.orchestrate("off");
    assert.equal(await state.beforeAgentStart(), undefined);
  });
});

describe("/orchestrate stock-footer status", () => {
  it("sets and clears only the orchestrate status", async () => {
    const state = loadExtension();
    await state.orchestrate("on");
    await state.orchestrate("off");
    assert.deepEqual(state.statuses, [
      ["orchestrate", "orchestrator"],
      ["orchestrate", undefined],
    ]);
    assert.equal(state.setFooterCalls, 0);
  });

  it("resyncs when already on without duplicate persistence", async () => {
    const state = loadExtension();
    await state.orchestrate("on");
    await state.orchestrate("on");
    assert.deepEqual(state.statuses, [
      ["orchestrate", "orchestrator"],
      ["orchestrate", "orchestrator"],
    ]);
    assert.equal(state.entries.length, 1);
    assert.equal(state.notices.at(-1), "Orchestrator mode already on.");
    assert.equal(state.setFooterCalls, 0);
  });
});

describe("session_start stock-footer status", () => {
  it("restores on from persisted state", async () => {
    const state = loadExtension([{ enabled: true }]);
    await state.emit("session_start");
    assert.deepEqual(state.statuses, [["orchestrate", "orchestrator"]]);
    assert.equal(state.setFooterCalls, 0);
  });

  it("restores off or absent state by clearing", async () => {
    const off = loadExtension([{ enabled: true }, { enabled: false }]);
    await off.emit("session_start");
    assert.deepEqual(off.statuses, [["orchestrate", undefined]]);

    const absent = loadExtension();
    await absent.emit("session_start");
    assert.deepEqual(absent.statuses, [["orchestrate", undefined]]);
    assert.equal(off.setFooterCalls + absent.setFooterCalls, 0);
  });
});
