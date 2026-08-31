import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findDuplicateTask,
  normalizeTaskWorkOrder,
  type DuplicateTaskCandidate,
} from "../task-start-policy.ts";

function worker(
  overrides: Partial<DuplicateTaskCandidate> = {},
): DuplicateTaskCandidate {
  return {
    id: "task_1",
    agent: "machinist",
    cwd: process.cwd(),
    initialPrompt: "Goal: Implement the provider adapter\nTarget: src/provider.ts",
    lifecycle: "running",
    closed: false,
    ...overrides,
  };
}

describe("task-start duplicate policy", () => {
  it("normalizes mission whitespace, case, and Unicode width", () => {
    assert.equal(
      normalizeTaskWorkOrder("  Implement\nＴＨＥ   Provider Adapter  "),
      "implement the provider adapter",
    );
  });

  it("finds the same live agent, cwd, and normalized mission", () => {
    const existing = worker();
    const duplicate = findDuplicateTask(
      [existing],
      "machinist",
      `${process.cwd()}/`,
      " goal: implement THE provider adapter\n target: src/provider.ts ",
    );
    assert.equal(duplicate?.id, "task_1");
  });

  it("allows distinct agents, directories, and missions", () => {
    const existing = worker();
    assert.equal(
      findDuplicateTask([existing], "oracle", existing.cwd, existing.initialPrompt),
      undefined,
    );
    assert.equal(
      findDuplicateTask([existing], existing.agent, `${existing.cwd}-other`, existing.initialPrompt),
      undefined,
    );
    assert.equal(
      findDuplicateTask([existing], existing.agent, existing.cwd, "Review the provider adapter"),
      undefined,
    );
  });

  it("allows the same heading when the work-order body differs", () => {
    const existing = worker();
    assert.equal(
      findDuplicateTask(
        [existing],
        existing.agent,
        existing.cwd,
        "Goal: Implement the provider adapter\nTarget: src/other-provider.ts",
      ),
      undefined,
    );
  });

  it("rejects exact normalized work orders while starting", () => {
    const existing = worker({ lifecycle: "starting" });
    assert.equal(
      findDuplicateTask([existing], existing.agent, existing.cwd, existing.initialPrompt)?.id,
      existing.id,
    );
  });

  it("ignores settled, failed, and closed workers", () => {
    for (const candidate of [
      worker({ lifecycle: "settled" }),
      worker({ lifecycle: "failed" }),
      worker({ closed: true }),
    ]) {
      assert.equal(
        findDuplicateTask([candidate], candidate.agent, candidate.cwd, candidate.initialPrompt),
        undefined,
      );
    }
  });
});
