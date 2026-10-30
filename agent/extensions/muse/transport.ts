import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { museBinary } from "./catalog.ts";
import { parseUsage, responseSchema, type MuseRequest } from "./protocol.ts";

export interface MuseResult {
  text: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export async function runMuse(request: MuseRequest, model: string, options: SimpleStreamOptions | undefined, signal: AbortSignal): Promise<MuseResult> {
  signal.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-"));
  try {
    const promptPath = join(dir, "prompt.md");
    const schemaPath = join(dir, "response.schema.json");
    await writeFile(promptPath, request.prompt, { mode: 0o600 });
    await writeFile(schemaPath, JSON.stringify(responseSchema), { mode: 0o600 });
    const args = [
      "exec", "--json", "--provider", "meta", "--model", model, "--preset", "empty",
      "--prompt-file", promptPath, "--output-schema", schemaPath,
      "--workspace", dir, "--worktree", "off", "--max-model-steps", "1", "--no-session-log",
      "--disable-shell", "--disable-write", "--disable-web-tools", "--disable-request-user-input",
      "--disable-reminders", "--no-foreign-personal-context", "--approval-judge", "off",
    ];
    const effort = options?.reasoning === "max" ? "ultra" : options?.reasoning ?? "none";
    args.push("--reasoning-effort", effort);
    for (const [index, image] of request.images.entries()) {
      const extension = extensions[image.mimeType];
      if (!extension) throw new Error(`Muse CLI does not support this image MIME type: ${image.mimeType}`);
      const path = join(dir, `image-${index + 1}.${extension}`);
      await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
      args.push("--image", path);
    }
    const env = { ...process.env };
    // The CLI's existing subscription login is the only authentication path we supply.
    for (const key of Object.keys(env)) if (key.toUpperCase() === "META_API_KEY") delete env[key];
    signal.throwIfAborted();
    return await new Promise<MuseResult>((resolve, reject) => {
      const child = spawn(museBinary(), args, { cwd: dir, env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      let pending = "";
      let stderr = "";
      let bytes = 0;
      let failure: Error | undefined;
      let completed = false;
      let usageSeen = false;
      const result: MuseResult = { text: "", model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const stop = () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
          killer.on("error", () => child.kill());
          killer.unref();
        } else {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
        }
      };
      const fail = (error: Error) => { failure ??= error; stop(); };
      const abort = () => fail(new Error("Muse request aborted."));
      const onLine = (line: string) => {
        if (!line.trim() || line.startsWith("muse:")) return;
        const event = object(JSON.parse(line));
        if (!event || typeof event.payload_type !== "string") throw new Error("Invalid Muse JSONL event.");
        const payload = object(event.payload) ?? {};
        if (event.payload_type === "run.terminal.completed") {
          if (completed || typeof payload.text !== "string") throw new Error("Invalid Muse terminal completion.");
          completed = true;
          result.text = payload.text;
        } else if (event.payload_type === "run.terminal.failed") {
          throw new Error(`Muse failed: ${String(payload.reason ?? payload.error ?? payload.text ?? "unknown error").slice(0, 2000)}`);
        } else if (event.payload_type === "run.model.configured" && typeof payload.model_id === "string") {
          result.model = payload.model_id;
        } else if (event.payload_type === "run.usage") {
          Object.assign(result, parseUsage(payload));
          usageSeen = true;
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16 * 1024 * 1024) { fail(new Error("Muse output exceeded 16 MiB.")); return; }
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        try { for (const line of lines) onLine(line); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        stderr = (stderr + chunk).slice(-8000);
        if (bytes > 16 * 1024 * 1024) fail(new Error("Muse output exceeded 16 MiB."));
      });
      child.once("error", error => { failure = error; });
      child.once("close", code => {
        signal.removeEventListener("abort", abort);
        try { if (pending.trim()) onLine(pending); }
        catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); }
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Muse exited with code ${code}: ${stderr.slice(-2000)}`));
        else if (!completed) reject(new Error(`Muse returned no terminal completion: ${stderr.slice(-2000)}`));
        else if (!usageSeen) reject(new Error("Muse returned no per-model usage record."));
        else resolve(result);
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
