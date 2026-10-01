import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  boundControlMessage,
  currentFleetSnapshot,
  fleetSnapshotKey,
  FLEET_CONTROL_KEY,
  installFleetControl,
  isAgentWorkspaceOpen,
  publishFleetSnapshot,
  removeFleetControl,
  resetFleetBus,
  subscribeFleetSnapshot,
  WORKSPACE_OPEN_KEY,
  type FleetControl,
} from "../fleet-bus.ts";
import { sendModeAllowed } from "../../async-task.ts";

beforeEach(() => {
  resetFleetBus();
});

describe("fleet bus", () => {
  it("ignores heartbeat-only changes in the render key", () => {
    const structural = {
      id: "task_1",
      agent: "scout",
      lifecycle: "running",
      createdAt: 1,
    };
    const before = fleetSnapshotKey([structural]);
    const after = fleetSnapshotKey([
      { ...structural, lastEventAt: 99_999 },
    ]);
    assert.equal(after, before);
    assert.notEqual(
      fleetSnapshotKey([{ ...structural, lifecycle: "compacting" }]),
      before,
    );
  });

  it("repaints on structural worker fields but not on heartbeats", () => {
    const base = {
      id: "task_1",
      agent: "scout",
      lifecycle: "running",
      createdAt: 1,
      phase: "model",
      turns: 7,
      generation: 3,
      waitingUi: 0,
      fusion: true,
    };
    const before = fleetSnapshotKey([base]);
    assert.equal(
      fleetSnapshotKey([{ ...base, lastEventAt: 99_999 }]),
      before,
      "pure heartbeat does not change the key",
    );
    for (const delta of [
      { phase: "tool" },
      { tool: "bash" },
      { turns: 8 },
      { generation: 4 },
      { waitingUi: 1 },
      { mission: "Steer the dock" },
      { directive: { queued: true, text: "Stop and answer" } },
      { fusion: false },
      { sessionFile: "/tmp/worker.jsonl" },
    ]) {
      assert.notEqual(
        fleetSnapshotKey([{ ...base, ...delta }]),
        before,
        `structural change repaints: ${JSON.stringify(delta)}`,
      );
    }
  });

  it("sanitizes and bounds the new dock fields on publish", () => {
    publishFleetSnapshot([
      {
        id: "task_1",
        agent: "scout",
        lifecycle: "running",
        createdAt: 1,
        phase: "tool",
        tool: "x".repeat(100),
        turns: 7,
        maxTurns: 40,
        generation: 3,
        waitingUi: 2,
        mission: "y".repeat(200),
        directive: { queued: true, text: "z".repeat(200) },
        fusion: true,
        activity: [
          { tool: "z".repeat(100), summary: "s".repeat(200), status: "running" },
          { tool: "read", status: "completed" },
          { tool: "bash", status: "error" },
          { tool: "write", status: "completed" },
          { tool: "extra", status: "completed" },
        ],
      } as any,
    ]);
    const [item] = currentFleetSnapshot();
    assert.equal(item.tool?.length, 24, "tool bounded to 24 chars");
    assert.equal(item.mission?.length, 80, "mission bounded to 80 chars");
    assert.equal(item.directive?.text.length, 80, "directive text bounded to 80 chars");
    assert.equal(item.directive?.queued, true);
    assert.equal(item.phase, "tool");
    assert.equal(item.turns, 7);
    assert.equal(item.maxTurns, 40);
    assert.equal(item.generation, 3);
    assert.equal(item.waitingUi, 2);
    assert.equal(item.fusion, true);
    assert.equal(item.activity?.length, 4, "activity capped at 4 entries");
    assert.equal(item.activity?.[0]?.tool.length, 24, "activity tool bounded");
    assert.equal(item.activity?.[0]?.summary?.length, 120, "activity summary bounded");
    assert.equal(item.activity?.[0]?.status, "running");
    assert.equal(item.sessionFile, undefined, "sessionFile absent stays undefined");

    publishFleetSnapshot([
      { id: "task_3", agent: "scout", lifecycle: "running", createdAt: 3, sessionFile: "/tmp/w.jsonl" } as any,
    ]);
    assert.equal(currentFleetSnapshot()[0]?.sessionFile, "/tmp/w.jsonl");

    publishFleetSnapshot([
      { id: "task_2", agent: "scout", lifecycle: "running", createdAt: 2 },
    ]);
    const [bare] = currentFleetSnapshot();
    assert.equal(bare.phase, undefined, "absent fields stay undefined");
    assert.equal(bare.tool, undefined);
    assert.equal(bare.turns, undefined);
    assert.equal(bare.maxTurns, undefined);
    assert.equal(bare.generation, undefined);
    assert.equal(bare.waitingUi, undefined);
    assert.equal(bare.mission, undefined);
    assert.equal(bare.directive, undefined);
    assert.equal(bare.fusion, undefined);
    assert.equal(bare.activity, undefined);

    publishFleetSnapshot([
      {
        id: "task_4",
        agent: "scout",
        lifecycle: "running",
        createdAt: 4,
        directive: { queued: false, text: "" },
      } as any,
    ]);
    assert.equal(
      currentFleetSnapshot()[0]?.directive,
      undefined,
      "empty directive text is omitted",
    );
  });

  it("repaints on a directive-only change", () => {
    const base = {
      id: "task_1",
      agent: "scout",
      lifecycle: "running",
      createdAt: 1,
      mission: "Steer the dock",
    };
    const before = fleetSnapshotKey([base]);
    assert.notEqual(
      fleetSnapshotKey([{ ...base, directive: { queued: true, text: "Stop editing" } }]),
      before,
      "queued directive is structural",
    );
    assert.notEqual(
      fleetSnapshotKey([
        { ...base, directive: { queued: true, text: "Stop editing" } },
      ]),
      fleetSnapshotKey([
        { ...base, directive: { queued: false, text: "Stop editing" } },
      ]),
      "queued vs delivered is structural",
    );
  });

  it("repaints on a model-only change", () => {
    const base = {
      id: "task_1",
      agent: "scout",
      lifecycle: "running",
      createdAt: 1,
      mission: "Steer the dock",
    };
    const before = fleetSnapshotKey([base]);
    assert.equal(
      fleetSnapshotKey([{ ...base, lastEventAt: 99_999 }]),
      before,
      "pure heartbeat does not change the key",
    );
    assert.notEqual(
      fleetSnapshotKey([{ ...base, model: "local-proxy/grok-4.5" }]),
      before,
      "resolved model is structural",
    );
  });

  it("bounds the resolved model on publish", () => {
    publishFleetSnapshot([
      {
        id: "task_1",
        agent: "scout",
        lifecycle: "running",
        createdAt: 1,
        model: "m".repeat(200),
      } as any,
    ]);
    assert.equal(currentFleetSnapshot()[0]?.model?.length, 80, "model bounded to 80 chars");
  });

  it("repaints on activity changes but not on heartbeats", () => {
    const base = {
      id: "task_1",
      agent: "scout",
      lifecycle: "running",
      createdAt: 1,
      phase: "tool",
      tool: "bash",
      activity: [{ tool: "bash", summary: "npm test", status: "running" }],
    };
    const before = fleetSnapshotKey([base]);
    assert.equal(
      fleetSnapshotKey([{ ...base, lastEventAt: 99_999 }]),
      before,
      "pure heartbeat does not change the key",
    );
    assert.notEqual(
      fleetSnapshotKey([
        {
          ...base,
          activity: [
            { tool: "bash", status: "running" },
            { tool: "read", status: "completed" },
          ],
        },
      ]),
      before,
      "tool start repaints via the activity list",
    );
    assert.notEqual(
      fleetSnapshotKey([
        { ...base, activity: [{ tool: "bash", summary: "npm test", status: "completed" }] },
      ]),
      before,
      "tool end repaints via the activity status",
    );
    assert.notEqual(
      fleetSnapshotKey([
        { ...base, activity: [{ tool: "bash", summary: "npm run lint", status: "running" }] },
      ]),
      before,
      "operation target change repaints",
    );
  });

  it("publishes a snapshot to subscribers without stacking widgets", () => {
    const seen: number[] = [];
    const stop = subscribeFleetSnapshot((items) => {
      seen.push(items.length);
    });
    publishFleetSnapshot([
      {
        id: "task_1",
        agent: "scout",
        lifecycle: "running",
        createdAt: 1,
      },
    ]);
    assert.equal(currentFleetSnapshot().length, 1);
    assert.deepEqual(seen, [0, 1]);
    stop();
    publishFleetSnapshot([]);
    assert.deepEqual(seen, [0, 1]);
  });

  it("bounds control messages to a single short line", () => {
    assert.equal(boundControlMessage("task_1 steer queued."), "task_1 steer queued.");
    assert.equal(boundControlMessage("line one\nline two"), "line one line two");
    assert.equal(boundControlMessage(""), "");
    const long = boundControlMessage("x".repeat(500));
    assert.ok(long.length <= 200, `bounded, got ${long.length}`);
    assert.match(long, /\.\.\.$/);
  });

});

