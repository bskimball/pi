import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  deleteWorkerSidecar,
  listWorkerSidecars,
  readWorkerSidecar,
  writeWorkerSidecar,
  type WorkerSidecar,
} from "../worker-sidecar.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(root: string, instanceId = "worker-a"): WorkerSidecar {
  return {
    version: 1, instanceId, id: "task_1", agent: "machinist", mission: "test",
    cwd: root, model: "provider/model", thinking: "high",
    sessionDir: path.join(root, instanceId), pid: 123, parentPid: 456,
    createdAt: 1, updatedAt: 2, lifecycle: "running", generation: 1, closed: false,
  };
}

describe("worker sidecar", () => {
  it("writes, reads, lists, and deletes atomically stored metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sidecar-"));
    roots.push(root);
    const first = fixture(root);
    const second = fixture(root, "worker-b");
    writeWorkerSidecar(first);
    writeWorkerSidecar(second);
    assert.deepEqual(readWorkerSidecar(first.sessionDir), first);
    assert.deepEqual(listWorkerSidecars(root).map((item) => item.instanceId).sort(), ["worker-a", "worker-b"]);
    deleteWorkerSidecar(first.sessionDir);
    assert.equal(readWorkerSidecar(first.sessionDir), undefined);
  });

  it("scans past empty session directories before applying the list cap", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sidecar-"));
    roots.push(root);
    for (let index = 0; index < 32; index++) {
      fs.mkdirSync(path.join(root, `empty-${String(index).padStart(2, "0")}`));
    }
    const sidecar = fixture(root, "worker-z");
    writeWorkerSidecar(sidecar);
    assert.deepEqual(listWorkerSidecars(root).map((item) => item.instanceId), ["worker-z"]);
  });
});
