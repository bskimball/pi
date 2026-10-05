import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SETTLED_RESULT_CHARS,
  formatCompactWorkerStatus,
  formatSettledResult,
  formatWaitHeartbeat,
  deadWorkerConnectionMessage,
  type WorkerStatusSnapshot,
} from "../worker-status.ts";

function snapshot(
  overrides: Partial<WorkerStatusSnapshot> = {},
): WorkerStatusSnapshot {
  return {
    id: "task_1",
    lifecycle: "running",
    agent: "scout",
    model: "antigravity/gemini-3.8-flash",
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
    running: [{ tool: "read", summary: '{"path":"agent/logs/pi-crash.log"}' }],
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
  it("marks killed empty reports with eight bounded unverified activities", () => {
    const state = snapshot({ lifecycle: "failed", latestAssistantText: "", killReason: "exceeded 60 turns",
      recent: Array.from({ length: 10 }, (_, index) => ({ tool: `tool_${index}`, summary: "argument".repeat(100) })) });
    const result = formatSettledResult("", state);
    assert.match(result.text, /^INCOMPLETE: exceeded 60 turns\. No final report\. Recent activity \(unverified\):/);
    assert.equal(result.text.split("\n").length, 9);
    assert.doesNotMatch(result.text, /tool_0:|tool_1:|\(empty\)/);
    assert.match(result.text, /tool_9:/);
    assert.ok(result.text.length <= SETTLED_RESULT_CHARS);
    assert.match(formatCompactWorkerStatus(state), /INCOMPLETE:/);
  });

  it("preserves the incomplete heading when a partial report is truncated", () => {
    const result = formatSettledResult("line\n".repeat(500), { killReason: "idle for 300s", recent: [] });
    assert.match(result.text, /^INCOMPLETE: idle for 300s\./);
    assert.ok(result.text.length <= SETTLED_RESULT_CHARS);
    assert.ok(result.text.split("\n").length <= 120);
    assert.equal(result.truncated, true);
  });

  it("leaves settled successful reports unchanged even with a rebind reason", () => {
    const text = formatCompactWorkerStatus(snapshot({ lifecycle: "settled", killReason: "rebound after parent exit", latestResult: "PASS" }));
    assert.match(text, /--- result \(full\) ---\nPASS$/);
    assert.doesNotMatch(text, /INCOMPLETE:/);
  });

  it("explains dead connections and preserves recovery instructions", () => {
    for (const worker of [
      { id: "task_1", exitCode: 3, killReason: undefined },
      { id: "task_1", exitCode: null, killReason: "exceeded 60 turns" },
    ]) {
      const text = deadWorkerConnectionMessage(worker);
      assert.ok(text.includes(`(${worker.killReason ?? "process exited code=3"})`));
      assert.match(text, /Its last report remains available via task_wait; start a new unit with task_start and pass that report as evidence\./);
    }
  });
  it("keeps the tail of a long specialist report", () => {
    const bound = formatSettledResult(`${"keep\n".repeat(200)}conclusion`);
    assert.equal(bound.truncated, true);
    assert.ok(bound.text.endsWith("conclusion"));
    assert.ok(bound.text.length <= SETTLED_RESULT_CHARS);
  });
});
