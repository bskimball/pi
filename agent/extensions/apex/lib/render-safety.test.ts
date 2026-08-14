import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { installRenderSafety, normalizeRenderedLines } from "./render-safety.ts";

const require = createRequire(import.meta.url);
const extensionTuiPackage = require.resolve("@earendil-works/pi-tui/package.json");
const nodeModulesRoot = join(dirname(extensionTuiPackage), "..", "..");
const nestedCodingAgentTuiPackage = join(
  nodeModulesRoot,
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
  "@earendil-works",
  "pi-tui",
  "package.json",
);
const codingAgentTuiPackage = existsSync(nestedCodingAgentTuiPackage)
  ? nestedCodingAgentTuiPackage
  : extensionTuiPackage;

const nativeContainerRender = Container.prototype.render;

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

  it("leaves native Container rendering untouched", () => {
    installRenderSafety();
    assert.equal(Container.prototype.render, nativeContainerRender);
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

  it("contains historical marked substring failures inside Markdown", () => {
    installRenderSafety();
    const markedFailure = new Markdown("ok", 0, 0, markdownTheme);
    (markedFailure as unknown as { options: unknown }).options = {
      transform: () => ({
        trim: () => "ok",
        replace: () => ({
          substring: null,
          codePointAt: () => 111,
          [Symbol.iterator]: function* () {
            yield "o";
            yield "k";
          },
        }),
      }),
    };

    assert.deepEqual(markedFailure.render(80), ["[markdown unavailable]"]);
  });

  it("contains historical width codePointAt failures inside Markdown", () => {
    installRenderSafety();
    const widthFailure = new Markdown("ok", 0, 0, markdownTheme);
    (widthFailure as unknown as { options: unknown }).options = {
      transform: () => ({
        trim: () => "ok",
        replace: () => ({
          substring: () => "ok",
          codePointAt: null,
          [Symbol.iterator]: function* () {
            yield Object.create(null);
          },
        }),
      }),
    };

    assert.deepEqual(widthFailure.render(80), ["[markdown unavailable]"]);
  });
});
