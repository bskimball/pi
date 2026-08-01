import { readFileSync } from "node:fs";
import { createAbortError, isAbortError, raceAbort } from "./abort.ts";
import { firstResolvable } from "./command.ts";
import { LspClient } from "./client.ts";
import {
  loadUserConfig,
  resolveServer,
  timeouts,
  type LspUserConfig,
  type ResolvedServer,
} from "./config.ts";
import {
  boundText,
  clampLimit,
  formatDiagnostics,
  formatHover,
  formatLocations,
  formatSymbolSource,
  formatSymbols,
  normalizeDocumentSymbols,
  normalizeWorkspaceSymbols,
  type NormalizedSymbol,
  pickBestSymbol,
  sliceLines,
  symbolKindName,
} from "./format.ts";
import {
  detectRoot,
  languageForPath,
  pathToUri,
  resolvePath,
  type LanguageKey,
  uriToPath,
} from "./paths.ts";
import { externalToLsp, fromLspPosition } from "./positions.ts";

export type LspOperation =
  | "definition"
  | "references"
  | "hover"
  | "document_symbols"
  | "workspace_symbols"
  | "diagnostics"
  | "read_symbol";

export interface LspToolParams {
  operation: LspOperation;
  path?: string;
  line?: number;
  column?: number;
  query?: string;
  includeDeclaration?: boolean;
  limit?: number;
  /** Extra context lines for read_symbol (default 2, max 10). */
  context?: number;
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: boundText(text) }],
    details: {},
    isError,
  };
}

export class LspManager {
  private clients = new Map<string, LspClient>();
  /** Shared start promises (not tied to a single caller's AbortSignal). */
  private starting = new Map<string, Promise<LspClient>>();
  private userConfig: LspUserConfig = {};
  private cwd = process.cwd();
  /** True after dispose until rearm(); blocks new work and client inserts. */
  private shutDown = false;

  setCwd(cwd: string): void {
    this.cwd = cwd;
    this.userConfig = loadUserConfig(cwd);
  }

  /** Re-enable the manager after session_shutdown (session_start). */
  rearm(cwd?: string): void {
    this.shutDown = false;
    if (cwd) this.setCwd(cwd);
  }

  get isDisposed(): boolean {
    return this.shutDown;
  }

  async dispose(): Promise<void> {
    this.shutDown = true;
    const clients = [...this.clients.values()];
    const startups = [...this.starting.values()];
    this.clients.clear();
    // Keep `starting` map entries until their promises settle so in-flight startClient
    // can observe shutDown and refuse to insert. We still await them for cleanup.
    await Promise.all([
      ...clients.map((c) => c.shutdown().catch(() => undefined)),
      ...startups.map((p) => p.then((c) => c.shutdown().catch(() => undefined)).catch(() => undefined)),
    ]);
    this.starting.clear();
    // Leave shutDown=true until rearm() from session_start.
  }

