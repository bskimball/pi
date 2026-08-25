import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  clearRuntimeSnapshots,
  CrashRuntimeMonitor,
  readRuntimeSnapshot,
  runtimeSnapshotPath,
} from "../crash-logger/internal/runtime-snapshot.ts";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withStateDir<T>(run: (stateDir: string) => T): T;
function withStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T>;
function withStateDir<T>(
  run: (stateDir: string) => T | Promise<T>,
): T | Promise<T> {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-runtime-snapshot-"));
  const previous = process.env.PI_TERMINAL_WATCHDOG_STATE_DIR;
  const cleanup = () => {
    clearRuntimeSnapshots();
    if (previous === undefined) delete process.env.PI_TERMINAL_WATCHDOG_STATE_DIR;
    else process.env.PI_TERMINAL_WATCHDOG_STATE_DIR = previous;
  };
  process.env.PI_TERMINAL_WATCHDOG_STATE_DIR = stateDir;
  try {
    const result = run(stateDir);
    if (result instanceof Promise) return result.finally(cleanup);
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

describe("crash runtime snapshot", () => {
  it("records bounded metadata and recent event names without event payloads", async () => {
    await withStateDir(async () => {
      const monitor = new CrashRuntimeMonitor(60_000);
      monitor.setSessionFile("C:/work/session.jsonl");
      monitor.note("tool-start name=bash call=call-1");
      await sleep(300);

      const snapshot = readRuntimeSnapshot(process.pid);
      assert.ok(snapshot);
      assert.equal(snapshot.sessionFile, "C:/work/session.jsonl");
      assert.equal(snapshot.pid, process.pid);
      assert.equal(typeof snapshot.memory?.rss, "number");
      assert.equal(typeof snapshot.systemMemory?.free, "number");
      assert.equal(snapshot.events.at(-1)?.event.includes("\n"), false);
      assert.match(snapshot.events.at(-1)?.event ?? "", /tool-start name=bash/);
      assert.doesNotMatch(JSON.stringify(snapshot), /secret|command=/i);

      monitor.stop(true);
      assert.equal(readRuntimeSnapshot(process.pid), undefined);
    });
  });

  it("falls back to the previous alternating snapshot when the newest is corrupt", () => {
    withStateDir(() => {
      const base = {
        version: 1,
        pid: process.pid,
        ppid: process.ppid,
        uptimeMs: 1,
        cwd: process.cwd(),
        entrypoint: process.execPath,
        schedulerLagMs: 0,
        events: [],
      };
      writeFileSync(
        runtimeSnapshotPath(process.pid, 0),
        JSON.stringify({
          ...base,
          sequence: 2,
          timestamp: "2026-08-25T14:37:00.000Z",
        }),
        "utf8",
      );
      writeFileSync(runtimeSnapshotPath(process.pid, 1), "{", "utf8");

      assert.equal(readRuntimeSnapshot(process.pid)?.sequence, 2);
    });
  });

  it("clears both alternating files", () => {
    withStateDir(() => {
      writeFileSync(runtimeSnapshotPath(process.pid, 0), "{}", "utf8");
      writeFileSync(runtimeSnapshotPath(process.pid, 1), "{}", "utf8");
      clearRuntimeSnapshots();
      assert.throws(() =>
        readFileSync(runtimeSnapshotPath(process.pid, 0), "utf8"),
      );
      assert.throws(() =>
        readFileSync(runtimeSnapshotPath(process.pid, 1), "utf8"),
      );
    });
  });
});
