import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configuredSyncTaskLimit } from "../../amp-task.ts";

describe("configuredSyncTaskLimit", () => {
  it("matches the bounded shared concurrency contract", () => {
    assert.equal(configuredSyncTaskLimit(undefined), 5);
    assert.equal(configuredSyncTaskLimit("1"), 1);
    assert.equal(configuredSyncTaskLimit("4"), 4);
    assert.equal(configuredSyncTaskLimit("8"), 8);
    assert.equal(configuredSyncTaskLimit("0"), 5);
    assert.equal(configuredSyncTaskLimit("9"), 5);
    assert.equal(configuredSyncTaskLimit("many"), 5);
  });
});
