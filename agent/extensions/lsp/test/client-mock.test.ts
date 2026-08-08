import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { resolveSpawnCommand } from "../command.ts";

/**
 * Minimal mock language server over stdio JSON-RPC for lifecycle tests.
 */
function mockServerScript(): string {
  return `
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);

let opened = null;
const publishes = [];

connection.onRequest("initialize", (params) => {
  return {
    capabilities: {
      textDocumentSync: 1,
      definitionProvider: true,
      hoverProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      // no diagnosticProvider → push only
    },
    serverInfo: { name: "mock-ls" },
  };
});

connection.onNotification("initialized", () => {});
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));

connection.onNotification("textDocument/didOpen", (params) => {
  opened = params.textDocument;
  // Early empty publish then final diagnostics (intelephense-like)
  connection.sendNotification("textDocument/publishDiagnostics", {
    uri: params.textDocument.uri,
    version: params.textDocument.version,
    diagnostics: [],
  });
  setTimeout(() => {
    connection.sendNotification("textDocument/publishDiagnostics", {
      uri: params.textDocument.uri,
      version: params.textDocument.version,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          message: "mock error",
        },
      ],
    });
  }, 50);
});

connection.onNotification("textDocument/didChange", () => {});

connection.onRequest("textDocument/definition", (params) => {
  return {
    uri: params.textDocument.uri,
    range: {
      start: { line: 2, character: 4 },
      end: { line: 2, character: 10 },
    },
  };
});

connection.onRequest("textDocument/hover", () => {
  return { contents: { kind: "markdown", value: "mock hover" } };
});

connection.onRequest("workspace/configuration", (params) => {
  return (params.items || []).map(() => ({}));
});

connection.listen();
`;
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(child, "exit"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("mock server did not exit"));
        }, 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("mock JSON-RPC lifecycle", () => {
  it("initialize, definition, and empty-then-filled diagnostics", async () => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", mockServerScript()],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout!),
      new StreamMessageWriter(child.stdin!),
    );

    const diagnostics: Array<{ diagnostics: unknown[] }> = [];
    connection.onNotification("textDocument/publishDiagnostics", (params: { diagnostics?: unknown[] }) => {
      diagnostics.push({ diagnostics: params.diagnostics ?? [] });
    });
    connection.onRequest("workspace/configuration", (params: { items?: unknown[] }) => {
      return (params.items ?? []).map(() => ({}));
    });
    connection.listen();

    try {
      const init = await connection.sendRequest("initialize", {
        processId: process.pid,
        rootUri: "file:///tmp/mock",
        capabilities: {
          workspace: { configuration: true },
          textDocument: { publishDiagnostics: {} },
        },
      }) as { capabilities?: { definitionProvider?: boolean } };

      assert.equal(init.capabilities?.definitionProvider, true);
      await connection.sendNotification("initialized", {});

      await connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: "file:///tmp/mock/a.ts",
          languageId: "typescript",
          version: 1,
          text: "const x = 1;\n",
        },
      });

      const def = await connection.sendRequest("textDocument/definition", {
        textDocument: { uri: "file:///tmp/mock/a.ts" },
        position: { line: 0, character: 6 },
      }) as { range: { start: { line: number } } };
      assert.equal(def.range.start.line, 2);

      // Wait for both publishes
      const deadline = Date.now() + 2_000;
      while (diagnostics.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(diagnostics.length >= 2, `expected >=2 publishes, got ${diagnostics.length}`);
      assert.equal((diagnostics[0].diagnostics as unknown[]).length, 0);
      assert.equal((diagnostics[1].diagnostics as unknown[]).length, 1);

      const hover = await connection.sendRequest("textDocument/hover", {
        textDocument: { uri: "file:///tmp/mock/a.ts" },
        position: { line: 0, character: 0 },
      }) as { contents: { value: string } };
      assert.match(hover.contents.value, /mock hover/);

      await connection.sendRequest("shutdown", null);
      await connection.sendNotification("exit");
      await waitForChildExit(child);
    } finally {
      connection.dispose();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForChildExit(child).catch(() => {});
      }
    }
  });

  it("resolveSpawnCommand wraps Windows cmd scripts", () => {
    const wrapped = resolveSpawnCommand("C:\\tools\\server.cmd", ["--stdio"], "win32", "cmd.exe");
    assert.equal(wrapped.command, "cmd.exe");
    assert.deepEqual(wrapped.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(wrapped.windowsVerbatimArguments, true);
    // Single /c payload with quoted script + args (spaces / meta safe).
    assert.match(wrapped.args[3]!, /server\.cmd/);
    assert.match(wrapped.args[3]!, /--stdio/);

    const unix = resolveSpawnCommand("/usr/bin/gopls", [], "linux");
    assert.equal(unix.command, "/usr/bin/gopls");
    assert.deepEqual(unix.args, []);
  });
});
