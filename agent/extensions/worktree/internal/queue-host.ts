import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { queueDir } from "./shipping-queue.ts";
import { commonDir, digest, repositoryRoot, stateDir } from "./shipping-state.ts";
import type { Exec } from "./shipping.ts";

export function startQueue(cwd: string, recovery = false): void {
  const root = repositoryRoot(cwd);
  const dir = queueDir(root);
  if (recovery && !existsSync(join(dir, "requests"))) return;
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, "runner.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, ["--experimental-transform-types", fileURLToPath(new URL("./queue-runner.ts", import.meta.url)), root], {
      cwd: root, detached: true, windowsHide: true, stdio: ["ignore", fd, fd],
      env: { ...process.env, PI_SHIPPING_QUEUE_RUNNER: "1" },
    });
    child.on("error", error => { process.stderr.write(`Shipping queue launch failed: ${error.message}\n`); });
    child.unref();
  } finally { closeSync(fd); }
}

// A kernel-owned socket releases on process death. Never recover a PID-file lock
// by deleting it while another rescuer may be acquiring it.
export function queueEndpoint(root: string): { path: string } | { host: string; port: number; exclusive: true } {
  const identity = digest(commonDir(root));
  // Named pipes have no reserved-port ranges and the kernel drops the instance
  // when its owner exits. Never try another endpoint after an ownership refusal.
  if (process.platform === "win32") return { path: `\\\\.\\pipe\\pi-shipping-${identity}` };
  return { host: "127.0.0.1", port: 20000 + Number.parseInt(identity.slice(0, 8), 16) % 40000, exclusive: true };
}
function exited(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("host" in value) || value.host !== hostname() || !("pid" in value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return false;
  try { process.kill(value.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
export function recoverQueueOperation(root: string): void {
  const childFile = join(queueDir(root), "child.json");
  if (existsSync(childFile)) {
    const child: unknown = JSON.parse(readFileSync(childFile, "utf8"));
    if (!child || typeof child !== "object" || !("state" in child) || child.state !== "running" || !exited(child)) throw new Error("Previous queue command may still be alive or its launch is ambiguous; inspect it before recovering.");
    unlinkSync(childFile);
  }
  const lock = join(stateDir(root), "operation.lock");
  if (!existsSync(lock)) return;
  const value: unknown = JSON.parse(readFileSync(lock, "utf8"));
  if (value && typeof value === "object" && "queue" in value && value.queue === true && exited(value)) unlinkSync(lock);
  // Other owners' locks remain governed by shipping's existing refusal.
}

export function queueExec(root: string): Exec {
  return async (command, args, options) => new Promise((resolve, reject) => {
    const childFile = join(queueDir(root), "child.json");
    // Intent precedes spawn: a crash before the PID is saved must refuse recovery,
    // not mistake the absence of a PID for proof that no process was launched.
    writeFileSync(childFile, JSON.stringify({ state: "starting", host: hostname() }), { mode: 0o600 });
    const child = spawn(command, args, { cwd: options?.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal: options?.signal });
    let stdout = "", stderr = "";
    let cancelled = options?.signal?.aborted === true;
    const onAbort = () => { cancelled = true; };
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    if (child.pid) writeFileSync(childFile, JSON.stringify({ state: "running", pid: child.pid, host: hostname() }), { mode: 0o600 });
    child.stdout.on("data", data => { stdout = (stdout + String(data)).slice(-24000); });
    child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-24000); });
    const timer = setTimeout(() => { cancelled = true; child.kill(); }, options?.timeout ?? 900000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
      if (existsSync(childFile)) unlinkSync(childFile);
      resolve({ stdout, stderr, code: code ?? 1, killed: cancelled || signal !== null });
    });
  });
}
