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
    assert.match(active.systemPrompt, /specialists implement every code/);
    assert.match(active.systemPrompt, /Skip it when you can already name the exact target files/);
    assert.match(active.systemPrompt, /Parallel writers require isolated worktrees plus scoped patch integration/);
    assert.match(active.systemPrompt, /Use `task_start` only for one cohesive slice/);
    assert.match(active.systemPrompt, /Use synchronous `task` for one-shot barriers/);
    assert.match(active.systemPrompt, /Scout discovery, Verifier\/Stevedore integrated checks/);
    assert.match(active.systemPrompt, /Inspector and Verifier may run concurrently/);
    assert.match(active.systemPrompt, /Oracle reviews the verified final diff/);
    assert.match(active.systemPrompt, /use `mission` with explicit nodes and dependencies/);
    assert.match(active.systemPrompt, /If a proposed writer prompt names 3\+ components\/packages/);
    assert.match(active.systemPrompt, /Never send a broad "implement the stage\/feature" mission/);
    assert.match(active.systemPrompt, /writer prompt generations are limited to one corrective generation/);
    assert.match(active.systemPrompt, /Acceptance-Status: complete\|partial\|incomplete\|failed/);
    assert.match(active.systemPrompt, /single-active worker time dominated/);
    assert.match(active.systemPrompt, /Every implementation diff still requires Oracle review/);
    assert.match(active.systemPrompt, /UI behavior still requires one Inspector pass/);
    assert.match(active.systemPrompt, /through Verifier or Stevedore verification-only mode/);
    assert.match(active.systemPrompt, /Advisor remains required for consequential choices/);
    assert.match(active.systemPrompt, /This mode overrides inline implementation/);
    assert.doesNotMatch(active.systemPrompt, /tiny integration fixes/);
    assert.doesNotMatch(active.systemPrompt, /Prefer `task_start`/);

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
