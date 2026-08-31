import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  configuredWorkerLimit,
  DEFAULT_MAX_LIVE_WORKERS,
} from "../worker-runtime.ts";

describe("configuredWorkerLimit", () => {
  it("uses the bounded environment value and falls back for invalid input", () => {
    assert.equal(configuredWorkerLimit("5"), 5);
    assert.equal(configuredWorkerLimit("0"), DEFAULT_MAX_LIVE_WORKERS);
    assert.equal(configuredWorkerLimit("9"), DEFAULT_MAX_LIVE_WORKERS);
    assert.equal(configuredWorkerLimit("many"), DEFAULT_MAX_LIVE_WORKERS);
  });
});
