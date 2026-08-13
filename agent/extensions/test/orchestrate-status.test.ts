import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { default: promptCommands, orchestrateStatusText } = await import(
  "../prompt-commands.ts"
);

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
