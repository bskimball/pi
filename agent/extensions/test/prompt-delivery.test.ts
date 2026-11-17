import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { build } from "esbuild";
import { registerModes } from "../prompt-commands/modes.ts";
import { REGULAR_SYSTEM_BLOCK, ORCHESTRATE_SYSTEM_BLOCK, FUSION_SYSTEM_BLOCK, WORK_SYSTEM_PROMPT, FUSION_PREFACE, PI_SYSTEM_BLOCK, UTOPIA_SYSTEM_BLOCK } from "../prompt-commands.ts";
import { initialPreferences } from "../prompt-commands/mode-state.ts";
import memory from "../continual-memory.ts";
import profile from "../user-profile.ts";
import jev from "../jev/index.ts";
import { prepareRequest, parseResponse, parseUsage } from "../muse/protocol.ts";
import { museReasoningEffort, museSkillOverrides } from "../muse/transport.ts";
import { getCurrentSystemMessage, getSystemMessageText, type Context, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { streamMuse } from "../muse/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { buildSystemPrompt, buildSystemPromptSections, normalizeBuildSystemPromptOptions } = await import(pathToFileURL(join(packageRoot, "core/system-prompt.js")).href);

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
  const transcriptPath = join(bridgePackage, "src/transcript.ts");
  assert.ok(existsSync(transcriptPath), "bridge layout changed — update prompt-delivery test");
  const dir = mkdtempSync(join(tmpdir(), "prompt-delivery-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldMode = process.env.PI_BEHAVIOR_MODE;
  const oldSubagent = process.env.PI_SUBAGENT;
  const oldFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT;
  try {
    const transcriptBundle = join(dir, "transcript.mjs");
    await build({ entryPoints: [transcriptPath], outfile: transcriptBundle, bundle: true, format: "esm", platform: "node", plugins: [{ name: "pi-runtime", setup(build) {
      build.onResolve({ filter: /^@earendil-works\/pi-ai$/ }, () => ({ path: import.meta.resolve("@earendil-works/pi-ai"), external: true }));
    } }] });
    const { toBridgeContext } = await import(pathToFileURL(transcriptBundle).href);
    const sections = { preamble: "Base", addendum: "Instructions", project_context: "Project", skills: "Skills", cwd: "Directory", mcp_servers: "MCP servers" };
    const replayMessages: Context["messages"] = [
      { role: "system", content: "", sections, timestamp: 0 },
      { role: "system", content: "", sections: { addendum: null, mcp_servers: null }, timestamp: 1 },
      { role: "system", content: "", sections: { addendum: sections.addendum, mcp_servers: sections.mcp_servers }, timestamp: 2 },
    ];
    const replayed = toBridgeContext({ messages: replayMessages });
    const replayedHead = getCurrentSystemMessage(replayMessages);
    assert.ok(replayedHead);
    assert.equal(replayed.systemPrompt, getSystemMessageText(replayedHead), "bridge preserves Pi replay order");
    for (const section of Object.values(sections)) assert.ok(replayed.systemPrompt.includes(section));
    writeFileSync(join(dir, "USER_PROFILE.local.md"), "Profile delivery token");
    writeFileSync(join(dir, "jev.json"), JSON.stringify({ apiKey: "test-only", routingAdvisory: { enabled: true } }));
    globalThis.fetch = async (_url, init) => {
      const questions = JSON.parse(String(init?.body)).questions;
      return { ok: true, json: async () => ({ model: "test", usage: { input_tokens: 1, output_tokens: 1 }, answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: "noul", noul: 1 }])) }) } as Response;
    };
    writeFileSync(join(dir, "mode-settings.json"), JSON.stringify({ ...initialPreferences(), fusion: { lead: { provider: "test", modelId: "lead", thinking: "off" }, sidekick: { provider: "test", modelId: "side", thinking: "off" } } }));
    const handlers: Record<string, Function[]> = {};
    const commands: Record<string, Function> = {};
    let nativeGuidance: { mode: string; instructions: string } | undefined;
    const pi: any = {
      on(name: string, fn: Function) { (handlers[name] ??= []).push(fn); },
      registerCommand(name: string, spec: any) { commands[name] = spec.handler; },
      registerTool() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {}, appendEntry() {},
      events: { emit(name: string, data: any) {
        if (name === "pi:fusion:configure") data.acknowledged = true;
        if (name === "pi:modes:guidance") nativeGuidance = data;
      } }, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
      getThinkingLevel: () => "off", setThinkingLevel() {}, setModel: async () => true,
    };
    registerModes(pi, REGULAR_SYSTEM_BLOCK, ORCHESTRATE_SYSTEM_BLOCK, FUSION_SYSTEM_BLOCK, WORK_SYSTEM_PROMPT, FUSION_PREFACE, PI_SYSTEM_BLOCK, UTOPIA_SYSTEM_BLOCK);
    memory(pi); profile(pi); jev(pi);
    const { default: crashLogger } = await import("../crash-logger.ts");
    crashLogger(pi);
    const ctx: any = { cwd: dir, hasUI: true, isIdle: () => true, modelRegistry: { find: () => ({ provider: "test", id: "lead" }) }, sessionManager: { getBranch: () => [] }, ui: { setStatus() {}, notify() {} } };
    for (const [mode, marker] of [["apex", "Regular mode"], ["utopia", "Utopia mode"], ["apex-orchestrate", "Strict orchestrator"], ["fusion", "Fusion mode"], ["pi", "Pi mode"], ["work", "Work mode"]]) {
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
      const nativeCards: Record<string, string> = {
        apex: REGULAR_SYSTEM_BLOCK, "apex-orchestrate": ORCHESTRATE_SYSTEM_BLOCK,
        fusion: FUSION_PREFACE + FUSION_SYSTEM_BLOCK,
      };
      assert.deepEqual(nativeGuidance, { mode, instructions: nativeCards[mode] ?? "" });
      assert.doesNotMatch(nativeGuidance!.instructions, /Caller base|Caller append|Profile delivery token|Continual memory/);
      const musePrompt = prepareRequest({ systemPrompt: current, messages: [{ role: "user", content: "Actual user request", timestamp: 0 }] }, dir).prompt;
      assert.match(musePrompt, new RegExp(marker), `${mode} Muse projection lost mode block`);
      if (mode !== "pi") {
        assert.match(musePrompt, /Profile delivery token/);
        assert.match(musePrompt, /Continual memory/);
      }
      if (mode === "fusion") assert.match(current, /^You are a coding assistant running inside pi, a coding agent harness\./, "Fusion retains the stock base without a custom prompt");
      const projected = toBridgeContext({ messages: [
        { role: "system", content: "", sections: buildSystemPromptSections(options), timestamp: 0 },
      ] }).systemPrompt;
      assert.equal(projected, current, `${mode} bridge altered Pi's system prompt`);
      assert.match(projected, new RegExp(marker), `${mode} bridge projection lost mode block`);
      const contracts: Record<string, RegExp[]> = {
        pi: [/targeted, bounded reads/, /actual diff and direct callers/, /self-review, not independent review/, /explicit user direction only/, /`\/task <request>`/, /Run it in the background with `task_start` and stay conversational/],
        apex: [/Apex is inline-first/, /bring in a specialist only when separate context, distinct judgment, or parallelism clearly pays/, /independent Oracle review when the user asks/, /MAY end the conversational turn while workers are live/, /not an obligatory next call/],
        utopia: [
          /Utopia combines Apex inline-first ownership and the full specialist roster with a warm pool of reusable execution `sidekick` workers/,
          /Inline-first lead, sidekick-first loops:/,
          /small \(<30 line\) doc\/README\/comment updates on a lead-owned checkout/,
          /Warm sidekick pool \(<100k reuse \+ parallel waves\):/,
          /MAY end the conversational turn while workers are live/,
      /accepted `sidekick` workers stay settled in the warm pool for reuse/,
      /Sidekick lifecycle:.*Never `task_close` an idle sidekick while another related unit is plausible/,
      /Preflight before blocking:.*call `browser_tabs` for an already-authenticated shared tab/,
      /Release closeout:.*built, installed, and live-verified as separate facts/,
          /Ephemeral specialists when distinct judgment or isolation pays:/,
        ],
        "apex-orchestrate": [/read-only outcome gets one appropriate evidence-returning role/, /one writer, and independent Oracle review/, /exact integrated content and environment are unchanged/, /User-visible live-page changes still need Inspector proof/, /MAY end the conversational turn while workers are live/],
        fusion: [/execution is theirs by default: iterative edit\/run\/inspect loops/, /Sidekick by default for execution/, /Put each item's owner, `lead` or `sidekick`, in its note/, /inspect the actual diff \(for writers\), boundary behavior, and captured acceptance evidence once/, /Accept compliant work/, /Require current-file inspection before edits/, /Stay conversational while the wave runs/, /stay conversational while they run/],
        work: [/informational or hypothetical question alone is not a commitment/, /named or clearly established client, system, asset, or workflow/, /explicit all-system request remains broad/, /ask one focused scope question before cross-system fanout/, /Stay conversational while the crew works/, /You may end the turn while they run/],
      };
      for (const [projection, text] of [["Pi", current], ["Muse", musePrompt], ["bridge", projected]]) {
        for (const contract of contracts[mode]!) assert.match(text, contract, `${mode} ${projection} missing ${contract}`);
      }
      assert.equal(options.forceSystemPrompt, undefined, `${mode} forced prompt`);
      if (mode !== "pi") {
        assert.match(current, /Profile delivery token/);
        assert.match(projected, /Profile delivery token/);
        assert.match(current, /Continual memory/);
        assert.match(projected, /Continual memory/);
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
    { role: "system", content: "Base instructions", sections: { mode: "Old mode", profile: "Keep profile", skills: "<available_skills><skill><name>review</name><description>Review code when asked</description><location>C:/skills/review/SKILL.md</location></skill></available_skills>" }, toolsAdded: [readTool], timestamp: 0 },
    { role: "user", content: "Analyze our prompts and skills; compare the show-me article", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "Private reasoning", thinkingSignature: "ENCRYPTED-SIGNATURE" }, { type: "toolCall", id: "read-1", name: "read", arguments: { path: "agent/SYSTEM.md" } }], api: "openai-responses", provider: "openai", model: "previous", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "Actual file contents" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], details: { rendererOnly: "RENDERER-DETAILS" }, isError: false, timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "Partial aborted turn" }], api: "openai-responses", provider: "openai", model: "previous", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "aborted", timestamp: 3 },
    { role: "system", content: "Later instructions", sections: { mode: "Regular mode" }, timestamp: 4 },
    { role: "user", content: "Jev routing advisory: underspecified scope. Hint, not a verdict.", timestamp: 5 },
  ] };
  const request = prepareRequest(context, "C:/workspace");
  assert.match(request.prompt, /Base instructions/);
  assert.match(request.prompt, /Later instructions/);
  assert.match(request.prompt, /Regular mode/);
  assert.match(request.prompt, /Keep profile/);
  assert.match(request.prompt, /Review code when asked/);
  assert.match(request.prompt, /C:\/skills\/review\/SKILL\.md/);
  assert.equal(request.prompt.split("<available_skills>").length - 1, 1);
  assert.doesNotMatch(request.prompt, /Old mode/);
  assert.match(request.prompt, /Analyze our prompts and skills/);
  assert.match(request.prompt, /Jev routing advisory/);
  assert.ok(request.prompt.indexOf("Analyze our prompts") < request.prompt.indexOf("Jev routing advisory"));
  assert.match(request.prompt, /read-1/);
  assert.match(request.prompt, /Actual file contents/);
  assert.match(request.prompt, /Image attachment 1/);
  assert.doesNotMatch(request.prompt, /aW1hZ2U=/);
  for (const dropped of [/ENCRYPTED-SIGNATURE/, /Private reasoning/, /RENDERER-DETAILS/, /Partial aborted turn/, /"usage"/, /openai-responses/]) assert.doesNotMatch(request.prompt, dropped);
  assert.deepEqual(request.images, [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
  assert.deepEqual(request.tools, [readTool]);
  assert.deepEqual(prepareRequest(context, "C:/workspace", "none").tools, []);
  const response = parseResponse(JSON.stringify({ text: "Reading…", tool_calls: [{ name: "read", arguments_json: '{"path":"agent/SYSTEM.md"}' }] }), request.tools);
  assert.equal(response.text, "Reading…");
  assert.equal(response.calls[0].name, "read");
  assert.deepEqual(response.calls[0].arguments, { path: "agent/SYSTEM.md" });
  assert.ok(response.calls[0].id);
  const escapedArgs = { path: String.raw`C:\new\temp\"quoted"`, text: "first line\nsecond line\twith literal \\n" };
  const escaped = parseResponse(JSON.stringify({ text: "", tool_calls: [
    { name: "read", arguments_json: JSON.stringify(escapedArgs) },
  ] }), request.tools);
  assert.deepEqual(escaped.calls[0].arguments, escapedArgs);
  assert.throws(() => parseResponse('{"text":"","tool_calls":[]}', []), /neither/);
  const malformedJson = "private sample payload";
  assert.throws(() => parseResponse(malformedJson, request.tools), {
    name: "SyntaxError", message: "Muse returned malformed JSON in the response envelope.",
  });
  assert.throws(() => parseResponse(JSON.stringify({ text: "", tool_calls: [
    { name: "read", arguments_json: malformedJson },
  ] }), request.tools), {
    name: "SyntaxError", message: 'Muse returned malformed JSON in arguments for tool "read".',
  });
  assert.throws(() => parseResponse(JSON.stringify({ text: "", tool_calls: [
    { name: "read", arguments_json: "{}" },
    { name: malformedJson, arguments_json: malformedJson },
  ] }), request.tools), {
    name: "SyntaxError", message: "Muse returned malformed JSON in arguments for tool call #2.",
  });
  assert.throws(() => parseResponse(JSON.stringify({ text: "", tool_calls: [
    { name: malformedJson, arguments_json: "null" },
  ] }), request.tools), { message: "Muse arguments for tool call #1 must be a JSON object." });
  const unlisted = parseResponse('{"text":"","tool_calls":[{"name":"bash","arguments_json":"{}"}]}', request.tools);
  assert.equal(unlisted.calls[0].name, "bash", "an unlisted tool reaches Pi's loop, which answers 'Tool not found' instead of failing the run");
  // Token counts captured from the real Muse Wonder round-trip (not a synthetic usage format).
  assert.deepEqual(parseUsage({ models: [{ model: "muse-wonder-1.0", input_tokens: 17978, cached_tokens: 0, output_tokens: 175, reasoning_tokens: 120, calls: 1 }] }), { input: 17978, output: 175, cacheRead: 0, cacheWrite: 0 });
  assert.throws(() => parseUsage({}), /no per-model/);
  assert.equal(museReasoningEffort(), "minimal");
  assert.equal(museReasoningEffort("off"), "minimal");
  assert.equal(museReasoningEffort("high"), "high");
  assert.equal(museReasoningEffort("max"), "ultra");
  assert.deepEqual(museSkillOverrides({ skills: [{ scope: "bundled", path: "bundled://example/SKILL.md" }, { scope: "user", path: "$HOME/skills/example/SKILL.md" }] }), [
    "--config", 'skills.activation.bundled={"bundled://example/SKILL.md":"off"}',
    "--config", 'skills.activation.user={"$HOME/skills/example/SKILL.md":"off"}',
  ]);
  assert.deepEqual(museSkillOverrides({ skills: [] }), []);
  assert.throws(() => museSkillOverrides({}), /Invalid Muse skill catalog/);
  assert.throws(() => museSkillOverrides({ skills: [{ scope: "unknown", path: "x" }] }), /Unsupported Muse skill catalog entry/);
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
