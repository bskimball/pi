import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configuredSyncTaskLimit } from "../../amp-task.ts";

describe("configuredSyncTaskLimit", () => {
  it("matches the bounded shared concurrency contract", () => {
    assert.equal(configuredSyncTaskLimit("4"), 4);
    assert.equal(configuredSyncTaskLimit("0"), 3);
    assert.equal(configuredSyncTaskLimit("9"), 3);
  });
});
