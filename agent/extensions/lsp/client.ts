import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { basename } from "node:path";
import process from "node:process";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { createAbortError, raceAbort, throwIfAborted } from "./abort.ts";
import {
  isWindowsCmdScript,
  killWindowsProcessTree,
  resolveSpawnCommand,
} from "./command.ts";
import type { PositionEncoding } from "./positions.ts";
import { pickEncodingFromInitializeResult } from "./positions.ts";
import { pathToUri } from "./paths.ts";

export interface DocumentState {
  uri: string;
  path: string;
  languageId: string;
  version: number;
  text: string;
}

export interface ClientOptions {
  command: string;
  args: string[];
  cwd: string;
  rootPath: string;
  languageKey: string;
  initializationOptions?: Record<string, unknown>;
  settings?: unknown;
  requestTimeoutMs: number;
  initializeTimeoutMs: number;
  diagnosticsWaitMs: number;
}

export interface PublishDiagnostics {
  uri: string;
  version?: number;
  diagnostics: unknown[];
  at: number;
}

type DiagnosticWaitResult = {
  status: "received" | "unknown";
  diagnostics: unknown[];
  publishes: number;
};

type PendingDiagnosticWaiter = {
  uri: string;
  /** Invoked on each publish so the waiter can (re)start its settle timer. */
  onPublish: () => void;
  /** Force-complete the waiter (process death / shutdown). */
  finish: (result: DiagnosticWaitResult) => void;
  /** Reject waiter on abort without treating it as a diagnostics result. */
  reject?: (error: Error) => void;
  timer: NodeJS.Timeout;
  settleTimer?: NodeJS.Timeout;
  abortHandler?: () => void;
  signal?: AbortSignal;
};

const SETTLE_MS = 400;

export class LspClient {
  readonly options: ClientOptions;
  private child?: ChildProcessWithoutNullStreams;
  private connection?: MessageConnection;
  private started = false;
  private dead = false;
  private stderr = "";
  private positionEncoding: PositionEncoding = "utf-16";
  private capabilities: Record<string, unknown> = {};
  private documents = new Map<string, DocumentState>();
  private publishes = new Map<string, PublishDiagnostics[]>();
  private waiters = new Set<PendingDiagnosticWaiter>();
  private settings: unknown;
  /** True when the language server was launched via cmd.exe (Windows .cmd/.bat). */
  private cmdWrapped = false;

  constructor(options: ClientOptions) {
    this.options = options;
    this.settings = options.settings ?? {};
  }

  get encoding(): PositionEncoding {
    return this.positionEncoding;
  }

  get serverCapabilities(): Record<string, unknown> {
    return this.capabilities;
  }

  get isAlive(): boolean {
    return this.started && !this.dead && !!this.child && !this.child.killed;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.started) return;
    throwIfAborted(signal);
    const spawnCmd = resolveSpawnCommand(this.options.command, this.options.args);
    this.cmdWrapped = isWindowsCmdScript(this.options.command);
    const child = spawn(spawnCmd.command, spawnCmd.args, {
      cwd: this.options.cwd,
      env: process.env,
      stdio: "pipe",
      windowsHide: true,
      windowsVerbatimArguments: spawnCmd.windowsVerbatimArguments === true,
    });
    this.child = child;
    this.stderr = "";

