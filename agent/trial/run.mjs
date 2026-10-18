import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scoreSession } from "./score-session.mjs";

// Keep the original CLI arm identifier for existing records and --accept.
// "regular" means regular-without-delegation, never unconstrained regular mode.
const ARMS = ["regular", "orchestrate"];
const MODE = { regular: "apex", orchestrate: "apex-orchestrate" };
const RESULTS = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(process.env.HOME ?? "", ".pi", "agent"), "trial", "results.jsonl");
const MODE_SETTINGS = join(dirname(RESULTS), "..", "mode-settings.json");
const BLOCKERS = [
  "Establish and validate process-local mode isolation; shared mode-settings backup/restore can overwrite concurrent changes.",
  "Verify end-to-end that regular-without-delegation cannot delegate and orchestrate can, with the same requested lead model/thinking.",
  "Repair and validate spawn error/exit propagation, RPC pending-request rejection, bounded shutdown, and descendant termination.",
  "Capture explicit request-to-final task boundaries and durable task/generation child links; independently reconcile copied fork history and inline usage.",
  "Validate worktree/link isolation, failure retention, and opt-in cleanup without losing unreviewed changes.",
  "Complete an authorized end-to-end runner validation before enabling execution; separate process completion, verification, and human acceptance.",
];
function fail(message) { console.error(message); process.exitCode = 1; }
function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function loadTask(path) {
  const task = readJson(path);
  if (typeof task.id !== "string" || !/^[\w.-]+$/.test(task.id)) throw new Error("task.id must be a short slug");
  if (typeof task.repo !== "string" || typeof task.prompt !== "string" || !task.prompt.trim()) throw new Error("task.repo and task.prompt are required");
  if (!Array.isArray(task.checks) || task.checks.length === 0) throw new Error("task.checks must contain at least one command");
  for (const check of task.checks) {
    if (typeof check.name !== "string" || typeof check.command !== "string" || !Array.isArray(check.args) || check.args.some(arg => typeof arg !== "string")) throw new Error(`check ${check.name ?? "?"} must have a command and string args`);
  }
  if (task.link !== undefined && (!Array.isArray(task.link) || task.link.some(item => typeof item !== "string" || item.startsWith("/") || item.split(/[\\/]/).includes("..")))) throw new Error("task.link must be relative paths inside the repo");
  return { base: "HEAD", link: [], ...task };
}
export function preflight(path) {
  if (path) loadTask(path);
  return { safeToRun: false, arms: ["regular-without-delegation (CLI: regular)", "orchestrate"], taskSchemaValid: path ? true : null, blockers: BLOCKERS };
}
function requireSafeExecution() {
  // Intentionally no flag/environment bypass. Retained execution code below is
  // unreachable repair material, NOT a delivered safe execution implementation.
  throw new Error(`Trial execution blocked:\n- ${BLOCKERS.join("\n- ")}`);
}

