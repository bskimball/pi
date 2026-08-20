import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyWorkerSidecar, type WorkerSidecar } from "../worker-sidecar.ts";

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
});
