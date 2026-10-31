import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { evaluateSettledReport } from "../report-schema.ts";
import {
  SETTLED_RESULT_CHARS,
  formatCompactWorkerStatus,
  formatSettledResult,
  formatDeliveredResult,
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

describe("formatDeliveredResult", () => {
  const handoff = {
    outcome: "Review completed; BLOCK",
    findings: "1. HIGH src/save.ts:12 — overwrite observed; user data lost. 2. LOW src/ui.ts:8 — missing label; unnamed control.",
    validation: "Save reproduction failed; typecheck passed.",
    blockers: "Fix overwrite before delivery.",
    uncertainties: "Concurrent saves were not exercised.",
  };
  const fence = (value: unknown) => `\n\`\`\`handoff\n${JSON.stringify(value)}\n\`\`\``;

  it("delivers all structured handoff fields instead of the long narrative, preserving the source", () => {
    const report = `Detailed evidence\n${"supporting detail\n".repeat(300)}${fence(handoff)}`;
    const result = formatDeliveredResult(report);
    assert.ok(result.reportFile);
    try {
      assert.equal(result.truncated, false);
      for (const value of Object.values(handoff)) assert.ok(result.text.includes(value));
      assert.doesNotMatch(result.text, /supporting detail\nsupporting detail/);
      assert.ok(result.text.length < report.length);
      assert.equal(readFileSync(result.reportFile, "utf8"), report);
      assert.equal(formatDeliveredResult(result.text).text, result.text);
    } finally {
      rmSync(dirname(result.reportFile), { recursive: true });
    }
  });

  it("retains the requested report-schema fence alongside the handoff", () => {
    const report = `Long evidence\n${"detail\n".repeat(200)}\n\`\`\`report\n{"verdict":"BLOCK"}\n\`\`\`${fence(handoff)}`;
    const result = formatDeliveredResult(report, { killReason: "stopped", recent: [] });
    assert.ok(result.reportFile);
    try {
      assert.match(result.text, /^INCOMPLETE: stopped\./);
      assert.match(result.text, /```report\n{"verdict":"BLOCK"}/);
      assert.ok(result.text.includes(handoff.findings));
    } finally {
      rmSync(dirname(result.reportFile), { recursive: true });
    }
  });

  it("preserves a valid schema report when an oversized handoff requires file retrieval", () => {
    const schema = JSON.stringify({ type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] });
    const report = `${"evidence\n".repeat(200)}\n\`\`\`report\n{"verdict":"BLOCK"}\n\`\`\`${fence({ ...handoff, findings: "x".repeat(6_001) })}`;
    const result = formatDeliveredResult(report);
    assert.ok(result.reportFile);
    try {
      assert.equal(result.truncated, true);
      assert.deepEqual(evaluateSettledReport(result.text, schema), evaluateSettledReport(report, schema));
      assert.equal(readFileSync(result.reportFile, "utf8"), report);
    } finally {
      rmSync(dirname(result.reportFile), { recursive: true });
    }
  });

  for (const value of [
    { ...handoff, findings: "x".repeat(6_001) },
    { ...handoff, findings: "finding\n".repeat(61) },
    { outcome: "missing required fields" },
  ]) {
    it("falls back to the complete file rather than clipping an unusable handoff", () => {
      const report = `${"evidence\n".repeat(200)}${fence(value)}`;
      const result = formatDeliveredResult(report);
      assert.ok(result.reportFile);
      try {
        assert.equal(result.truncated, true);
        assert.match(result.text, /No report excerpt was substituted/);
        assert.equal(readFileSync(result.reportFile, "utf8"), report);
      } finally {
        rmSync(dirname(result.reportFile), { recursive: true });
      }
    });
  }
  it("returns small reports unchanged without creating an artifact", () => {
    assert.deepEqual(formatDeliveredResult("PASS\nAll findings reviewed."), {
      text: "PASS\nAll findings reviewed.", truncated: false,
    });
  });

  for (const [name, report] of [
    ["character limit", `FIRST FINDING\n${"x".repeat(20_000)}\nFINAL FINDING`],
    ["line limit", `FIRST FINDING\n${"finding\n".repeat(200)}FINAL FINDING`],
  ]) {
    it(`preserves the complete report beyond the ${name}`, () => {
      const result = formatDeliveredResult(report);
      assert.ok(result.reportFile);
      try {
        assert.equal(result.truncated, true);
        assert.match(result.text, /No complete compact handoff fits/);
        assert.doesNotMatch(result.text, /FIRST FINDING|FINAL FINDING/);
        assert.ok(result.text.includes(JSON.stringify(result.reportFile)));
        assert.ok(result.text.length <= SETTLED_RESULT_CHARS);
        assert.ok(result.text.split(/\r?\n/).length <= 120);
        assert.equal(readFileSync(result.reportFile, "utf8"), report);
      } finally {
        rmSync(dirname(result.reportFile), { recursive: true });
      }
    });
  }

  it("preserves failure attribution in both the preview and full report", () => {
    const report = "FIRST\n" + "partial\n".repeat(200);
    const result = formatDeliveredResult(report, { killReason: "idle for 300s", recent: [] });
    assert.ok(result.reportFile);
    try {
      assert.match(result.text, /^INCOMPLETE: idle for 300s\./);
      assert.equal(readFileSync(result.reportFile, "utf8"), `INCOMPLETE: idle for 300s.\n${report}`);
      assert.ok(result.text.length <= SETTLED_RESULT_CHARS);
      assert.ok(result.text.split(/\r?\n/).length <= 120);
    } finally {
      rmSync(dirname(result.reportFile), { recursive: true });
    }
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
