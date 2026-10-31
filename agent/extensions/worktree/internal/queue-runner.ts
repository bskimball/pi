import { createServer } from "node:net";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { queueDir, runQueue } from "./shipping-queue.ts";
import { queueExec, queueEndpoint, recoverQueueOperation } from "./queue-host.ts";
import { repositoryRoot } from "./shipping-state.ts";

const root = repositoryRoot(process.argv[2]);
const server = createServer(socket => socket.destroy());
async function acquire(): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const acquired = await new Promise<boolean>((resolve, reject) => {
      const failed = (error: NodeJS.ErrnoException) => {
        server.removeListener("listening", listening);
        if (error.code === "EADDRINUSE" || (process.platform === "win32" && error.code === "EACCES")) resolve(false);
        else reject(error);
      };
      const listening = () => { server.removeListener("error", failed); resolve(true); };
      server.once("error", failed);
      server.once("listening", listening);
      server.listen(queueEndpoint(root));
    });
    if (acquired) return true;
    await setTimeout(100);
  }
  return false;
}
try {
  if (await acquire()) {
    try {
      recoverQueueOperation(root);
      let before: string;
      do {
        before = readdirSync(join(queueDir(root), "requests")).sort().join("\n");
        await runQueue(root, queueExec(root));
      } while (before !== readdirSync(join(queueDir(root), "requests")).sort().join("\n"));
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
} catch (error) {
  console.error(new Date().toISOString(), error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
