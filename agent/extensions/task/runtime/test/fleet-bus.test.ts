import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  currentFleetSnapshot,
  fleetSnapshotKey,
  publishFleetSnapshot,
  resetFleetBus,
  subscribeFleetSnapshot,
} from "../fleet-bus.ts";

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
      { fusion: false },
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
        fusion: true,
        activity: [
          { tool: "z".repeat(100), status: "running" },
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
    assert.equal(item.phase, "tool");
    assert.equal(item.turns, 7);
    assert.equal(item.maxTurns, 40);
    assert.equal(item.generation, 3);
    assert.equal(item.waitingUi, 2);
    assert.equal(item.fusion, true);
    assert.equal(item.activity?.length, 4, "activity capped at 4 entries");
    assert.equal(item.activity?.[0]?.tool.length, 24, "activity tool bounded");
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
    assert.equal(bare.fusion, undefined);
    assert.equal(bare.activity, undefined);
  });

  it("repaints on activity changes but not on heartbeats", () => {
    const base = {
      id: "task_1",
      agent: "scout",
      lifecycle: "running",
      createdAt: 1,
      phase: "tool",
      tool: "bash",
      activity: [{ tool: "bash", status: "running" }],
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
        { ...base, activity: [{ tool: "bash", status: "completed" }] },
      ]),
      before,
      "tool end repaints via the activity status",
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
});
