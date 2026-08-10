import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { installRenderSafety, normalizeRenderedLines } from "./render-safety.ts";

const require = createRequire(import.meta.url);
const extensionTuiPackage = require.resolve("@earendil-works/pi-tui/package.json");
const nodeModulesRoot = join(dirname(extensionTuiPackage), "..", "..");
const codingAgentTuiPackage = join(
  nodeModulesRoot,
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
  "@earendil-works",
  "pi-tui",
  "package.json",
);

const markdownTheme = new Proxy(
  {},
  {
    get: () => (text: string) => text,
  },
) as any;

describe("Apex render safety", () => {
  let priorAgentDir: string | undefined;
  let testAgentDir = "";
  before(() => {
    priorAgentDir = process.env.PI_CODING_AGENT_DIR;
    testAgentDir = join(process.cwd(), ".tmp", "render-safety-test");
    process.env.PI_CODING_AGENT_DIR = testAgentDir;
    mkdirSync(testAgentDir, { recursive: true });
  });
  after(() => {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    rmSync(testAgentDir, { recursive: true, force: true });
  });

  it("targets pi-coding-agent's aliased pi-tui module", () => {
    const extensionTui = JSON.parse(readFileSync(extensionTuiPackage, "utf8"));
    const codingAgentTui = JSON.parse(readFileSync(codingAgentTuiPackage, "utf8"));
    assert.equal(extensionTui.version, codingAgentTui.version);

    const loaderPath = join(
      nodeModulesRoot,
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "core",
      "extensions",
      "loader.js",
    );
    const loader = readFileSync(loaderPath, "utf8");
    assert.match(loader, /import \* as _bundledPiTui from "@earendil-works\/pi-tui"/);
    assert.match(loader, /"@earendil-works\/pi-tui": piTuiEntry/);
  });

  it("preserves valid lines and splits malformed embedded newlines", () => {
    assert.deepEqual(normalizeRenderedLines(["alpha", "beta"]), [
      "alpha",
      "beta",
    ]);
    assert.deepEqual(normalizeRenderedLines(["alpha\r\nbeta", 42]), [
      "alpha",
      "beta",
      "42",
    ]);
  });

  it("isolates a failing component instead of aborting the container", () => {
    installRenderSafety();
    const container = new Container();
    container.addChild({
      render: () => {
        throw new TypeError("broken renderer");
      },
      invalidate: () => {},
    });
    container.addChild({
      render: () => ["still visible"],
      invalidate: () => {},
    });

    assert.deepEqual(container.render(80), [
      "[display unavailable]",
      "still visible",
    ]);
  });

  it("coerces malformed Text and Markdown payloads at render time", () => {
    installRenderSafety();
    const text = new Text("ok", 0, 0);
    (text as unknown as { text: unknown }).text = { value: "bad" };
    assert.equal(typeof text.render(80)[0], "string");

    const markdown = new Markdown("ok", 0, 0, markdownTheme);
    (markdown as unknown as { text: unknown }).text = { value: "bad" };
    assert.equal(typeof markdown.render(80)[0], "string");
  });

  it("contains the historical width-renderer failure shape", () => {
    installRenderSafety();
    const container = new Container();
    container.addChild({
      render: () => {
        throw new TypeError("segment.codePointAt is not a function");
      },
      invalidate: () => {},
    });

    assert.deepEqual(container.render(80), ["[display unavailable]"]);
  });
});
