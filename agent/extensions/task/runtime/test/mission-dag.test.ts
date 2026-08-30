import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  incompleteMissionReport,
  missionTelemetry,
  missionWriterConflict,
  readyMissionNodes,
  skipBlockedMissionNodes,
  substituteMissionResults,
  validateMissionNodes,
  type MissionNodeState,
} from "../mission-dag.ts";

describe("mission DAG validation", () => {
  it("rejects duplicate, unknown, and cyclic dependencies", () => {
    assert.match(
      validateMissionNodes([
        { id: "a", agent: "scout", prompt: "x" },
        { id: "a", agent: "oracle", prompt: "y" },
      ]) ?? "",
      /duplicate/,
    );
    assert.match(
      validateMissionNodes([
        {
          id: "a",
          agent: "scout",
          prompt: "x",
          dependsOn: ["missing"],
        },
      ]) ?? "",
      /unknown/,
    );
    assert.match(
      validateMissionNodes([
        { id: "a", agent: "scout", prompt: "x", dependsOn: ["b"] },
        { id: "b", agent: "oracle", prompt: "y", dependsOn: ["a"] },
      ]) ?? "",
      /cycle/,
    );
  });

  it("makes only satisfied nodes ready and skips failed descendants", () => {
    const nodes: MissionNodeState[] = [
      { id: "a", agent: "scout", prompt: "x", status: "failed" },
      {
        id: "b",
        agent: "oracle",
        prompt: "y",
        dependsOn: ["a"],
        status: "pending",
      },
      { id: "c", agent: "verifier", prompt: "z", status: "pending" },
    ];
    assert.deepEqual(
      readyMissionNodes(nodes).map((node) => node.id),
      ["c"],
    );
    assert.equal(skipBlockedMissionNodes(nodes), 1);
    assert.equal(nodes[1].status, "skipped");
  });

  it("substitutes only declared dependency reports", () => {
    assert.equal(
      substituteMissionResults(
        "review {{build}} {{other}}",
        ["build"],
        new Map([
          ["build", "ok"],
          ["other", "no"],
        ]),
      ),
      "review ok {{other}}",
    );
  });

  it("classifies explicit incomplete acceptance reports as failures", () => {
    assert.match(
      incompleteMissionReport("Outcome: Main wiring remains incomplete.\nAcceptance-Status: partial") ?? "",
      /incomplete acceptance/,
    );
    assert.equal(incompleteMissionReport("Acceptance-Status: complete"), undefined);
    assert.match(
      incompleteMissionReport("The partial implementation bug is fixed.") ?? "",
      /missing final/,
    );
    assert.match(incompleteMissionReport("Acceptance criteria met.") ?? "", /missing final/);
    assert.match(
      incompleteMissionReport("Acceptance-Status: failed\nAdditional prose") ?? "",
      /missing final/,
    );
  });

  it("rejects multiple writers sharing one worktree", () => {
    assert.match(
      missionWriterConflict(
        [
          { id: "a", agent: "machinist", prompt: "x", cwd: "same" },
          { id: "b", agent: "scribe", prompt: "y", cwd: "same" },
        ],
        () => true,
        (cwd) => cwd ?? "root",
      ) ?? "",
      /share a worktree/,
    );
    assert.equal(
      missionWriterConflict(
        [
          { id: "a", agent: "machinist", prompt: "x", cwd: "same" },
          {
            id: "b",
            agent: "scribe",
            prompt: "y",
            cwd: "same",
            dependsOn: ["a"],
          },
        ],
        () => true,
        (cwd) => cwd ?? "root",
      ),
      undefined,
    );
  });

  it("calculates elapsed worker utilization and peak concurrency", () => {
    const nodes: MissionNodeState[] = [
      {
        id: "a",
        agent: "scout",
        prompt: "x",
        status: "succeeded",
        startedAt: 0,
        endedAt: 100,
      },
      {
        id: "b",
        agent: "oracle",
        prompt: "y",
        status: "succeeded",
        startedAt: 50,
        endedAt: 150,
      },
    ];
    assert.deepEqual(missionTelemetry(nodes, 0, 200, 2), {
      elapsedMs: 200,
      workerMs: 200,
      singleActiveMs: 100,
      utilization: 0.5,
      peakConcurrency: 2,
      noOverlap: false,
    });
  });

  it("flags multi-node missions that never overlap", () => {
    const nodes: MissionNodeState[] = [
      { id: "a", agent: "scout", prompt: "x", status: "succeeded", startedAt: 0, endedAt: 100 },
      { id: "b", agent: "oracle", prompt: "y", status: "succeeded", startedAt: 100, endedAt: 200 },
    ];
    assert.deepEqual(missionTelemetry(nodes, 0, 200, 2), {
      elapsedMs: 200,
      workerMs: 200,
      singleActiveMs: 200,
      utilization: 0.5,
      peakConcurrency: 1,
      noOverlap: true,
    });
  });

  it("does not warn when concurrency is one", () => {
    const nodes: MissionNodeState[] = [
      { id: "a", agent: "scout", prompt: "x", status: "succeeded", startedAt: 0, endedAt: 100 },
      { id: "b", agent: "oracle", prompt: "y", status: "succeeded", startedAt: 100, endedAt: 200 },
    ];
    assert.equal(missionTelemetry(nodes, 0, 200, 1).noOverlap, false);
  });
});
