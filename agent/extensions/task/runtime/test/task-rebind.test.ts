import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyWorkerSidecar, rebindFusion, type WorkerSidecar } from "../worker-sidecar.ts";

const sidecar: WorkerSidecar = {
  version: 1, instanceId: "instance", id: "task_1", agent: "machinist", mission: "test",
  cwd: "/work", sessionDir: "/sessions/instance", pid: 42, parentPid: 7,
  createdAt: 1, updatedAt: 2, lifecycle: "running", generation: 1, closed: false,
};

describe("task rebind classification", () => {
  it("distinguishes live orphans, dead candidates, registered, and closed workers", () => {
    assert.equal(classifyWorkerSidecar(sidecar, { registered: false, pidAlive: () => true }), "orphan");
    assert.equal(classifyWorkerSidecar(sidecar, { registered: false, pidAlive: () => false }), "rebind");
    assert.equal(classifyWorkerSidecar(sidecar, { registered: true, pidAlive: () => false }), "skip");
    assert.equal(classifyWorkerSidecar({ ...sidecar, closed: true }, { registered: false, pidAlive: () => false }), "skip");
  });

  it("preserves Fusion identity across rebind only while the pair is configured", () => {
    assert.deepEqual(
      rebindFusion({ fusion: true, fusionParentSessionId: "parent-1" }, true),
      { fusion: true, fusionParentSessionId: "parent-1" },
    );
    assert.deepEqual(rebindFusion({ fusion: true }, true), { fusion: true });
    assert.deepEqual(
      rebindFusion({ fusion: true, fusionParentSessionId: "parent-1" }, false),
      { fusion: false },
      "unconfigured pair resumes as an ordinary worker instead of a model-less sidekick",
    );
    assert.deepEqual(rebindFusion(undefined, true), { fusion: false });
    assert.deepEqual(rebindFusion({ fusion: false }, true), { fusion: false });
    assert.deepEqual(rebindFusion({}, true), { fusion: false });
  });
});