    await raceAbort(
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          cleanup();
          reject(new Error(this.wrapError(`failed to start: ${error.message}`)));
        };
        const onSpawn = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          child.off("error", onError);
          child.off("spawn", onSpawn);
        };
        child.once("error", onError);
        child.once("spawn", onSpawn);
      }),
      signal,
    );

    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderr += String(chunk);
      if (this.stderr.length > 8_000) this.stderr = this.stderr.slice(-8_000);
    });

    child.on("exit", () => {
      this.dead = true;
      this.started = false;
      this.rejectWaiters(new Error(this.wrapError("language server process exited")));
      try {
        this.connection?.dispose();
      } catch {
        /* ignore */
      }
      this.connection = undefined;
      this.child = undefined;
    });

    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    this.connection = connection;

    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("client/unregisterCapability", () => null);
    connection.onRequest("workspace/configuration", (params: { items?: Array<{ section?: string }> }) => {
      const items = params?.items ?? [];
      return items.map(() => this.settings ?? {});
    });
    connection.onRequest("workspace/workspaceFolders", () => {
      const rootUri = pathToUri(this.options.rootPath);
      return [{ uri: rootUri, name: basename(this.options.rootPath) || "workspace" }];
    });
    connection.onNotification("window/logMessage", () => undefined);
    connection.onNotification("window/showMessage", () => undefined);
    connection.onNotification("telemetry/event", () => undefined);
    connection.onNotification("$/progress", () => undefined);
    connection.onNotification("$/logTrace", () => undefined);
    connection.onNotification("textDocument/publishDiagnostics", (params: {
      uri?: string;
      version?: number;
      diagnostics?: unknown[];
    }) => {
      if (!params?.uri) return;
      const pub: PublishDiagnostics = {
        uri: params.uri,
        version: params.version,
        diagnostics: Array.isArray(params.diagnostics) ? params.diagnostics : [],
        at: Date.now(),
      };
      const list = this.publishes.get(params.uri) ?? [];
      list.push(pub);
      // Bound history per URI.
      if (list.length > 20) list.splice(0, list.length - 20);
      this.publishes.set(params.uri, list);
      this.notifyWaiters(params.uri);
    });

    connection.onError(() => {
      /* fail soft; requests time out or process exit handles cleanup */
    });
    connection.listen();

    const rootUri = pathToUri(this.options.rootPath);
    try {
      throwIfAborted(signal);
      const result = await this.requestUnsafe(
        "initialize",
        {
          processId: process.pid,
          rootPath: this.options.rootPath,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: basename(this.options.rootPath) || "workspace" }],
          locale: "en",
          capabilities: {
            general: {
              positionEncodings: ["utf-16", "utf-8", "utf-32"],
            },
            textDocument: {
              synchronization: { dynamicRegistration: false, willSave: false, didSave: false, willSaveWaitUntil: false },
              hover: {
                dynamicRegistration: false,
                contentFormat: ["markdown", "plaintext"],
              },
              definition: { dynamicRegistration: false, linkSupport: true },
              references: { dynamicRegistration: false },
              documentSymbol: {
                dynamicRegistration: false,
                hierarchicalDocumentSymbolSupport: true,
              },
              publishDiagnostics: {
                relatedInformation: true,
                versionSupport: true,
              },
              diagnostic: {
                dynamicRegistration: false,
                relatedDocumentSupport: false,
              },
            },
            workspace: {
              workspaceFolders: true,
              configuration: true,
              didChangeConfiguration: { dynamicRegistration: false },
            },
          },
          initializationOptions: this.options.initializationOptions ?? {},
          workDoneToken: undefined,
        },
        this.options.initializeTimeoutMs,
        signal,
      );

      this.capabilities = ((result as { capabilities?: Record<string, unknown> })?.capabilities) ?? {};
      this.positionEncoding = pickEncodingFromInitializeResult(result);
      connection.sendNotification("initialized", {});
      this.started = true;
      this.dead = false;
    } catch (error) {
      await this.forceKill();
      throw error instanceof Error ? error : new Error(this.wrapError(String(error)));
    }
  }

  async ensureDocument(path: string, uri: string, languageId: string, text: string): Promise<DocumentState> {
    const existing = this.documents.get(uri);
    if (!existing) {
      const doc: DocumentState = { uri, path, languageId, version: 1, text };
      this.documents.set(uri, doc);
      await this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
      return doc;
    }
    if (existing.text === text) return existing;
    existing.version += 1;
    existing.text = text;
    await this.notify("textDocument/didChange", {
      textDocument: { uri, version: existing.version },
      contentChanges: [{ text }],
    });
    return existing;
  }

  getDocument(uri: string): DocumentState | undefined {
    return this.documents.get(uri);
  }

  async request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.isAlive || !this.connection) {
      throw new Error(this.wrapError("language server is not running"));
    }
    return this.requestUnsafe(
      method,
      params,
      timeoutMs ?? this.options.requestTimeoutMs,
      signal,
    ) as Promise<T>;
  }

  private async requestUnsafe(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const connection = this.connection;
    if (!connection) throw new Error(this.wrapError("no connection"));
    throwIfAborted(signal);

    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await raceAbort(
        Promise.race([
          connection.sendRequest(method, params),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(this.wrapError(`${method} timed out after ${timeoutMs}ms`)));
            }, timeoutMs);
          }),
        ]),
        signal,
      );
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("timed out") || message.includes("language server")) {
        throw error instanceof Error ? error : new Error(message);
      }
      throw new Error(this.wrapError(`${method} failed: ${message}`));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (!this.connection || !this.isAlive) return;
    try {
      await this.connection.sendNotification(method, params);
    } catch {
      /* ignore notify failures */
    }
  }

  supportsPullDiagnostics(): boolean {
    return !!this.capabilities.diagnosticProvider;
  }

  /**
   * Wait for push diagnostics to settle. Returns:
   * - diagnostics array when at least one publish arrived
   * - null when no publish arrived within waitMs (status unknown)
   *
   * Accounts for early empty publish then non-empty (intelephense): keeps waiting
   * for settle period after each publish.
   */
  waitForPushDiagnostics(
    uri: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<DiagnosticWaitResult> {
    throwIfAborted(signal);
    const startAt = Date.now();
    const existing = this.publishes.get(uri) ?? [];
    if (existing.length) return this.settleFrom(uri, existing, waitMs, startAt, signal);

    return new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        if (waiter.settleTimer) clearTimeout(waiter.settleTimer);
        if (waiter.signal && waiter.abortHandler) {
          waiter.signal.removeEventListener("abort", waiter.abortHandler);
        }
      };
      const complete = (result: DiagnosticWaitResult) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(result);
      };
      const fail = (error: Error) => {
        if (done) return;
        done = true;
        cleanup();
        reject(error);
      };

      const snapshot = (): DiagnosticWaitResult => {
        const pubs = this.publishes.get(uri) ?? [];
        if (!pubs.length) return { status: "unknown", diagnostics: [], publishes: 0 };
        const last = pubs[pubs.length - 1];
        return { status: "received", diagnostics: last.diagnostics, publishes: pubs.length };
      };

      const waiter: PendingDiagnosticWaiter = {
        uri,
        onPublish: () => {
          if (done) return;
          if (waiter.settleTimer) clearTimeout(waiter.settleTimer);
          waiter.settleTimer = setTimeout(() => complete(snapshot()), SETTLE_MS);
        },
        finish: complete,
        reject: fail,
        timer: setTimeout(() => complete(snapshot()), waitMs),
        signal,
      };

      if (signal) {
        waiter.abortHandler = () => fail(createAbortError());
        signal.addEventListener("abort", waiter.abortHandler, { once: true });
      }

      this.waiters.add(waiter);
    });
  }

  private settleFrom(
    uri: string,
    existing: PublishDiagnostics[],
    waitMs: number,
    startAt: number,
    signal?: AbortSignal,
  ): Promise<DiagnosticWaitResult> {
    return new Promise((resolve, reject) => {
      const elapsed = Date.now() - startAt;
      const remaining = Math.max(0, waitMs - elapsed);
      let done = false;

      const snapshot = (): DiagnosticWaitResult => {
        const pubs = this.publishes.get(uri) ?? existing;
        const last = pubs[pubs.length - 1];
        return {
          status: pubs.length ? "received" : "unknown",
          diagnostics: last?.diagnostics ?? [],
          publishes: pubs.length,
        };
      };

      const cleanup = () => {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        if (waiter.settleTimer) clearTimeout(waiter.settleTimer);
        if (waiter.signal && waiter.abortHandler) {
          waiter.signal.removeEventListener("abort", waiter.abortHandler);
        }
      };

      const complete = (result: DiagnosticWaitResult) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(result);
      };
      const fail = (error: Error) => {
        if (done) return;
        done = true;
        cleanup();
        reject(error);
      };

      const waiter: PendingDiagnosticWaiter = {
        uri,
        onPublish: () => {
          if (done) return;
          if (waiter.settleTimer) clearTimeout(waiter.settleTimer);
          waiter.settleTimer = setTimeout(() => complete(snapshot()), SETTLE_MS);
        },
        finish: complete,
        reject: fail,
        timer: setTimeout(() => complete(snapshot()), Math.max(SETTLE_MS, remaining)),
        signal,
      };
      if (signal) {
        waiter.abortHandler = () => fail(createAbortError());
        signal.addEventListener("abort", waiter.abortHandler, { once: true });
      }
      // Start settle immediately from last known publish.
      waiter.onPublish();
      this.waiters.add(waiter);
    });
  }

  private notifyWaiters(uri: string): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.uri !== uri) continue;
      waiter.onPublish();
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.signal && waiter.abortHandler) {
        waiter.signal.removeEventListener("abort", waiter.abortHandler);
      }
      if (error.name === "AbortError" && waiter.reject) {
        waiter.reject(error);
        continue;
      }
      const pubs = this.publishes.get(waiter.uri) ?? [];
      const last = pubs[pubs.length - 1];
      waiter.finish({
        status: pubs.length ? "received" : "unknown",
        diagnostics: last?.diagnostics ?? [],
        publishes: pubs.length,
      });
    }
    this.waiters.clear();
  }

  clearDiagnosticHistory(uri?: string): void {
    if (uri) this.publishes.delete(uri);
    else this.publishes.clear();
  }

  async shutdown(): Promise<void> {
    if (this.connection && this.isAlive) {
      try {
        await this.requestUnsafe("shutdown", null, 3_000);
      } catch {
        /* ignore */
      }
      try {
        await this.connection.sendNotification("exit", undefined);
      } catch {
        /* ignore */
      }
    }
    await this.forceKill();
  }

  private async forceKill(): Promise<void> {
    this.dead = true;
    this.started = false;
    this.rejectWaiters(new Error("shutdown"));
    try {
      this.connection?.dispose();
    } catch {
      /* ignore */
    }
    this.connection = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) return;

    const pid = child.pid;
    // cmd/bat wrappers: kill the whole tree so the real language server dies with cmd.exe.
    if (this.cmdWrapped && process.platform === "win32" && typeof pid === "number" && pid > 0) {
      await killWindowsProcessTree(pid);
      try {
        if (!child.killed) child.kill();
      } catch {
        /* ignore */
      }
      return;
    }

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      try {
        child.kill();
      } catch {
        resolve();
        return;
      }
      setTimeout(() => {
        try {
          if (!child.killed) child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 1_500).unref?.();
    });
  }

  private wrapError(message: string): string {
    const tail = this.stderr.trim() ? ` stderr: ${this.stderr.trim().slice(-500)}` : "";
    return `LSP (${this.options.languageKey}): ${message}.${tail}`;
  }
}
