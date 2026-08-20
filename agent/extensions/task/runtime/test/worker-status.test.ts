import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SETTLED_RESULT_CHARS,
  formatCompactWorkerStatus,
  formatSettledResult,
  formatWaitHeartbeat,
  type WorkerStatusSnapshot,
} from "../worker-status.ts";

function snapshot(
  overrides: Partial<WorkerStatusSnapshot> = {},
): WorkerStatusSnapshot {
  return {
    id: "task_1",
    lifecycle: "running",
    agent: "scout",
    model: "local-proxy/gemini-3.7-flash-high",
    generation: 1,
    turns: 14,
    maxTurns: 45,
    phase: "model",
    createdAt: 1_000,
    lastEventAt: 1_000,
    mission: "identify the root cause of recent Pi crashes",
    pendingSteer: 0,
    pendingFollowUp: 0,
    latestResult: "",
    latestAssistantText: "x".repeat(8_000),
    running: [{ tool: "read", summary: '{"path":"agent/pi-crash.log"}' }],
    recent: [
      {
        status: "completed",
        tool: "ffgrep",
        summary: '{"pattern":"expanded"}',
        duration: 12,
      },
    ],
    errors: [],
    waitingUi: [],
    ...overrides,
  };
}

describe("formatCompactWorkerStatus", () => {
  it("omits partial assistant text while the worker is live", () => {
    const text = formatCompactWorkerStatus(snapshot(), 1_500);
    assert.match(text, /lifecycle=running/);
    assert.match(text, /running: read:/);
    assert.match(text, /recent: completed ffgrep:/);
    assert.doesNotMatch(text, /--- result ---/);
    assert.doesNotMatch(text, /xxxx/);
    assert.ok(text.length < 800);
  });

  it("treats compacting as live and omits the result body", () => {
    const text = formatCompactWorkerStatus(
      snapshot({
        lifecycle: "compacting",
        latestAssistantText: "x".repeat(8_000),
        latestResult: "partial compaction dump",
      }),
      1_500,
    );
    assert.match(text, /lifecycle=compacting/);
    assert.doesNotMatch(text, /--- result/);
    assert.doesNotMatch(text, /partial compaction dump/);
    assert.doesNotMatch(text, /xxxx/);
  });

  it("includes a bounded result only after settlement", () => {
    const text = formatCompactWorkerStatus(
      snapshot({
        lifecycle: "settled",
        running: [],
        latestResult: `${"line\n".repeat(40)}${"z".repeat(2_000)}`,
      }),
      1_500,
    );
    assert.match(text, /--- result \(truncated tail/);
    assert.ok(text.length < 2_000);
    assert.ok(!text.includes("session_file"));
  });

  it("surfaces waiting UI requests without the checkpoint essay", () => {
    const text = formatCompactWorkerStatus(
      snapshot({
        waitingUi: [
          { id: "ui_1", method: "confirm", title: "Continue?" },
        ],
      }),
      1_500,
    );
    assert.match(text, /waiting_ui \(1\); reply via task_reply/);
    assert.match(text, /ui_1 method=confirm/);
    assert.doesNotMatch(text, /Fire-and-forget/);
  });
});

describe("formatWaitHeartbeat", () => {
  it("stays a few lines and never includes the result body", () => {
    const text = formatWaitHeartbeat(snapshot(), 1_500);
    assert.match(text, /task_1 lifecycle=running/);
    assert.match(text, /activity: read:/);
    assert.doesNotMatch(text, /--- result/);
    assert.equal(text.split("\n").length <= 4, true);
  });
});

describe("formatSettledResult", () => {
  it("keeps the tail of a long specialist report", () => {
    const bound = formatSettledResult(`${"keep\n".repeat(200)}conclusion`);
    assert.equal(bound.truncated, true);
    assert.ok(bound.text.endsWith("conclusion"));
    assert.ok(bound.text.length <= SETTLED_RESULT_CHARS);
  });
});
