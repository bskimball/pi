import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderFleetCollapsed } from "../../presentation/fleet-view.ts";

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
