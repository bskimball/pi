import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const moduleUrl = new URL(
  "../crash-logger/internal/native-boundary.ts",
  import.meta.url,
).href;

describe("native-boundary telemetry", () => {
  it("observes a large terminal write without changing or chunking it", () => {
    const script = `
      const writes = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = function(chunk, encoding, callback) {
        writes.push(String(chunk));
        const cb = typeof encoding === "function" ? encoding : callback;
        if (cb) queueMicrotask(cb);
        return true;
      };
      const { ProcessTerminal } = await import("@earendil-works/pi-tui");
      const { installNativeBoundaryTelemetry } = await import(${JSON.stringify(moduleUrl)});
      const events = [];
      installNativeBoundaryTelemetry((event) => events.push(event));
      const payload = "x".repeat(2048);
      new ProcessTerminal().write(payload);
      await new Promise((resolve) => setImmediate(resolve));
      originalWrite(JSON.stringify({ writes, events }));
    `;
    const result = spawnSync(process.execPath, [
      "--experimental-transform-types",
      "--input-type=module",
      "--eval",
      script,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PI_TERMINAL_WATCHDOG_STATE_DIR: process.env.TEMP,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      writes: string[];
      events: string[];
    };
    assert.equal(output.writes[0], "x".repeat(2048));
    assert.equal(output.writes[1], "");
    assert.equal(output.writes.length, 2);
    assert.ok(output.events.some((event) => event.startsWith("terminal-write:enter")));
    assert.ok(output.events.some((event) => event.startsWith("terminal-write:return")));
    assert.ok(output.events.some((event) => event.startsWith("terminal-write:flushed")));
  });
});