describe("fleet control channel", () => {
  type ControlRoot = typeof globalThis & {
    [FLEET_CONTROL_KEY]?: FleetControl;
  };

  afterEach(() => {
    delete (globalThis as ControlRoot)[FLEET_CONTROL_KEY];
  });

  function stubControl(): FleetControl {
    return {
      send: async () => ({ ok: true, message: "sent" }),
      abort: async () => ({ ok: true, message: "aborted" }),
      close: async () => ({ ok: true, message: "closed" }),
    };
  }

  it("installs and only removes its own control object", () => {
    const ours = stubControl();
    installFleetControl(ours);
    assert.equal((globalThis as ControlRoot)[FLEET_CONTROL_KEY], ours);
    removeFleetControl(stubControl());
    assert.equal(
      (globalThis as ControlRoot)[FLEET_CONTROL_KEY],
      ours,
      "a foreign object must not uninstall the channel",
    );
    removeFleetControl(ours);
    assert.equal((globalThis as ControlRoot)[FLEET_CONTROL_KEY], undefined);
  });

  it("pins the send-mode lifecycle matrix", () => {
    for (const lifecycle of ["starting", "running", "retrying", "compacting", "aborting"] as const) {
      assert.equal(sendModeAllowed(lifecycle, "steer"), true, `${lifecycle} accepts steer`);
      assert.equal(sendModeAllowed(lifecycle, "prompt"), false, `${lifecycle} refuses prompt`);
      assert.equal(sendModeAllowed(lifecycle, "follow_up"), true, `${lifecycle} accepts follow_up`);
    }
    for (const lifecycle of ["settled", "failed"] as const) {
      assert.equal(sendModeAllowed(lifecycle, "steer"), false, `${lifecycle} refuses steer`);
      assert.equal(sendModeAllowed(lifecycle, "prompt"), true, `${lifecycle} accepts prompt`);
      assert.equal(sendModeAllowed(lifecycle, "follow_up"), true, `${lifecycle} accepts follow_up`);
    }
    assert.equal(sendModeAllowed("closed", "steer"), false, "closed refuses steer");
    assert.equal(sendModeAllowed("closed", "prompt"), false, "closed refuses prompt");
  });

  it("routes the installed control through the shared tool functions", async () => {
    // Load the real extension on a mock pi: installFleetControl runs at load,
    // so the global object below is the one wired to executeTaskSend/Abort/Close.
    const previousTaskUi = process.env.PI_TASK_UI;
    process.env.PI_TASK_UI = "0";
    try {
      const mockPi = {
        registerTool() {},
        registerCommand() {},
        registerMessageRenderer() {},
        events: { on() {} },
        on() {},
        sendMessage() {},
        appendEntry() {},
        getThinkingLevel() {},
      };
      const mod = await import("../../async-task.ts");
      (mod.default as (pi: unknown) => void)(mockPi);
    } finally {
      if (previousTaskUi === undefined) delete process.env.PI_TASK_UI;
      else process.env.PI_TASK_UI = previousTaskUi;
    }
    const control = (globalThis as ControlRoot)[FLEET_CONTROL_KEY];
    assert.ok(control, "extension load installs the control");
    // No worker records exist in this process: every refusal below comes out
    // of the same shared functions the tools execute, with identical text.
    assert.deepEqual(await control.send("task_999", "steer", "hello"), {
      ok: false,
      message: 'Unknown worker "task_999".',
    });
    assert.deepEqual(await control.send("", "steer", "hello"), {
      ok: false,
      message: "id is required.",
    });
    assert.deepEqual(await control.send("task_999", "steer", "   "), {
      ok: false,
      message: "message is required.",
    });
    assert.deepEqual(await control.abort("task_999"), {
      ok: false,
      message: 'Unknown worker "task_999".',
    });
    assert.deepEqual(await control.close("task_999"), {
      ok: false,
      message: 'Unknown worker "task_999".',
    });
  });

  it("exposes the Agents workspace-open flag Fusion Escape abort reads", () => {
    assert.equal(isAgentWorkspaceOpen(), false);
    (globalThis as typeof globalThis & { [WORKSPACE_OPEN_KEY]?: boolean })[WORKSPACE_OPEN_KEY] = true;
    assert.equal(isAgentWorkspaceOpen(), true);
    resetFleetBus();
    assert.equal(isAgentWorkspaceOpen(), false);
  });
});