// Original execution implementation retained for targeted follow-up repairs.
function git(repo, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("close", code => code === 0 ? resolvePromise(out.trim()) : reject(new Error(err.trim() || `git ${args[0]} failed`)));
  });
}
function runArgv(command, args, cwd, timeoutMs) {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on("close", code => { clearTimeout(timer); resolvePromise({ name: undefined, exitCode: code ?? 1, stderr }); });
  });
}
class Rpc {
  constructor(child) {
    this.child = child; this.buffer = ""; this.seq = 0;
    this.pending = new Map(); this.listeners = new Set();
    child.stdout.on("data", chunk => this.push(String(chunk)));
  }
  push(text) {
    this.buffer += text;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const pending = message.id ? this.pending.get(message.id) : undefined;
      if (message.type === "response" && pending) { this.pending.delete(message.id); pending(message); }
      for (const listener of this.listeners) listener(message);
    }
  }
  request(command, timeoutMs) {
    const id = `trial-${++this.seq}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${command.type} timed out`)); }, timeoutMs);
      this.pending.set(id, message => { clearTimeout(timer); resolvePromise(message); });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }
}
async function runArm(task, arm, options) {
  requireSafeExecution(); // Also guard direct future callers before any side effect.
  const sha = await git(task.repo, ["rev-parse", options.base ?? task.base]);
  const root = join(tmpdir(), `apex-trial-${task.id}-${arm}-${process.pid}`);
  const worktree = join(root, "work");
  mkdirSync(root, { recursive: true });
  await git(task.repo, ["worktree", "add", "--detach", worktree, sha]);
  for (const link of task.link) {
    const source = join(task.repo, link), target = join(worktree, link);
    try {
      if (lstatSync(source).isDirectory() || lstatSync(source).isFile()) { mkdirSync(dirname(target), { recursive: true }); symlinkSync(source, target); }
    } catch { /* Original behavior retained; link handling remains a prerequisite. */ }
  }
  const env = { ...process.env };
  if (arm === "regular") env.PI_TRIAL_DISABLE_DELEGATION = "1";
  else delete env.PI_TRIAL_DISABLE_DELEGATION;
  const child = spawn(process.env.PI_BINARY || "pi", ["--mode", "rpc"], { cwd: worktree, env, stdio: ["pipe", "pipe", "pipe"] });
  const rpc = new Rpc(child);
  let askedUser = false, stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
  rpc.listeners.add(message => {
    if (message.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(message.method)) {
      askedUser = true;
      child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, cancelled: true })}\n`);
    }
  });
  let promptStarted = Date.now(), sessionFile;
  try {
    const state = await rpc.request({ type: "get_state" }, 30_000);
    if (!state.success) throw new Error(state.error ?? "get_state failed");
    sessionFile = state.data?.sessionFile;
    const mode = await rpc.request({ type: "prompt", message: `/mode ${MODE[arm]}` }, 60_000);
    if (!mode.success) throw new Error(mode.error ?? "mode switch failed");
    const [provider, modelId] = options.model.split(/\/(.*)/s);
    const selected = await rpc.request({ type: "set_model", provider, modelId }, 30_000);
    if (!selected.success) throw new Error(selected.error ?? "set_model failed");
    const thinking = await rpc.request({ type: "set_thinking_level", level: options.thinking }, 30_000);
    if (!thinking.success) throw new Error(thinking.error ?? "set_thinking_level failed");
    const beforePrompt = await rpc.request({ type: "get_state" }, 30_000);
    if (!beforePrompt.success) throw new Error(beforePrompt.error ?? "get_state failed");
    const beforeCount = beforePrompt.data?.messageCount ?? 0;
    const prompt = arm === "regular" ? `${task.prompt.trim()}\n\nTrial constraint: specialist tools are unavailable in this session. Do the work here.` : task.prompt.trim();
    const accepted = await rpc.request({ type: "prompt", message: prompt }, 30_000);
    if (!accepted.success) throw new Error(accepted.error ?? "prompt failed");
    promptStarted = Date.now();
    const deadline = promptStarted + options.timeoutMs;
    let sawWork = false;
    while (Date.now() < deadline) {
      const current = await rpc.request({ type: "get_state" }, 30_000);
      if (!current.success) throw new Error(current.error ?? "get_state failed");
      sessionFile = current.data?.sessionFile ?? sessionFile;
      if (current.data?.isStreaming || (current.data?.messageCount ?? 0) > beforeCount) sawWork = true;
      if (sawWork && !current.data?.isStreaming && current.data?.pendingMessageCount === 0) break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 2000));
    }
    if (Date.now() >= deadline) { await rpc.request({ type: "abort" }, 10_000).catch(() => undefined); throw new Error("trial timed out"); }
  } finally { child.stdin.end(); if (!child.killed) child.kill("SIGTERM"); }
  const wallMs = Date.now() - promptStarted;
  if (!sessionFile) throw new Error(`no session file${stderr ? `: ${stderr}` : ""}`);
  // Never substitute whole-session accounting. The retained runner does not yet
  // capture these boundaries: even after other repairs it must fail here until it does.
  if (!options.boundaries) throw new Error("explicit task boundaries were not captured; scoring blocked");
  const score = await scoreSession(sessionFile, { ...options.boundaries, taskId: task.id });
  const checks = [];
  for (const check of task.checks) {
    const result = await runArgv(check.command, check.args, worktree, (check.timeoutSec ?? 600) * 1000);
    checks.push({ name: check.name, exitCode: result.exitCode });
  }
  const record = {
    at: new Date().toISOString(), taskId: task.id, arm, baseSha: sha, leadModel: options.model,
    sessionId: score.sessionId, sessionFile, wallMs, score, checks, accepted: null,
    processCompletion: null, verification: checks.every(check => check.exitCode === 0),
    // Mode/model consistency must be checked across events, not the final state.
    modeMismatch: score.events.some(e => e.mode !== MODE[arm]),
    modelMismatch: score.events.some(e => e.model !== options.model), askedUser, worktree,
  };
  if (options.remove) {
    await git(task.repo, ["worktree", "remove", "--force", worktree]).catch(error => { record.cleanupError = error.message; });
    if (!record.cleanupError) delete record.worktree;
  }
  return record;
}
function appendResult(path, record) { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify(record)}\n`); }
function readResults(path) {
  try { return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
function report(path) {
  const rows = readResults(path);
  for (const id of new Set(rows.map(row => row.taskId))) {
    console.log(id);
    const latest = new Map();
    for (const row of rows) if (row.taskId === id) latest.set(row.arm, row);
    for (const arm of ARMS) {
      const row = latest.get(arm);
      if (!row) { console.log(`  ${arm.padEnd(12)} unpaired`); continue; }
      const checks = row.checks ?? [];
      const accepted = row.accepted == null ? "pending" : row.accepted ? "yes" : "no";
      const flags = [row.modeMismatch ? "mode-mismatch" : "", row.modelMismatch ? "model-mismatch" : "", row.askedUser ? "asked-user" : ""].filter(Boolean).join(",");
      // Old costUsd values lack coverage evidence and must not look like invoices.
      const estimate = row.score?.costUsd ?? "unknown";
      console.log(`  ${arm.padEnd(12)} checks ${checks.filter(check => check.exitCode === 0).length}/${checks.length}  human acceptance ${accepted}  process completion ${row.processCompletion ?? "unknown"}  catalog estimate $${estimate}${flags ? `  ${flags}` : ""}`);
    }
    console.log(`  paired result: ${!latest.has("regular") || !latest.has("orchestrate") ? "incomplete" : "recorded; no mode-winner inference"}`);
  }
}
function accept(path, taskId, arm, value) {
  const rows = readResults(path);
  let target = -1;
  rows.forEach((row, index) => { if (row.taskId === taskId && row.arm === arm) target = index; });
  if (target < 0) throw new Error(`no ${arm} trial for ${taskId}`);
  rows[target] = { ...rows[target], accepted: value === "yes" };
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  console.log(`${taskId} ${arm} accepted=${value}`);
}
function usage() {
  console.log(`usage:
  node trial/run.mjs <task.json> --model provider/id --thinking <level> [--arm regular|orchestrate|both] [--timeout-min 120] [--base ref] [--results path] [--remove]
  node trial/run.mjs --preflight [task.json]
  node trial/run.mjs --report [results.jsonl]
  node trial/run.mjs --accept <taskId> <regular|orchestrate> <yes|no> [results.jsonl]

Execution is fail-closed pending every prerequisite printed by --preflight.
There is no execution bypass. Retained execution functions are not validated safe.
Preflight is read-only and invokes no model. --report is read-only; --accept records
human acceptance of the latest matching result, independently of checks/completion.
The task file is { id, repo, prompt, checks: [{ name, command, args, timeoutSec? }], base?, link? }.
Supported arms: regular means regular-without-delegation, versus orchestrate.
--remove remains gated with execution; its retained cleanup is not validated safe.
Costs are catalog estimates, not invoices; older cost records lack coverage evidence.
No default tuning or mode-winner claim is supported.`);
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help")) return usage();
  try {
    if (args[0] === "--preflight") {
      if (args.length > 2) throw new Error("usage: --preflight [task.json]");
      console.log(JSON.stringify(preflight(args[1]), null, 2)); process.exitCode = 1; return;
    }
    if (args[0] === "--report") return report(args[1] ?? RESULTS);
    if (args[0] === "--accept") {
      const [, taskId, arm, value, path] = args;
      if (!taskId || !ARMS.includes(arm) || !["yes", "no"].includes(value)) throw new Error("usage: --accept <taskId> <regular|orchestrate> <yes|no>");
      return accept(path ?? RESULTS, taskId, arm, value);
    }
    const taskPath = args.find(arg => !arg.startsWith("--") && !args[args.indexOf(arg) - 1]?.startsWith("--"));
    const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
    if (!taskPath) throw new Error("task file is required");
    const model = option("--model"), thinking = option("--thinking");
    if (!model?.includes("/") || !thinking) throw new Error("--model provider/id and --thinking are required so the arms use the same lead");
    const arm = option("--arm") ?? "both";
    if (arm !== "both" && !ARMS.includes(arm)) throw new Error("--arm must be regular, orchestrate, or both");
    const task = loadTask(resolve(taskPath));
    const timeoutMs = Number(option("--timeout-min") ?? 120) * 60_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 60_000) throw new Error("--timeout-min must be at least 1");
    requireSafeExecution(); // Before settings backup, worktree creation, or model invocation.
    // Original shared-settings implementation retained but unreachable. Replace,
    // do not enable, this block when process-local isolation is established.
    const settings = resolve(MODE_SETTINGS), backup = `${settings}.${process.pid}.trial-backup`;
    copyFileSync(settings, backup);
    try {
      for (const selected of arm === "both" ? ARMS : [arm]) {
        const record = await runArm(task, selected, { model, thinking, timeoutMs, remove: args.includes("--remove"), base: option("--base") });
        appendResult(option("--results") ?? RESULTS, record); console.log(JSON.stringify(record));
      }
    } finally { copyFileSync(backup, settings); rmSync(backup, { force: true }); }
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
