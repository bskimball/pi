import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadUserConfig, resolveServer } from "../config.ts";

describe("config", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lsp-cfg-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("fails soft on missing config", () => {
    const cfg = loadUserConfig(join(dir, "missing-workspace"));
    assert.deepEqual(cfg, {});
  });

  it("fails soft on malformed config", () => {
    const cwd = join(dir, "bad");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "lsp.json"), "{not json");
    const cfg = loadUserConfig(cwd);
    assert.deepEqual(cfg, {});
  });

  it("loads overrides and disable", () => {
    const cwd = join(dir, "ok");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "lsp.json"),
      JSON.stringify({
        timeoutMs: 12_000,
        servers: {
          go: { enabled: false },
          python: { command: "pyright-langserver", args: ["--stdio"] },
        },
      }),
    );
    const cfg = loadUserConfig(cwd);
    assert.equal(cfg.timeoutMs, 12_000);
    assert.equal(cfg.configDir, join(cwd, ".pi"));
    assert.equal(resolveServer("go", cfg).enabled, false);
    assert.equal(resolveServer("python", cfg).candidates[0].command, "pyright-langserver");
    assert.equal(resolveServer("typescript", cfg).enabled, true);
  });

  it("supports Rust and Zig overrides", () => {
    const cwd = join(dir, "rust-zig");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "lsp.json"),
      JSON.stringify({ servers: { rust: { enabled: false }, zig: { command: "custom-zls" } } }),
    );
    const cfg = loadUserConfig(cwd);
    assert.equal(resolveServer("rust", cfg).enabled, false);
    assert.equal(resolveServer("zig", cfg).candidates[0].command, "custom-zls");
  });

  it("flows rootMarkers into ResolvedServer", () => {
    const cwd = join(dir, "markers");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "lsp.json"),
      JSON.stringify({
        servers: {
          go: { rootMarkers: [".my-go-root", "go.mod"] },
        },
      }),
    );
    const cfg = loadUserConfig(cwd);
    const go = resolveServer("go", cfg);
    assert.deepEqual(go.rootMarkers, [".my-go-root", "go.mod"]);
    // Defaults still present when not overridden
    const ts = resolveServer("typescript", cfg);
    assert.ok(ts.rootMarkers?.includes("package.json"));
  });
});
