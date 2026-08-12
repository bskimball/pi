import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  markTerminalWatchdogClean,
  markTerminalWatchdogLive,
  readTerminalWatchdogState,
  restoreInteractiveTerminal,
  restoreInteractiveTerminalSync,
  shouldRestoreInteractiveTerminal,
  TERMINAL_RESTORE_SEQUENCE,
  watchdogStatePath,
} from "../lib/terminal-restore.ts";

const watchdogScript = fileURLToPath(
  new URL("../lib/terminal-restore-watchdog.mjs", import.meta.url),
);

function waitForClose(child: ReturnType<typeof spawn>, timeoutMs = 3_000) {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("child did not exit before timeout"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function watchdogEnv(stateDir: string, logPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_TERMINAL_WATCHDOG_CHILD: "1",
    PI_TERMINAL_WATCHDOG_STATE_DIR: stateDir,
    PI_TERMINAL_WATCHDOG_LOG_PATH: logPath,
  };
}

describe("interactive terminal restore", () => {
  it("includes mouse, alt-screen, and raw-mode teardown sequences", () => {
    assert.match(TERMINAL_RESTORE_SEQUENCE, /\x1b\[\?1006l/);
    assert.match(TERMINAL_RESTORE_SEQUENCE, /\x1b\[\?1000l/);
    assert.match(TERMINAL_RESTORE_SEQUENCE, /\x1b\[\?2004l/);
    assert.match(TERMINAL_RESTORE_SEQUENCE, /\x1b\[\?1049l/);
    assert.match(TERMINAL_RESTORE_SEQUENCE, /\x1b\[\?25h/);
  });

  it("does not restore inside child Pi or the watchdog process", () => {
    const previousSubagent = process.env.PI_SUBAGENT;
    const previousWatchdog = process.env.PI_TERMINAL_WATCHDOG_CHILD;
    try {
      process.env.PI_SUBAGENT = "1";
      delete process.env.PI_TERMINAL_WATCHDOG_CHILD;
      assert.equal(shouldRestoreInteractiveTerminal(), false);

      delete process.env.PI_SUBAGENT;
      process.env.PI_TERMINAL_WATCHDOG_CHILD = "1";
      assert.equal(shouldRestoreInteractiveTerminal(), false);
    } finally {
      if (previousSubagent === undefined) delete process.env.PI_SUBAGENT;
      else process.env.PI_SUBAGENT = previousSubagent;
      if (previousWatchdog === undefined) {
        delete process.env.PI_TERMINAL_WATCHDOG_CHILD;
      } else {
        process.env.PI_TERMINAL_WATCHDOG_CHILD = previousWatchdog;
      }
    }
  });

  it("records live vs clean watchdog state in the configured directory", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-watchdog-state-"));
    const previous = process.env.PI_TERMINAL_WATCHDOG_STATE_DIR;
    const pid = 9_000_001;
    process.env.PI_TERMINAL_WATCHDOG_STATE_DIR = stateDir;
    try {
      markTerminalWatchdogLive(pid);
      assert.equal(readTerminalWatchdogState(pid), "live");
      markTerminalWatchdogClean(pid);
      assert.equal(readTerminalWatchdogState(pid), "clean");
    } finally {
      try {
        unlinkSync(watchdogStatePath(pid));
      } catch {
        // ignore
      }
      if (previous === undefined) delete process.env.PI_TERMINAL_WATCHDOG_STATE_DIR;
      else process.env.PI_TERMINAL_WATCHDOG_STATE_DIR = previous;
    }
  });

  it("stays silent while the parent is alive, then restores after unclean death", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-watchdog-state-"));
    const logPath = join(stateDir, "lifecycle.log");
    const previous = process.env.PI_TERMINAL_WATCHDOG_STATE_DIR;
    process.env.PI_TERMINAL_WATCHDOG_STATE_DIR = stateDir;
    const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    assert.ok(parent.pid);
    markTerminalWatchdogLive(parent.pid);
    const watchdog = spawn(process.execPath, [watchdogScript, String(parent.pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: watchdogEnv(stateDir, logPath),
    });
    try {
      await sleep(350);
      assert.equal(watchdog.stdout?.readableLength ?? 0, 0);
      parent.kill();
      const result = await waitForClose(watchdog);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /\x1b\[\?1006l/);
      assert.match(result.stdout, /\x1b\[\?1049l/);
      assert.match(readFileSync(logPath, "utf8"), /disappeared uncleanly/);
    } finally {
      parent.kill();
      if (previous === undefined) delete process.env.PI_TERMINAL_WATCHDOG_STATE_DIR;
      else process.env.PI_TERMINAL_WATCHDOG_STATE_DIR = previous;
    }
  });

  it("does not restore after a clean parent transition", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-watchdog-state-"));
    const logPath = join(stateDir, "lifecycle.log");
    const previous = process.env.PI_TERMINAL_WATCHDOG_STATE_DIR;
    process.env.PI_TERMINAL_WATCHDOG_STATE_DIR = stateDir;
    const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    assert.ok(parent.pid);
    markTerminalWatchdogLive(parent.pid);
    const watchdog = spawn(process.execPath, [watchdogScript, String(parent.pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: watchdogEnv(stateDir, logPath),
    });
    try {
      await sleep(350);
      markTerminalWatchdogClean(parent.pid);
      parent.kill();
      const result = await waitForClose(watchdog);
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "");
    } finally {
      parent.kill();
      if (previous === undefined) delete process.env.PI_TERMINAL_WATCHDOG_STATE_DIR;
      else process.env.PI_TERMINAL_WATCHDOG_STATE_DIR = previous;
    }
  });

  it("does not throw when restore is skipped", () => {
    const previous = process.env.PI_SUBAGENT;
    process.env.PI_SUBAGENT = "1";
    try {
      assert.doesNotThrow(() => restoreInteractiveTerminal());
      assert.equal(restoreInteractiveTerminalSync(), true);
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT;
      else process.env.PI_SUBAGENT = previous;
    }
  });
});
