// Minimal subprocess RPC transport for pi --mode rpc.
// Strict LF JSONL framing, request-id correlation, bounded stderr.

import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  attachJsonlReader,
  encodeJsonl,
  parseJsonlLine,
} from "./jsonl-framing.ts";

export const STDERR_CAP = 16_000;

export type RpcEventHandler = (event: Record<string, unknown>) => void;

export interface RpcSpawnOptions {
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onEvent?: RpcEventHandler;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (error: Error) => void;
  /** When true, extension_ui_request dialog methods are recorded for reply. */
  onUiRequest?: (request: Record<string, unknown>) => void;
}

export interface PendingRequest {
  id: string;
  command: string;
  resolve: (value: RpcResponse) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

export class RpcClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number | undefined;
  private nextReq = 1;
  private pending = new Map<string, PendingRequest>();
  private stderrText = "";
  private stderrTruncated = false;
  private closed = false;
  private stdoutReader: { dispose: () => void };
  private onEvent?: RpcEventHandler;
  private onUiRequest?: (request: Record<string, unknown>) => void;

  constructor(options: RpcSpawnOptions) {
    this.onEvent = options.onEvent;
    this.onUiRequest = options.onUiRequest;

    this.child = spawn(process.execPath, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.pid = this.child.pid;

    this.stdoutReader = attachJsonlReader(this.child.stdout, (line) => {
      this.handleStdoutLine(line);
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      const piece = chunk.toString("utf8");
      if (!piece) return;
      const next = this.stderrText + piece;
      if (next.length <= STDERR_CAP) {
        this.stderrText = next;
        return;
      }
      this.stderrTruncated = true;
      this.stderrText = next.slice(next.length - STDERR_CAP);
    });
    this.child.stderr.on("error", () => {});
    this.child.stdout.on("error", () => {});
    this.child.stdin.on("error", () => {});

    this.child.on("error", (error) => {
      this.failAllPending(error);
      options.onError?.(error);
    });

    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.stdoutReader.dispose();
      this.failAllPending(
        new Error(
          `RPC process exited (code=${code ?? "null"}${signal ? ` signal=${signal}` : ""})`,
        ),
      );
      options.onExit?.(code, signal);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get stderr(): { text: string; truncated: boolean } {
    return { text: this.stderrText, truncated: this.stderrTruncated };
  }

  /** Fire-and-forget write (no response correlation). */
  write(command: Record<string, unknown>): boolean {
    if (this.closed || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(encodeJsonl(command));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a command and wait for the correlated type:"response".
   * If id is omitted, one is allocated.
   */
  request(
    command: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<RpcResponse> {
    if (this.closed) {
      return Promise.reject(new Error("RPC process is closed"));
    }
    const id =
      typeof command.id === "string" && command.id
        ? command.id
        : `rpc_${this.nextReq++}`;
    const payload = { ...command, id };
    const cmdName = String(command.type ?? "unknown");

    return new Promise<RpcResponse>((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        command: cmdName,
        resolve,
        reject,
      };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`RPC request timed out after ${timeoutMs}ms (${cmdName})`));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(id, pending);
      if (!this.write(payload)) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(new Error(`Failed to write RPC command ${cmdName}`));
      }
    });
  }

  /** Close stdin so the child can exit cooperatively. */
  closeStdin(): void {
    try {
      if (this.child.stdin.writable) this.child.stdin.end();
    } catch {
      // ignore
    }
  }

  dispose(): void {
    this.stdoutReader.dispose();
    this.failAllPending(new Error("RPC client disposed"));
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleStdoutLine(line: string): void {
    const parsed = parseJsonlLine(line);
    if (!parsed || typeof parsed !== "object" || parsed === null) return;
    const obj = parsed as Record<string, unknown>;
    const type = obj.type;

    if (type === "response") {
      const id = typeof obj.id === "string" ? obj.id : undefined;
      if (id && this.pending.has(id)) {
        const pending = this.pending.get(id)!;
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(obj as unknown as RpcResponse);
        return;
      }
      // Unsolicited response — still surface as event for diagnostics.
      this.onEvent?.(obj);
      return;
    }

    if (type === "extension_ui_request") {
      this.onUiRequest?.(obj);
      // Also surface as an event so lifecycle can track waiting state.
      this.onEvent?.(obj);
      return;
    }

    this.onEvent?.(obj);
  }
}
