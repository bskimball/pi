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
import { prepareRequest, parseResponse, parseUsage } from "../muse/protocol.ts";
import { Type, type Context, type Model } from "@earendil-works/pi-ai";
import { streamMuse } from "../muse/index.ts";

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
    const transcriptBundle = join(dir, "transcript.mjs");
    await build({ entryPoints: [join(bridgePackage, "src/transcript.ts")], outfile: transcriptBundle, bundle: true, format: "esm", platform: "node", plugins: [{ name: "pi-runtime", setup(build) {
      build.onResolve({ filter: /^@earendil-works\/pi-ai$/ }, () => ({ path: import.meta.resolve("@earendil-works/pi-ai"), external: true }));
    } }] });
    const { toBridgeContext } = await import(pathToFileURL(transcriptBundle).href);
    const sections = { preamble: "Base", addendum: "Instructions", project_context: "Project", skills: "Skills", cwd: "Directory", mcp_servers: "MCP servers" };
    const canonical = Object.values(sections).join("\n\n");
    const replayed = toBridgeContext({ messages: [
      { role: "system", content: "", sections, timestamp: 0 },
      { role: "system", content: "", sections: { addendum: null, mcp_servers: null }, timestamp: 1 },
      { role: "system", content: "", sections: { addendum: sections.addendum, mcp_servers: sections.mcp_servers }, timestamp: 2 },
    ] });
    assert.equal(replayed.systemPrompt, canonical, "restored sections retain canonical order");
    const replayCaptures = new PromptCaptures();
    replayCaptures.record(canonical, { custom: "Base", append: "Instructions", contextFiles: [], skills: [] });
    assert.ok(replayCaptures.resolve(replayed.systemPrompt), "restored prompt resolves its original capture");
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
      const musePrompt = prepareRequest({ systemPrompt: current, messages: [{ role: "user", content: "Actual user request", timestamp: 0 }] }, dir).prompt;
      assert.match(musePrompt, new RegExp(marker), `${mode} Muse projection lost mode block`);
      if (mode !== "pi") {
        assert.match(musePrompt, /Profile delivery token/);
        assert.match(musePrompt, /Continual memory/);
      }
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

test("Muse preserves the request before advisories, system patches, tool results and image positions", () => {
  const readTool = { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };
  const context: Context = { messages: [
    { role: "system", content: "Base instructions", sections: { mode: "Old mode", profile: "Keep profile" }, toolsAdded: [readTool], timestamp: 0 },
    { role: "user", content: "Analyze our prompts and skills; compare the show-me article", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "agent/SYSTEM.md" } }], api: "openai-responses", provider: "openai", model: "previous", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "Actual file contents" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], isError: false, timestamp: 3 },
    { role: "system", content: "Later instructions", sections: { mode: "Regular mode" }, timestamp: 4 },
    { role: "user", content: "Jev routing advisory: underspecified scope. Hint, not a verdict.", timestamp: 5 },
  ] };
  const request = prepareRequest(context, "C:/workspace");
  assert.match(request.prompt, /Base instructions/);
  assert.match(request.prompt, /Later instructions/);
  assert.match(request.prompt, /Regular mode/);
  assert.match(request.prompt, /Keep profile/);
  assert.doesNotMatch(request.prompt, /Old mode/);
  assert.match(request.prompt, /Analyze our prompts and skills/);
  assert.match(request.prompt, /Jev routing advisory/);
  assert.ok(request.prompt.indexOf("Analyze our prompts") < request.prompt.indexOf("Jev routing advisory"));
  assert.match(request.prompt, /read-1/);
  assert.match(request.prompt, /Actual file contents/);
  assert.match(request.prompt, /Image attachment 1/);
  assert.doesNotMatch(request.prompt, /aW1hZ2U=/);
  assert.deepEqual(request.images, [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
  assert.deepEqual(request.tools, [readTool]);
  assert.deepEqual(prepareRequest(context, "C:/workspace", "none").tools, []);
  const response = parseResponse(JSON.stringify({ text: "Reading…", tool_calls: [{ name: "read", arguments_json: '{"path":"agent/SYSTEM.md"}' }] }), request.tools);
  assert.equal(response.text, "Reading…");
  assert.equal(response.calls[0].name, "read");
  assert.deepEqual(response.calls[0].arguments, { path: "agent/SYSTEM.md" });
  assert.ok(response.calls[0].id);
  assert.throws(() => parseResponse('{"text":"","tool_calls":[]}', []), /neither/);
  assert.throws(() => parseResponse('{"text":"","tool_calls":[{"name":"bash","arguments_json":"{}"}]}', request.tools), /unavailable/);
  // Token counts captured from the real Muse Wonder round-trip (not a synthetic usage format).
  assert.deepEqual(parseUsage({ models: [{ model: "muse-wonder-1.0", input_tokens: 17978, cached_tokens: 0, output_tokens: 175, reasoning_tokens: 120, calls: 1 }] }), { input: 17978, output: 175, cacheRead: 0, cacheWrite: 0 });
  assert.throws(() => parseUsage({}), /no per-model/);
});

test("Muse honors outgoing-payload interception before launching the CLI", async () => {
  const model: Model<"muse-code-cli"> = { id: "muse-wonder-1.0", name: "Muse Wonder", provider: "muse-code", api: "muse-code-cli", baseUrl: "http://localhost", reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const context: Context = { messages: [{ role: "user", content: "Original task before an advisory", timestamp: 0 }] };
  let called = false;
  const rejected = await streamMuse(model, context, { onPayload: async (payload, currentModel) => {
    called = true;
    assert.equal(currentModel, model);
    assert.match(JSON.stringify(payload), /Original task before an advisory/);
    throw new Error("Request blocked by interceptor");
  } }).result();
  assert.equal(called, true);
  assert.equal(rejected.stopReason, "error");
  assert.equal(rejected.errorMessage, "Request blocked by interceptor");
  const replaced = await streamMuse(model, context, { onPayload: () => ({ prompt: "Replaced task", tools: [], images: [{ type: "image", data: "", mimeType: "unsupported/test" }] }) }).result();
  assert.equal(replaced.stopReason, "error");
  assert.match(replaced.errorMessage!, /does not support this image MIME type: unsupported\/test/);
});
