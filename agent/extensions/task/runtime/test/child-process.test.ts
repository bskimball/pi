import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childToolArgs } from "../child-process.ts";

const env = {
  PRIME_WORK_BROWSER_URL: "http://localhost:1234",
  PRIME_WORK_BROWSER_TOKEN: "test-token",
  PRIME_WORK_BROWSER_EXTENSION_PATH: "/browser.ts",
  APEX_BROWSER_AGENT_EXTENSION_PATH: "/browser-agent.ts",
};
const browserTools = "browser_tabs,browser_read_page,browser_screenshot,browser_click,browser_type,browser_press_key,browser_scroll,browser_evaluate,browser_navigate,terminal_read";

describe("childToolArgs", () => {
  it("injects both extensions, extends an allowlist, and excludes nested browser tasks", () => {
    assert.deepEqual(childToolArgs({ apexBrowser: true, tools: "read, bash" }, "task", env), [
      "--extension", "/browser.ts", "--extension", "/browser-agent.ts",
      "--exclude-tools", "task,browser_task",
      "--tools", `read,bash,${browserTools},browser_run`,
    ]);
  });

  it("requires every browser connection variable", () => {
    for (const key of ["PRIME_WORK_BROWSER_URL", "PRIME_WORK_BROWSER_TOKEN", "PRIME_WORK_BROWSER_EXTENSION_PATH"]) {
      for (const value of [undefined, "", "  "]) {
        assert.deepEqual(childToolArgs({ apexBrowser: true, tools: "read" }, "task", { ...env, [key]: value }), [
          "--exclude-tools", "task", "--tools", "read",
        ]);
      }
    }
  });

  it("does not inject for an agent without opt-in", () => {
    assert.deepEqual(childToolArgs({ tools: "read" }, "task", env), [
      "--exclude-tools", "task", "--tools", "read",
    ]);
  });

  it("supports the browser extension alone and preserves unrestricted tools", () => {
    assert.deepEqual(childToolArgs({ apexBrowser: true }, "task", { ...env, APEX_BROWSER_AGENT_EXTENSION_PATH: "" }), [
      "--extension", "/browser.ts", "--exclude-tools", "task,browser_task",
    ]);
    const args = childToolArgs({ apexBrowser: true, tools: "read,browser_tabs" }, "task", env);
    assert.equal(args.at(-1)?.split(",").filter((tool) => tool === "browser_tabs").length, 1);
  });
});
