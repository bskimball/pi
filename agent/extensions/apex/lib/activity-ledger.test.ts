import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ActivityLedger } from "./activity-ledger.ts";

describe("ActivityLedger", () => {
  it("tracks identified overlapping tools by id", () => {
    const ledger = new ActivityLedger();
    ledger.start("read", "a.ts", "c1");
    ledger.start("bash", "ls", "c2");
    assert.equal(ledger.hasActiveTools(), true);
    assert.equal(ledger.runningCount, 2);
    ledger.end("c1", false);
    assert.equal(ledger.runningCount, 1);
    ledger.end("c2", true);
    assert.equal(ledger.hasActiveTools(), false);
    const snap = ledger.snapshot();
    assert.equal(snap[0].status, "completed");
    assert.equal(snap[1].status, "error");
    assert.ok(snap[0].duration != null);
  });

  it("matches anonymous ends LIFO and never steals identified starts", () => {
    const ledger = new ActivityLedger();
    ledger.start("read", "x", "id1");
    ledger.start("bash", "one");
    ledger.start("bash", "two");
    ledger.end(undefined, false);
    assert.equal(ledger.running().map((a) => a.summary).join(","), "x,one");
    ledger.end(undefined, false);
    assert.equal(ledger.running().map((a) => a.summary).join(","), "x");
    ledger.end("id1", false);
    assert.equal(ledger.hasActiveTools(), false);
  });

  it("closes a repeated id rather than leaking the prior start", () => {
    const ledger = new ActivityLedger();
    ledger.start("read", "first", "same");
    ledger.start("read", "second", "same");
    assert.equal(ledger.runningCount, 1);
    assert.equal(ledger.snapshot()[0].status, "completed");
    assert.equal(ledger.snapshot()[1].status, "running");
  });

  it("caps retained activities", () => {
    const ledger = new ActivityLedger({ maxActivities: 3 });
    for (let i = 0; i < 5; i++) {
      ledger.start("t", String(i), `c${i}`);
      ledger.end(`c${i}`, false);
    }
    assert.equal(ledger.activities.length, 3);
    assert.equal(ledger.activities[0].summary, "2");
  });

  it("closeAll clears running sets", () => {
    const ledger = new ActivityLedger();
    ledger.start("a", "1", "c1");
    ledger.start("b", "2");
    ledger.closeAll("error");
    assert.equal(ledger.hasActiveTools(), false);
    assert.ok(ledger.snapshot().every((a) => a.status === "error"));
  });
});
