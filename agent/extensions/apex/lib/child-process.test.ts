import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isolatedChildEnv } from "./child-process.ts";

describe("isolated child Pi environment", () => {
  it("forces interactive presentation and nested watchdogs off", () => {
    const previousApex = process.env.PI_APEX_UI;
    const previousWatchdog = process.env.PI_TERMINAL_WATCHDOG;
    process.env.PI_APEX_UI = "1";
    process.env.PI_TERMINAL_WATCHDOG = "1";
    try {
      const env = isolatedChildEnv({
        PI_SUBAGENT: "1",
        PI_SUBAGENT_AGENT: "scout",
      });
      assert.equal(env.PI_APEX_UI, "0");
      assert.equal(env.PI_TERMINAL_WATCHDOG, "0");
      assert.equal(env.PI_SUBAGENT, "1");
      assert.equal(env.PI_SUBAGENT_AGENT, "scout");
      assert.ok(env.PATH || env.Path);
    } finally {
      if (previousApex === undefined) delete process.env.PI_APEX_UI;
      else process.env.PI_APEX_UI = previousApex;
      if (previousWatchdog === undefined) delete process.env.PI_TERMINAL_WATCHDOG;
      else process.env.PI_TERMINAL_WATCHDOG = previousWatchdog;
    }
  });
});