  async execute(
    params: LspToolParams,
    signal?: AbortSignal,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }> {
    if (this.shutDown) return textResult("LSP manager is shut down.", true);
    if (signal?.aborted) return textResult("LSP operation aborted.", true);

    const op = params.operation;
    try {
      switch (op) {
        case "definition":
        case "references":
        case "hover":
          return await this.positionOp(op, params, signal);
        case "document_symbols":
          return await this.documentSymbols(params, signal);
        case "workspace_symbols":
          return await this.workspaceSymbols(params, signal);
        case "diagnostics":
          return await this.diagnostics(params, signal);
        case "read_symbol":
          return await this.readSymbol(params, signal);
        default:
          return textResult(`Unknown operation: ${String(op)}`, true);
      }
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        return textResult("LSP operation aborted.", true);
      }
      const message = error instanceof Error ? error.message : String(error);
      return textResult(message, true);
    }
  }

  private requirePath(params: LspToolParams): string {
    if (!params.path?.trim()) throw new Error("path is required for this operation.");
    return resolvePath(params.path, this.cwd);
  }

  private requirePosition(params: LspToolParams): { line: number; column: number } {
    if (params.line === undefined || params.column === undefined) {
      throw new Error("line and column are required (1-based).");
    }
    if (!Number.isFinite(params.line) || !Number.isFinite(params.column)) {
      throw new Error("line and column must be numbers (1-based).");
    }
    return { line: params.line, column: params.column };
  }

  private readFile(path: string): string {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read file ${path}: ${message}`);
    }
  }

  private async clientFor(
    filePath: string,
    languageKey: LanguageKey,
    signal?: AbortSignal,
  ): Promise<{ client: LspClient; root: string; server: ResolvedServer }> {
    const server = resolveServer(languageKey, this.userConfig);
    if (!server.enabled) {
      throw new Error(`Language server for ${languageKey} is disabled in lsp.json.`);
    }

    const root = detectRoot(filePath, this.cwd, languageKey, server.rootMarkers);
    const mapKey = `${languageKey}::${root}`;

    const existing = this.clients.get(mapKey);
    if (existing?.isAlive) return { client: existing, root, server };

    if (existing && !existing.isAlive) {
      this.clients.delete(mapKey);
      await existing.shutdown().catch(() => undefined);
    }

    if (this.shutDown) throw new Error("LSP manager is shut down.");

    let pending = this.starting.get(mapKey);
    if (!pending) {
      // Shared start is NOT tied to any single caller's AbortSignal.
      pending = this.startClient(mapKey, root, server);
      this.starting.set(mapKey, pending);
      // Consume both settle paths for map cleanup. Do not use void promise.finally():
      // a rejecting finally-derived promise becomes an unhandledRejection when voided.
      const clearStarting = () => {
        if (this.starting.get(mapKey) === pending) this.starting.delete(mapKey);
      };
      pending.then(clearStarting, clearStarting);
    }

    // Each caller races its own signal against the shared startup.
    const client = await raceAbort(pending, signal);
    if (this.shutDown) {
      throw createAbortError("LSP manager shut down during server start.");
    }
    if (!client.isAlive) {
      throw new Error(`Language server for ${server.key} failed to stay alive after start.`);
    }
    return { client, root, server };
  }

  private async startClient(
    mapKey: string,
    root: string,
    server: ResolvedServer,
  ): Promise<LspClient> {
    // Explicit relative commands resolve against the trusted config file directory.
    // Bare names search PATH only (never project root).
    const resolved = firstResolvable(server.candidates, this.userConfig.configDir);
    if (!resolved) {
      const tried = server.candidates.map((c) => c.command).join(", ");
      throw new Error(
        `No language server found for ${server.key} (tried: ${tried}). ${server.missingHint}`,
      );
    }

    if (this.shutDown) throw new Error("LSP manager shut down during server start.");

    const t = timeouts(this.userConfig);
    const client = new LspClient({
      command: resolved.resolved,
      args: resolved.args,
      cwd: root,
      rootPath: root,
      languageKey: server.key,
      initializationOptions: server.initializationOptions,
      settings: server.settings,
      requestTimeoutMs: t.requestMs,
      initializeTimeoutMs: t.initializeMs,
      diagnosticsWaitMs: t.diagnosticsWaitMs,
    });

    try {
      await client.start();
    } catch (error) {
      await client.shutdown().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to initialize ${server.key} language server (${resolved.command}). ${message}. ${server.missingHint}`,
      );
    }

    if (this.shutDown) {
      await client.shutdown().catch(() => undefined);
      throw new Error("LSP manager shut down during server start.");
    }

    this.clients.set(mapKey, client);
    return client;
  }

  private async openDoc(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<{
    client: LspClient;
    uri: string;
    text: string;
    languageId: string;
    languageKey: LanguageKey;
    path: string;
  }> {
    const path = resolvePath(filePath, this.cwd);
    const lang = languageForPath(path);
    if (!lang) {
      throw new Error(
        `Unsupported file type for ${path}. Supported: TypeScript/JavaScript, Python, Go, PHP.`,
      );
    }
    const { client, server } = await this.clientFor(path, lang.key, signal);
    if (!client.isAlive) {
      // Crash recovery: drop and retry once.
      const root = detectRoot(path, this.cwd, lang.key, server.rootMarkers);
      this.clients.delete(`${lang.key}::${root}`);
      const retry = await this.clientFor(path, lang.key, signal);
      return this.openWithClient(retry.client, path, lang.languageId, lang.key);
    }
    return this.openWithClient(client, path, lang.languageId, lang.key);
  }

  private async openWithClient(
    client: LspClient,
    path: string,
    languageId: string,
    languageKey: LanguageKey,
  ) {
    const text = this.readFile(path);
    const uri = pathToUri(path);
    await client.ensureDocument(path, uri, languageId, text);
    return { client, uri, text, languageId, languageKey, path };
  }

  private async positionOp(
    op: "definition" | "references" | "hover",
    params: LspToolParams,
    signal?: AbortSignal,
  ) {
    const path = this.requirePath(params);
    const { line, column } = this.requirePosition(params);
    const { client, uri, text } = await this.openDoc(path, signal);
    const position = externalToLsp(text, line, column, client.encoding);

    if (op === "definition") {
      const result = await client.request(
        "textDocument/definition",
        { textDocument: { uri }, position },
        undefined,
        signal,
      );
      return textResult(formatLocations(result, params.limit));
    }

    if (op === "references") {
      const result = await client.request(
        "textDocument/references",
        {
          textDocument: { uri },
          position,
          context: { includeDeclaration: params.includeDeclaration !== false },
        },
        undefined,
        signal,
      );
      return textResult(formatLocations(result, params.limit));
    }

    const result = await client.request(
      "textDocument/hover",
      { textDocument: { uri }, position },
      undefined,
      signal,
    );
    return textResult(formatHover(result));
  }

  private async documentSymbols(params: LspToolParams, signal?: AbortSignal) {
    const path = this.requirePath(params);
    const { client, uri } = await this.openDoc(path, signal);
    const result = await client.request(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
      undefined,
      signal,
    );
    const symbols = normalizeDocumentSymbols(result, uri);
    return textResult(formatSymbols(symbols, params.limit));
  }

  private async workspaceSymbols(params: LspToolParams, signal?: AbortSignal) {
    const query = params.query?.trim();
    if (!query) return textResult("query is required for workspace_symbols.", true);

    // Need a language to pick a server. Prefer path if given, else try enabled servers in cwd.
    let languageKey: LanguageKey | undefined;
    let anchorPath = params.path?.trim() ? resolvePath(params.path, this.cwd) : this.cwd;

    if (params.path?.trim()) {
      languageKey = languageForPath(anchorPath)?.key;
    }
    if (!languageKey) {
      const order: LanguageKey[] = ["typescript", "python", "go", "php"];
      let lastError: string | undefined;
      const all: string[] = [];
      for (const key of order) {
        if (signal?.aborted) throw new Error("LSP operation aborted.");
        const server = resolveServer(key, this.userConfig);
        if (!server.enabled) continue;
        if (!firstResolvable(server.candidates, this.userConfig.configDir)) continue;
        try {
          const { client } = await this.clientFor(anchorPath, key, signal);
          const result = await client.request("workspace/symbol", { query }, undefined, signal);
          const symbols = normalizeWorkspaceSymbols(result);
          all.push(`# ${key}\n${formatSymbols(symbols, params.limit)}`);
        } catch (error) {
          if (isAbortError(error)) throw error;
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (all.length) return textResult(all.join("\n\n"));
      return textResult(
        lastError
          ?? "No language server available for workspace_symbols. Provide path to a source file, or install a server.",
        true,
      );
    }

    const { client } = await this.clientFor(anchorPath, languageKey, signal);
    const result = await client.request("workspace/symbol", { query }, undefined, signal);
    const symbols = normalizeWorkspaceSymbols(result);
    return textResult(formatSymbols(symbols, params.limit));
  }

  private async diagnostics(params: LspToolParams, signal?: AbortSignal) {
    const path = this.requirePath(params);
    const { client, uri } = await this.openDoc(path, signal);
    client.clearDiagnosticHistory(uri);
    // Re-open sync: ensureDocument already sent didOpen/didChange; for diagnostics
    // re-touch by sending didChange with same text to coax push (some servers).
    const doc = client.getDocument(uri);
    if (doc) {
      await client.ensureDocument(path, uri, doc.languageId, doc.text + "");
      // ensureDocument skips if same text — bump version and send didChange for refresh.
      const text = doc.text;
      doc.version += 1;
      await client.notify("textDocument/didChange", {
        textDocument: { uri, version: doc.version },
        contentChanges: [{ text }],
      });
    }

    const t = timeouts(this.userConfig);
    const limit = params.limit;

    if (client.supportsPullDiagnostics()) {
      try {
        const result = await client.request<{ kind?: string; items?: unknown[] } | unknown[]>(
          "textDocument/diagnostic",
          { textDocument: { uri } },
          undefined,
          signal,
        );
        let items: unknown[] = [];
        if (Array.isArray(result)) items = result;
        else if (result && typeof result === "object" && Array.isArray((result as { items?: unknown[] }).items)) {
          items = (result as { items: unknown[] }).items;
        }
        // If pull returned empty, still wait briefly for a later push (intelephense pattern).
        if (!items.length) {
          const pushed = await client.waitForPushDiagnostics(
            uri,
            Math.min(1_200, t.diagnosticsWaitMs),
            signal,
          );
          if (pushed.status === "received" && pushed.diagnostics.length) {
            return textResult(formatDiagnostics(pushed.diagnostics, path, { status: "received", limit }));
          }
        }
        return textResult(formatDiagnostics(items, path, { status: "pull", limit }));
      } catch (error) {
        if (isAbortError(error)) throw error;
        // Fall through to push wait.
      }
    }

    const pushed = await client.waitForPushDiagnostics(uri, t.diagnosticsWaitMs, signal);
    return textResult(
      formatDiagnostics(pushed.diagnostics, path, {
        status: pushed.status,
        limit,
      }),
    );
  }

  private async readSymbol(params: LspToolParams, signal?: AbortSignal) {
    const query = params.query?.trim();
    if (!query) return textResult("query is required for read_symbol.", true);

    const margin = Math.min(10, Math.max(0, Math.floor(params.context ?? 2)));
    let symbols: NormalizedSymbol[] = [];
    let documentText: string | undefined;
    let documentUri: string | undefined;

    if (params.path?.trim()) {
      const path = resolvePath(params.path, this.cwd);
      const lang = languageForPath(path);
      if (lang) {
        const { client, uri, text } = await this.openDoc(path, signal);
        documentText = text;
        documentUri = uri;
        const result = await client.request(
          "textDocument/documentSymbol",
          { textDocument: { uri } },
          undefined,
          signal,
        );
        symbols = normalizeDocumentSymbols(result, uri);
      } else {
        // Treat path as workspace anchor only.
        const ws = await this.workspaceSymbolList(query, path, signal);
        symbols = ws;
      }
    } else {
      symbols = await this.workspaceSymbolList(query, this.cwd, signal);
    }

    // If document symbols empty, try workspace.
    if (!symbols.length && params.path?.trim()) {
      symbols = await this.workspaceSymbolList(query, resolvePath(params.path, this.cwd), signal);
    }

    if (!symbols.length) {
      return textResult(`No symbol matching ${JSON.stringify(query)} found.`, true);
    }

    const picked = pickBestSymbol(symbols, query);
    if (picked.ambiguous?.length) {
      return textResult(
        `Ambiguous symbol ${JSON.stringify(query)} — ${picked.ambiguous.length} matches:\n` +
          formatSymbols(picked.ambiguous, clampLimit(params.limit, 20, 50)),
        true,
      );
    }
    if (!picked.match) {
      return textResult(
        `No exact match for ${JSON.stringify(query)}. Candidates:\n` +
          formatSymbols(symbols, clampLimit(params.limit, 20, 50)),
        true,
      );
    }

    const match = picked.match;
    const filePath = match.path || (match.uri ? uriToPath(match.uri) : "");
    if (!filePath) return textResult("Matched symbol has no file location.", true);

    let text = documentText;
    let uri = documentUri ?? (match.uri ?? pathToUri(filePath));
    if (!text || uriToPath(uri) !== filePath) {
      text = this.readFile(filePath);
      // Open in appropriate server if possible for range completeness.
      const lang = languageForPath(filePath);
      if (lang) {
        try {
          const opened = await this.openDoc(filePath, signal);
          text = opened.text;
          uri = opened.uri;
          // If range missing, try document symbols on the target file.
          if (!match.range) {
            const result = await opened.client.request(
              "textDocument/documentSymbol",
              { textDocument: { uri } },
              undefined,
              signal,
            );
            const local = normalizeDocumentSymbols(result, uri);
            const better = pickBestSymbol(local, match.name);
            if (better.match?.range) {
              match.range = better.match.range;
              match.selectionRange = better.match.selectionRange;
            }
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          /* use disk text */
        }
      }
    }

    if (!match.range) {
      return textResult(
        `Found ${symbolKindName(match.kind)} ${match.name} at ${filePath} but no source range was provided by the server.`,
        true,
      );
    }

    const start = match.range.start.line;
    const end = match.range.end.line;
    const slice = sliceLines(text, start, end, margin);
    // Bound extreme ranges.
    if (slice.lines.length > 400) {
      slice.lines = slice.lines.slice(0, 400);
    }
    return textResult(
      formatSymbolSource(
        filePath,
        slice.lines,
        slice.startLine1,
        fromLspPosition(match.range.start).line,
        fromLspPosition(match.range.end).line,
        match.name,
        symbolKindName(match.kind),
      ),
    );
  }

  private async workspaceSymbolList(
    query: string,
    anchorPath: string,
    signal?: AbortSignal,
  ): Promise<NormalizedSymbol[]> {
    const lang = languageForPath(anchorPath)?.key;
    const keys: LanguageKey[] = lang
      ? [lang]
      : ["typescript", "python", "go", "php"];
    const collected: NormalizedSymbol[] = [];
    for (const key of keys) {
      if (signal?.aborted) throw new Error("LSP operation aborted.");
      const server = resolveServer(key, this.userConfig);
      if (!server.enabled) continue;
      if (!firstResolvable(server.candidates, this.userConfig.configDir)) continue;
      try {
        const { client } = await this.clientFor(anchorPath, key, signal);
        const result = await client.request("workspace/symbol", { query }, undefined, signal);
        collected.push(...normalizeWorkspaceSymbols(result));
      } catch (error) {
        if (isAbortError(error)) throw error;
        /* try next */
      }
    }
    return collected;
  }
}
