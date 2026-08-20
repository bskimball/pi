import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { LspClient } from "../client.ts";
import type { LspDiagnosticEvent } from "../diagnostic-log.ts";

function mockServerPath(dir: string): string {
  const path = join(dir, "mock-lsp.mjs");
  const jsonRpcUrl = import.meta.resolve("vscode-jsonrpc/node");
  writeFileSync(
    path,
    `import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from ${JSON.stringify(jsonRpcUrl)};
const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
connection.onRequest("initialize", () => ({
  capabilities: { textDocumentSync: 1, diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } },
  serverInfo: { name: "instrumented-mock", version: "1.0.0" },
}));
connection.onNotification("initialized", () => {});
connection.onNotification("textDocument/didOpen", (params) => {
  setTimeout(() => connection.sendNotification("textDocument/publishDiagnostics", {
    uri: params.textDocument.uri,
    version: params.textDocument.version,
    diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "mock error" }],
  }), 20);
});
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
`,
    "utf8",
  );
  return path;
}

describe("LSP diagnostic instrumentation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lsp-instrumentation-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("records capabilities, pull support, publishes, and open/wait timing", async () => {
    mkdirSync(dir, { recursive: true });
    const events: LspDiagnosticEvent[] = [];
    const client = new LspClient({
      command: process.execPath,
      args: [mockServerPath(dir)],
      cwd: dir,
      rootPath: dir,
      languageKey: "typescript",
      requestTimeoutMs: 2_000,
      initializeTimeoutMs: 2_000,
      diagnosticsWaitMs: 1_000,
      diagnosticLogger: (event) => events.push(event),
    });

    try {
      await client.start();
      const uri = "file:///tmp/instrumented.ts";
      await client.ensureDocument(join(dir, "instrumented.ts"), uri, "typescript", "const x = 1;\n");
      const result = await client.waitForPushDiagnostics(uri, 1_000);

      assert.equal(result.status, "received");
      assert.equal(result.diagnostics.length, 1);

      const initialized = events.find((event) => event.event === "serverInitialized");
      assert.equal(initialized?.supportsPullDiagnostics, true);
      assert.deepEqual(initialized?.serverInfo, { name: "instrumented-mock", version: "1.0.0" });
      assert.ok(initialized?.capabilities && typeof initialized.capabilities === "object");
      assert.equal(typeof initialized?.initializeRequestElapsedMs, "number");

      const opened = events.find((event) => event.event === "documentOpened");
      assert.equal(opened?.uri, uri);
      assert.equal(typeof opened?.notificationElapsedMs, "number");

      const publish = events.find((event) => event.event === "publishDiagnostics");
      assert.equal(publish?.diagnosticCount, 1);
      assert.equal(typeof publish?.msSinceDocumentOpen, "number");

      const wait = events.find((event) => event.event === "diagnosticWaitCompleted");
      assert.equal(wait?.status, "received");
      assert.equal(wait?.publishes, 1);
      assert.equal(wait?.completionReason, "settled");
      assert.equal(typeof wait?.elapsedMs, "number");
    } finally {
      await client.shutdown();
    }
  });

  it("keeps instrumentation fail-soft and records no-publish timeouts", async () => {
    const events: LspDiagnosticEvent[] = [];
    const client = new LspClient({
      command: "unused",
      args: [],
      cwd: dir,
      rootPath: dir,
      languageKey: "typescript",
      requestTimeoutMs: 2_000,
      initializeTimeoutMs: 2_000,
      diagnosticsWaitMs: 30,
      diagnosticLogger: (event) => {
        events.push(event);
        if (event.event === "diagnosticWaitStarted") throw new Error("logger failure");
      },
    });

    const result = await client.waitForPushDiagnostics("file:///tmp/no-publish.ts", 30);
    assert.equal(result.status, "unknown");
    assert.equal(result.completionReason, "timeout");
    const completed = events.find((event) => event.event === "diagnosticWaitCompleted");
    assert.equal(completed?.completionReason, "timeout");
    assert.equal(completed?.publishes, 0);
  });
});
