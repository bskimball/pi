import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelThinkingLevel, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { museBinary } from "./catalog.ts";
import { parseMuseJson, parseUsage, responseSchema, type MuseRequest } from "./protocol.ts";

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

// The backend serves a `<base>-contributor` variant only for some models.
// Leaving contributor mode to the CLI default rewrites a plain model ID to
// its contributor twin; when that twin does not exist (e.g. muse-ember-1.0)
// the request 404s. Pin the mode to the ID Pi selected instead.
export function contributorModeForModel(model: string): "on" | "off" {
  return model.endsWith("-contributor") ? "on" : "off";
}

export function museReasoningEffort(level?: ModelThinkingLevel): string {
  if (!level || level === "off") return "minimal";
  return level === "max" ? "ultra" : level;
}

const execFileAsync = promisify(execFile);

export function museSkillOverrides(catalog: unknown): string[] {
  const skills = object(catalog)?.skills;
  if (!Array.isArray(skills)) throw new Error("Invalid Muse skill catalog.");
  const scopes: Record<string, Record<string, string>> = {};
  for (const row of skills) {
    const skill = object(row);
    if (!skill || typeof skill.path !== "string" || !["user", "bundled", "plugin"].includes(String(skill.scope))) {
      throw new Error("Unsupported Muse skill catalog entry.");
    }
    (scopes[String(skill.scope)] ??= {})[skill.path] = "off";
  }
  return Object.entries(scopes).flatMap(([scope, paths]) => ["--config", `skills.activation.${scope}=${JSON.stringify(paths)}`]);
}

export async function runMuse(request: MuseRequest, model: string, options: SimpleStreamOptions | undefined, signal: AbortSignal): Promise<MuseResult> {
  signal.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-"));
  try {
    const promptPath = join(dir, "prompt.md");
    const schemaPath = join(dir, "response.schema.json");
    await writeFile(promptPath, request.prompt, { mode: 0o600 });
    await writeFile(schemaPath, JSON.stringify(responseSchema), { mode: 0o600 });
    const env = { ...process.env };
    // Keep authentication in Muse; never copy credentials into the temporary workspace.
    for (const key of Object.keys(env)) if (key.toUpperCase() === "META_API_KEY") delete env[key];
    const configuredBinary = museBinary();
    const binary = /[\\/]/.test(configuredBinary) ? resolve(configuredBinary) : configuredBinary;
    const args = [
      "exec", "--json", "--provider", "meta", "--model", model, "--contributor-mode", contributorModeForModel(model), "--preset", "empty", "--yolo",
      "--prompt-file", promptPath, "--output-schema", schemaPath,
      "--workspace", dir, "--worktree", "off", "--no-session-log",
      "--disable-web-tools", "--disable-request-user-input",
      "--disable-reminders", "--no-foreign-personal-context", "--approval-judge", "off",
      "--config", `run.system_prompt=${JSON.stringify("You are the Pi assistant. Follow the Pi system instructions and ordered conversation supplied in the prompt. Return the required structured response. Pi executes requested tools; do not execute tools yourself.")}`,
      "--config", "run.context_usage_message_enabled=false",
      "--config", "run.context_slimming.meta_context_note_enabled=false",
      "--config", "run.context_slimming.session_identity_enabled=false",
    ];
    args.push("--reasoning-effort", museReasoningEffort(options?.reasoning));
    for (const [index, image] of request.images.entries()) {
      const extension = extensions[image.mimeType];
      if (!extension) throw new Error(`Muse CLI does not support this image MIME type: ${image.mimeType}`);
      const path = join(dir, `image-${index + 1}.${extension}`);
      await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
      args.push("--image", path);
    }
    const listing = execFileAsync(binary, ["skills", "list", "--json", "--workspace", dir], {
      cwd: dir, env, signal, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    const listingClosed = new Promise<void>(done => listing.child.once("close", () => done()));
    try {
      const { stdout } = await listing;
      args.push(...museSkillOverrides(parseMuseJson(stdout, "the CLI skill catalog")));
    } finally {
      // execFile rejects on abort before close; wait before removing its working directory.
      await listingClosed;
    }
    signal.throwIfAborted();
    return await new Promise<MuseResult>((resolve, reject) => {
      const child = spawn(binary, args, { cwd: dir, env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
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
        const event = object(parseMuseJson(line, "the CLI event stream"));
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
