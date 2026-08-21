import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { renderFleetCollapsed } from "../../presentation/fleet-view.ts";
import {
  currentFleetSnapshot,
  publishFleetSnapshot,
  resetFleetBus,
  subscribeFleetSnapshot,
} from "../fleet-bus.ts";

beforeEach(() => {
  resetFleetBus();
});

describe("renderFleetCollapsed", () => {
  it("returns undefined with no live workers", () => {
    assert.equal(renderFleetCollapsed([]), undefined);
  });

  it("summarizes live workers on one bounded line", () => {
    const now = 1_000_000;
    const line = renderFleetCollapsed(
      [
        {
          id: "task_1",
          agent: "oracle",
          lifecycle: "running",
          createdAt: now - 4 * 60_000,
          lastEventAt: now - 4 * 60_000,
        },
        {
          id: "task_2",
          agent: "machinist",
          lifecycle: "aborting",
          createdAt: now - 12 * 60_000,
          lastEventAt: now - 12 * 60_000,
        },
      ],
      now,
    );
    assert.equal(line, "2 agents · oracle running 4m · machinist killed 12m");
  });
});

describe("fleet bus", () => {
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
