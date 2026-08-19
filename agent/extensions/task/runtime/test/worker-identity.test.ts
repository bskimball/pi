import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JobRegistry } from "../job-registry.ts";
import {
  createWorkerIdentity,
  findWorkerByHandle,
  findWorkerByInstance,
} from "../worker-identity.ts";

describe("async worker identity", () => {
  it("keeps the short handle separate from the immutable registry key", () => {
    const first = createWorkerIdentity(1, () => "session-a");
    const resumed = createWorkerIdentity(1, () => "session-b");

    assert.equal(first.id, "task_1");
    assert.equal(resumed.id, "task_1");
    assert.notEqual(first.instanceId, resumed.instanceId);
  });

  it("binds historical render state by UUID instead of a reused handle", () => {
    const registry = new JobRegistry<{ instanceId: string; id: string; title: string }>();
    const historical = {
      ...createWorkerIdentity(1, () => "session-a"),
      title: "Historical task",
    };
    const resumed = {
      ...createWorkerIdentity(1, () => "session-b"),
      title: "Resumed task",
    };

    registry.set(historical.instanceId, historical);
    registry.set(resumed.instanceId, resumed);

    assert.equal(findWorkerByHandle(registry.values(), "task_1"), historical);
    assert.equal(findWorkerByInstance(registry, historical.instanceId), historical);
    assert.equal(findWorkerByInstance(registry, resumed.instanceId), resumed);
  });
});
