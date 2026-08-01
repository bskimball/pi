import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createAbortError, raceAbort } from "../abort.ts";
import { LspManager } from "../manager.ts";

describe("manager lifecycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lsp-mgr-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("dispose leaves manager shut down until rearm", async () => {
    const manager = new LspManager();
    manager.setCwd(process.cwd());
    await manager.dispose();
    assert.equal(manager.isDisposed, true);
    const result = await manager.execute({
      operation: "workspace_symbols",
      query: "Nope",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /shut down/i);

    manager.rearm(process.cwd());
    assert.equal(manager.isDisposed, false);
  });

  it("shared startup: one caller's abort does not reject the shared promise for others", async () => {
    // Unit-level raceAbort contract used by clientFor for shared starts.
    let settle!: (value: string) => void;
    const shared = new Promise<string>((resolve) => {
      settle = resolve;
    });

    const a = new AbortController();
    const waitA = raceAbort(shared, a.signal);
    const waitB = raceAbort(shared, undefined);

    a.abort();
    await assert.rejects(waitA, (err: Error) => err.name === "AbortError");

    settle("ready");
    assert.equal(await waitB, "ready");
  });

  it("failed shared startup is handled without unhandledRejection", async () => {
    const workspace = join(dir, "no-server");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "main.go"), "package main\n");
    // Force go server to a missing bare command (PATH-only; will fail start).
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeFileSync(
      join(workspace, ".pi", "lsp.json"),
      JSON.stringify({
        servers: {
          go: { command: "pi-lsp-definitely-missing-server-xyz", args: [] },
        },
      }),
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const manager = new LspManager();
    manager.setCwd(workspace);
    try {
      const result = await manager.execute({
        operation: "document_symbols",
        path: join(workspace, "main.go"),
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /No language server found|Failed to initialize|not found/i);

      // Allow any stray microtasks from map cleanup to run.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(unhandled.length, 0, `unexpected unhandledRejection: ${String(unhandled[0])}`);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await manager.dispose();
    }
  });

  it("createAbortError is recognized as abort", () => {
    const err = createAbortError("LSP manager shut down during server start.");
    assert.equal(err.name, "AbortError");
  });
});
