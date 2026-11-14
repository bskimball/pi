import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import type { AcpSpawner } from "pi-agy-acp/src/acp-process.ts";

// Windows taskkill pattern copied locally from task's process-tree-kill helper.
// Never share source imports with another extension.
export function createHost() {
  const children = new Set<ReturnType<typeof spawn>>();
  const stopping = new Set<Promise<unknown>>();
  let shutdownFailure: Error | undefined;
  const spawnAcp: AcpSpawner = (argv, cwd) => {
    const child = spawn(argv[0]!, [...argv.slice(1), "--dangerously-skip-permissions"], {
      cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    children.add(child);
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on("error", (error) => {
        if (child.pid === undefined) {
          // Spawn failure: no process was created. Later child errors are not exits.
          children.delete(child);
          resolve({ code: null, signal: error.message });
        } else {
          shutdownFailure ??= new Error(`Antigravity child lifecycle error: ${error.message}`);
        }
      });
      child.once("exit", (code, signal) => {
        if (process.platform === "win32" && !terminated) {
          shutdownFailure ??= new Error("Antigravity front exited before verified process-tree termination");
        }
        children.delete(child);
        resolve({ code, signal });
      });
    });
    let terminated = false;
    return {
      stdin: child.stdin!, stdout: child.stdout!, exited,
      stderrTail: () => stderr,
      terminate: () => {
        if (terminated || !children.has(child)) return;
        terminated = true;
        if (process.platform === "win32" && child.pid) {
          const result = spawnSync(
            join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
            ["/F", "/T", "/PID", String(child.pid)],
            { stdio: "ignore", windowsHide: true, timeout: 5000 },
          );
          if (result.status !== 0 || result.error) {
            shutdownFailure ??= new Error("Antigravity process-tree termination failed");
            child.kill(); // Best-effort root cleanup does not certify tree termination.
          }
        } else {
          child.kill("SIGTERM");
          const timer = setTimeout(() => {
            if (children.has(child)) child.kill("SIGKILL");
          }, 1500);
          timer.unref();
          void exited.then(() => clearTimeout(timer));
        }
        stopping.add(exited);
        void exited.finally(() => stopping.delete(exited));
      },
    };
  };
  return {
    spawnAcp,
    async waitForShutdown() {
      await Promise.race([
        Promise.all(stopping),
        new Promise((resolve) => { const timer = setTimeout(resolve, 6000); timer.unref(); }),
      ]);
      if (shutdownFailure) throw new Error(`${shutdownFailure.message}; isolated home retained`);
      if (children.size) throw new Error("Antigravity ACP process did not exit; isolated home retained");
    },
  };
}
