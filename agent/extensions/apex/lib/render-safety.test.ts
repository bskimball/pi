import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { readLastPhase } from "../../lib/last-phase.ts";
import {
  attachHostPainter,
  guardUnbrokenRuns,
  installRenderSafety,
  normalizeRenderedLines,
  paintPinnedSurface,
  requestHostRender,
  SAFE_UNBROKEN_RUN_CHARS,
} from "./render-safety.ts";

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
  let priorWatchdogDir: string | undefined;
  let testAgentDir = "";
  before(() => {
    priorAgentDir = process.env.PI_CODING_AGENT_DIR;
    priorWatchdogDir = process.env.PI_TERMINAL_WATCHDOG_STATE_DIR;
    testAgentDir = join(process.cwd(), ".tmp", "render-safety-test");
    process.env.PI_CODING_AGENT_DIR = testAgentDir;
    process.env.PI_TERMINAL_WATCHDOG_STATE_DIR = testAgentDir;
    mkdirSync(testAgentDir, { recursive: true });
  });
  after(() => {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    if (priorWatchdogDir === undefined) {
      delete process.env.PI_TERMINAL_WATCHDOG_STATE_DIR;
    } else {
      process.env.PI_TERMINAL_WATCHDOG_STATE_DIR = priorWatchdogDir;
    }
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

  it("returns the same string when no unbroken run needs a break", () => {
    const text = "short words stay intact";
    assert.equal(guardUnbrokenRuns(text), text);
  });

  it("inserts break opportunities only after a long unbroken run", () => {
    const run = "a".repeat(SAFE_UNBROKEN_RUN_CHARS + 8);
    const guarded = guardUnbrokenRuns(run);
    assert.notEqual(guarded, run);
    assert.match(guarded, /\u200b/);
    assert.equal(guardUnbrokenRuns(guarded), guarded);
  });

  it("keeps Markdown text identity across remounts so the TUI cache can hit", () => {
    installRenderSafety();
    const source = "# heading\n\nordinary cached markdown";
    const markdown = new Markdown(source, 0, 0, markdownTheme);
    const first = markdown.render(80);
    const firstText = (markdown as unknown as { text: string }).text;
    const second = markdown.render(80);
    assert.equal((markdown as unknown as { text: string }).text, firstText);
    assert.equal(second, first);
    assert.equal(second[0], first[0]);
  });

  it("returns the same line array when every row is already a clean string", () => {
    const lines = ["alpha", "beta"];
    assert.equal(normalizeRenderedLines(lines), lines);
  });

  it("paints an attached host instead of requiring a tool-row remount", () => {
    let paints = 0;
    const detach = attachHostPainter({
      requestRender() {
        paints++;
      },
    });
    assert.equal(requestHostRender(), true);
    assert.equal(paints, 1);
    detach();
    assert.equal(requestHostRender(), false);
  });

  it("remounts a pinned surface only when no host painter is attached", () => {
    let remounts = 0;
    assert.equal(
      paintPinnedSurface(() => {
        remounts++;
      }),
      false,
    );
    assert.equal(remounts, 1);

    const detach = attachHostPainter({
      requestRender() {},
    });
    assert.equal(
      paintPinnedSurface(() => {
        remounts++;
      }),
      true,
    );
    assert.equal(remounts, 1);
    detach();
  });

  it("drops a throwing painter and remounts instead of reporting a paint", () => {
    const detach = attachHostPainter({
      requestRender() {
        throw new Error("disposed");
      },
    });
    let remounts = 0;
    assert.equal(
      paintPinnedSurface(() => {
        remounts++;
      }),
      false,
    );
    assert.equal(remounts, 1);
    detach();
  });

  it("rate-limits last-phase writes across cached remounts", () => {
    const phaseKey = Symbol.for("pi.apex.renderSafety.phaseState");
    (globalThis as typeof globalThis & Record<symbol, unknown>)[phaseKey] = {
      lastPhase: "",
      lastPhaseAt: 0,
    };
    installRenderSafety();
    const markdown = new Markdown(`# ${"x".repeat(5000)}`, 0, 0, markdownTheme);
    markdown.render(80);
    const first = readLastPhase(process.pid);
    assert.ok(first);
    markdown.render(80);
    requestHostRender();
    assert.equal(readLastPhase(process.pid), first);
  });

  it("shares the host painter registry across separately loaded modules", async () => {
    let paints = 0;
    const detach = attachHostPainter({
      requestRender() {
        paints++;
      },
    });
    const other = await import(
      new URL("./render-safety.ts?instance=other", import.meta.url).href,
    );
    let remounts = 0;
    assert.equal(
      other.paintPinnedSurface(() => {
        remounts++;
      }),
      true,
    );
    assert.equal(paints, 1);
    assert.equal(remounts, 0);
    detach();
  });
});
