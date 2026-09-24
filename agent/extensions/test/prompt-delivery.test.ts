import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { build } from "esbuild";
import { registerModes } from "../prompt-commands/modes.ts";
import { initialPreferences } from "../prompt-commands/mode-state.ts";
import memory from "../continual-memory.ts";
import profile from "../user-profile.ts";
import jev from "../jev/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { buildSystemPrompt, normalizeBuildSystemPromptOptions } = await import(pathToFileURL(join(packageRoot, "core/system-prompt.js")).href);

// Generic entry-point inventory without executing unrelated extensions (which may register tools or start services).
const entries = readdirSync(root, { withFileTypes: true }).flatMap(item => {
  const path = join(root, item.name);
  if (item.isFile() && /\.[jt]s$/.test(item.name)) return [path];
  if (!item.isDirectory()) return [];
  const manifest = join(path, "package.json");
  if (existsSync(manifest)) {
    const names = JSON.parse(readFileSync(manifest, "utf8"))?.pi?.extensions;
    if (Array.isArray(names) && names.length) return names.map((name: string) => resolve(path, name));
  }
  return ["index.ts", "index.js"].map(name => join(path, name)).filter(existsSync).slice(0, 1);
});
const covered = new Set(["prompt-commands.ts", "continual-memory.ts", "user-profile.ts", "jev/index.ts", "crash-logger.ts"]);

test("every before_agent_start extension is covered by delivery contract", () => {
  for (const entry of entries) {
    const source = readFileSync(entry, "utf8");
    if (source.includes('pi.on("before_agent_start"') || source.includes("pi.on('before_agent_start'")) {
      assert.ok(covered.has(resolve(root, entry).slice(root.length + 1).replaceAll("\\", "/")), `uncovered handler: ${entry}`);
    }
  }
});

test("mode, memory and profile sections survive Pi and claude-bridge projection", async t => {
  const bridgePackage = join(getAgentDir(), "npm/node_modules/pi-claude-bridge");
  if (!existsSync(bridgePackage)) { t.skip("pi-claude-bridge not installed"); return; }
  const bridgePath = join(bridgePackage, "src/prompt-capture.ts");
  assert.ok(existsSync(bridgePath), "bridge layout changed — update prompt-delivery test");
  const dir = mkdtempSync(join(tmpdir(), "prompt-delivery-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldMode = process.env.PI_BEHAVIOR_MODE;
  const oldSubagent = process.env.PI_SUBAGENT;
  const oldFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  try {
    const bridgeBundle = join(dir, "prompt-capture.mjs");
    await build({ entryPoints: [bridgePath], outfile: bridgeBundle, bundle: true, format: "esm", platform: "node", plugins: [{ name: "pi-runtime", setup(build) {
      build.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: import.meta.resolve("@earendil-works/pi-coding-agent"), external: true }));
    } }] });
    const { PromptCaptures, projectPromptCapture } = await import(pathToFileURL(bridgeBundle).href);
    writeFileSync(join(dir, "USER_PROFILE.local.md"), "Profile delivery token");
    writeFileSync(join(dir, "jev.json"), JSON.stringify({ apiKey: "test-only", routingAdvisory: { enabled: true } }));
    globalThis.fetch = async (_url, init) => {
      const questions = JSON.parse(String(init?.body)).questions;
      return { ok: true, json: async () => ({ model: "test", usage: { input_tokens: 1, output_tokens: 1 }, answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: "noul", noul: 1 }])) }) } as Response;
    };
    writeFileSync(join(dir, "mode-settings.json"), JSON.stringify({ ...initialPreferences(), fusion: { lead: { provider: "test", modelId: "lead", thinking: "off" }, sidekick: { provider: "test", modelId: "side", thinking: "off" } } }));
    const handlers: Record<string, Function[]> = {};
    const commands: Record<string, Function> = {};
    const pi: any = {
      on(name: string, fn: Function) { (handlers[name] ??= []).push(fn); },
      registerCommand(name: string, spec: any) { commands[name] = spec.handler; },
      registerTool() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {}, appendEntry() {},
      events: { emit(name: string, data: any) { if (name === "pi:fusion:configure") data.acknowledged = true; } }, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
      getThinkingLevel: () => "off", setThinkingLevel() {}, setModel: async () => true,
    };
    registerModes(pi, "## Regular mode (active)", "## Strict orchestrator mode (active)", "## Fusion mode (active)", "## Work mode (active)", "Fusion preface\n", "## Pi mode (active)");
    memory(pi); profile(pi); jev(pi);
    const { default: crashLogger } = await import("../crash-logger.ts");
    crashLogger(pi);
    const ctx: any = { cwd: dir, hasUI: true, isIdle: () => true, modelRegistry: { find: () => ({ provider: "test", id: "lead" }) }, sessionManager: { getBranch: () => [] }, ui: { setStatus() {}, notify() {} } };
    for (const [mode, marker] of [["apex", "Regular mode"], ["apex-orchestrate", "Strict orchestrator"], ["fusion", "Fusion mode"], ["pi", "Pi mode"], ["work", "Work mode"]]) {
      if (mode !== "apex") await commands.mode(mode, ctx);
      process.env.PI_BEHAVIOR_MODE = mode;
      const options = normalizeBuildSystemPromptOptions({ cwd: dir, customPrompt: mode === "fusion" ? undefined : "Caller base", appendSystemPrompt: "Caller append" });
      let current = buildSystemPrompt(options);
      for (const handler of handlers.before_agent_start) {
        const result = await handler({ prompt: "Please evaluate this meaningful coding request and advise routing.", systemPrompt: current, systemPromptOptions: options }, ctx);
        if (result?.systemPrompt !== undefined) options.forceSystemPrompt = result.systemPrompt;
        current = options.forceSystemPrompt ?? buildSystemPrompt(options);
      }
      assert.match(current, new RegExp(marker));
      if (mode === "fusion") assert.match(current, /^You are an expert coding assistant operating inside pi/, "Fusion retains the stock base without a custom prompt");
      const captures = new PromptCaptures();
      captures.record(current, { custom: options.customPrompt, append: options.appendSystemPrompt, contextFiles: options.contextFiles, skills: options.skills });
      const capture = captures.resolve(current);
      assert.ok(capture);
      const projected = projectPromptCapture(capture, { skillReadTool: "none" });
      assert.match(projected!, new RegExp(marker), `${mode} bridge projection lost mode block`);
      assert.equal(options.forceSystemPrompt, undefined, `${mode} forced prompt`);
      if (mode !== "pi") {
        assert.match(current, /Profile delivery token/);
        assert.match(projected!, /Profile delivery token/);
        assert.match(current, /Continual memory/);
        assert.match(projected!, /Continual memory/);
      }
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldMode === undefined) delete process.env.PI_BEHAVIOR_MODE; else process.env.PI_BEHAVIOR_MODE = oldMode;
    if (oldSubagent === undefined) delete process.env.PI_SUBAGENT; else process.env.PI_SUBAGENT = oldSubagent;
    rmSync(dir, { recursive: true, force: true });
  }
});
