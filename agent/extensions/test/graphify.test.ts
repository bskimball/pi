import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { normalize, resolve as pathResolve } from "node:path";
import graphifyExtension, {
  boundModelOutput,
  buildGraphifyArgv,
  buildSystemBlock,
  detectArtifacts,
  graphifyHandoffInstruction,
  graphifyStatusText,
  isGraphifyUpdateCommand,
  QUERY_SCOPES,
  isLikelyCodePath,
  isPathInside,
  loadGraphifyConfig,
  OUTPUT_CAP_CHARS,
  parseGraphifyCommandTokens,
  resolveExecutable,
  resolveOutputDir,
  toProjectRelPath,
  TRUNCATION_MARKER,
} from "../graphify.ts";

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "graphify-ext-"));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function writeArtifacts(
  root: string,
  which: { wiki?: boolean; report?: boolean; graph?: boolean; needsUpdate?: boolean },
  outputDirName = "graphify-out",
) {
  const out = join(root, outputDirName);
  mkdirSync(out, { recursive: true });
  if (which.wiki) {
    mkdirSync(join(out, "wiki"), { recursive: true });
    writeFileSync(join(out, "wiki", "index.md"), "# wiki\n");
  }
  if (which.report) writeFileSync(join(out, "GRAPH_REPORT.md"), "# report\n");
  if (which.graph) writeFileSync(join(out, "graph.json"), "{}\n");
  if (which.needsUpdate) writeFileSync(join(out, "needs_update"), "1\n");
  return out;
}

describe("artifact detection", () => {
  it("uses path.join and reports wiki/report/graph independently", () => {
    const root = tempDir();
    writeArtifacts(root, { wiki: true, report: true, graph: true, needsUpdate: true });
    const arts = detectArtifacts(root, "graphify-out");
    assert.ok(arts);
    assert.equal(arts.exists, true);
    assert.equal(arts.wiki, join(arts.outputDir, "wiki", "index.md"));
    assert.equal(arts.report, join(arts.outputDir, "GRAPH_REPORT.md"));
    assert.equal(arts.graph, join(arts.outputDir, "graph.json"));
    assert.equal(arts.needsUpdate, true);
    assert.equal(arts.needsUpdatePath, join(arts.outputDir, "needs_update"));
  });

  it("exists is false when only the directory is present", () => {
    const root = tempDir();
    mkdirSync(join(root, "graphify-out"), { recursive: true });
    const arts = detectArtifacts(root, "graphify-out");
    assert.ok(arts);
    assert.equal(arts.exists, false);
    assert.equal(arts.wiki, null);
    assert.equal(arts.report, null);
    assert.equal(arts.graph, null);
  });
});

describe("config", () => {
  it("falls back when missing or malformed", () => {
    const root = tempDir();
    const missing = loadGraphifyConfig(root);
    assert.equal(missing.enabled, true);
    assert.equal(missing.executable, "graphify");
    assert.equal(missing.outputDir, "graphify-out");
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "graphify.json"), "{not json");
    const bad = loadGraphifyConfig(root);
    assert.equal(bad.executable, "graphify");
    writeFileSync(join(root, ".pi", "graphify.json"), "[]");
    const arr = loadGraphifyConfig(root);
    assert.equal(arr.enabled, true);
  });

  it("honors disabled", () => {
    const root = tempDir();
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "graphify.json"), JSON.stringify({ enabled: false }));
    assert.equal(loadGraphifyConfig(root).enabled, false);
  });

  it("rejects outputDir traversal", () => {
    const root = tempDir();
    assert.equal(resolveOutputDir(root, "../outside"), null);
    assert.equal(resolveOutputDir(root, "graphify-out"), join(root, "graphify-out"));
    assert.equal(isPathInside(root, join(root, "graphify-out")), true);
    assert.equal(isPathInside(root, join(root, "..", "nope")), false);
    assert.equal(isPathInside(root, join(root, "..cache")), true);
    assert.equal(isPathInside(root, join(root, "..", "cache")), false);
  });

  it("keeps bare executables bare; relative/absolute only if inside project cwd", () => {
    const root = tempDir();
    const cfgDir = join(root, ".pi");
    mkdirSync(cfgDir, { recursive: true });
    assert.equal(resolveExecutable("graphify", cfgDir, root), "graphify");
    const rel = resolveExecutable("./bin/graphify", cfgDir, root);
    assert.ok(rel);
    assert.ok(rel.includes(join(".pi", "bin", "graphify")) || rel.endsWith("bin\\graphify") || rel.endsWith("bin/graphify"));
    const abs = join(root, "abs-graphify");
    assert.equal(resolveExecutable(abs, cfgDir, root), normalize(abs));
    assert.equal(pathResolve(resolveExecutable(abs, cfgDir, root)!), pathResolve(abs));
    const outside = join(root, "..", "outside-graphify");
    assert.equal(resolveExecutable(outside, cfgDir, root), null);
    assert.equal(resolveExecutable("../../outside-graphify", cfgDir, root), null);
  });
});

describe("argv", () => {
  it("preserves shell metacharacters as individual values", () => {
    const q = buildGraphifyArgv({
      operation: "query",
      question: 'foo && bar; echo "x"|rm -rf /',
      mode: "dfs",
      budget: 12,
    });
    assert.deepEqual(q, ["query", 'foo && bar; echo "x"|rm -rf /', "--dfs", "--budget", "12"]);
    const p = buildGraphifyArgv({ operation: "path", from: "a$(id)", to: "b>out" });
    assert.deepEqual(p, ["path", "a$(id)", "b>out"]);
    const e = buildGraphifyArgv({ operation: "explain", concept: "x;y" });
    assert.deepEqual(e, ["explain", "x;y"]);
    const bfs = buildGraphifyArgv({ operation: "query", question: "q", mode: "bfs" });
    assert.ok(!bfs.includes("--dfs"));
    assert.ok(bfs.includes("--budget"));
    const graph = join("custom-out", "graph.json");
    assert.deepEqual(
      buildGraphifyArgv({ operation: "query", question: "q", budget: 9, graphPath: graph }),
      ["query", "q", "--graph", graph, "--budget", "9"],
    );
    assert.deepEqual(
      buildGraphifyArgv({ operation: "path", from: "a", to: "b", graphPath: graph }),
      ["path", "a", "b", "--graph", graph],
    );
    assert.deepEqual(
      buildGraphifyArgv({ operation: "explain", concept: "c", graphPath: graph }),
      ["explain", "c", "--graph", graph],
    );
  });

  it("emits --scope only on query and never on path/explain", () => {
    assert.deepEqual(
      QUERY_SCOPES,
      ["all", "runtime", "config", "tests", "docs", "reference"],
    );
    const q = buildGraphifyArgv({
      operation: "query",
      question: "q",
      budget: 10,
      scope: "runtime",
    });
    assert.deepEqual(q, ["query", "q", "--budget", "10", "--scope", "runtime"]);
    const all = buildGraphifyArgv({
      operation: "query",
      question: "q",
      budget: 10,
      scope: "all",
    });
    assert.ok(all.includes("--scope"));
    assert.equal(all[all.indexOf("--scope") + 1], "all");
    const noScope = buildGraphifyArgv({ operation: "query", question: "q", budget: 10 });
    assert.ok(!noScope.includes("--scope"));
    const p = buildGraphifyArgv({
      operation: "path",
      from: "a",
      to: "b",
      scope: "all",
    });
    assert.deepEqual(p, ["path", "a", "b"]);
    const e = buildGraphifyArgv({ operation: "explain", concept: "c", scope: "docs" });
    assert.deepEqual(e, ["explain", "c"]);
  });
});

describe("output bound", () => {
  it("caps near 12KB with truncation marker", () => {
    const huge = "x".repeat(OUTPUT_CAP_CHARS + 50);
    const out = boundModelOutput(huge, "");
    assert.ok(out.endsWith(TRUNCATION_MARKER.trim()) || out.includes("...[truncated]"));
    assert.ok(out.length <= OUTPUT_CAP_CHARS);
    assert.equal(boundModelOutput("ok", ""), "ok");
  });
});

type ToolExec = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  onUpdate: unknown,
  ctx: { cwd: string },
) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function loadExtension() {
  const tools: Array<{ name: string; execute: ToolExec }> = [];
  const commands: Record<string, (args: string, ctx: unknown) => unknown> = {};
  const listeners: Record<string, Array<(e: unknown, c: unknown) => unknown>> = {};
  const execCalls: Array<{ exe: string; argv: string[]; opts: Record<string, unknown> }> = [];
  let execImpl: (exe: string, argv: string[], opts: Record<string, unknown>) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
    killed?: boolean;
  }> = async () => ({ code: 0, stdout: "ok", stderr: "" });

  graphifyExtension({
    registerTool(spec: { name: string; execute: ToolExec }) {
      tools.push(spec);
    },
    registerCommand(name: string, spec: { handler: typeof commands[string] }) {
      commands[name] = spec.handler;
    },
    registerShortcut() {},
    on(event: string, handler: (e: unknown, c: unknown) => unknown) {
      (listeners[event] ??= []).push(handler);
    },
    exec: async (exe: string, argv: string[], opts: Record<string, unknown>) => {
      execCalls.push({ exe, argv, opts });
      return execImpl(exe, argv, opts);
    },
    sendUserMessage() {},
    sendMessage() {},
  } as any);

  return {
    tools,
    commands,
    listeners,
    execCalls,
    setExec(fn: typeof execImpl) {
      execImpl = fn;
    },
    emit: async (event: string, payload: unknown, ctx: unknown) => {
      let last: unknown;
      for (const handler of listeners[event] ?? []) last = await handler(payload, ctx);
      return last as any;
    },
  };
}

describe("tool registration and exec contract", () => {
  it("registers exactly one graphify tool and forwards cwd/signal/timeout", async () => {
    const root = tempDir();
    writeArtifacts(root, { graph: true });
    const ext = loadExtension();
    assert.equal(ext.tools.length, 1);
    assert.equal(ext.tools[0]!.name, "graphify");
    const ac = new AbortController();
    const result = await ext.tools[0]!.execute(
      "id",
      { operation: "query", question: "what?" },
      ac.signal,
      undefined,
      { cwd: root },
    );
    assert.notEqual(result.isError, true);
    assert.match(result.content[0]!.text, /ok/);
    assert.equal(ext.execCalls.length, 1);
    const call = ext.execCalls[0]!;
    assert.equal(call.exe, "graphify");
    assert.deepEqual(call.argv, [
      "query",
      "what?",
      "--graph",
      join(root, "graphify-out", "graph.json"),
      "--budget",
      "2000",
    ]);
    assert.equal(call.opts.cwd, root);
    assert.equal(call.opts.signal, ac.signal);
    assert.equal(typeof call.opts.timeout, "number");
    const schema = (ext.tools[0] as { parameters?: { properties?: Record<string, unknown> } }).parameters;
    const scopeSchema = schema?.properties?.scope as { anyOf?: Array<{ const?: string }> } | undefined;
    if (scopeSchema?.anyOf) {
      assert.deepEqual(
        scopeSchema.anyOf.map((x) => x.const),
        [...QUERY_SCOPES],
      );
    }
  });

  it("forwards query scope and omits it for path", async () => {
    const root = tempDir();
    writeArtifacts(root, { graph: true });
    const ext = loadExtension();
    await ext.tools[0]!.execute(
      "id",
      { operation: "query", question: "what?", scope: "config" },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );
    assert.deepEqual(ext.execCalls[0]!.argv, [
      "query",
      "what?",
      "--graph",
      join(root, "graphify-out", "graph.json"),
      "--budget",
      "2000",
      "--scope",
      "config",
    ]);
    await ext.tools[0]!.execute(
      "id",
      { operation: "path", from: "a", to: "b", scope: "all" },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );
    assert.deepEqual(ext.execCalls[1]!.argv, [
      "path",
      "a",
      "b",
      "--graph",
      join(root, "graphify-out", "graph.json"),
    ]);
  });

  it("errors when artifacts are missing", async () => {
    const root = tempDir();
    const ext = loadExtension();
    const result = await ext.tools[0]!.execute(
      "id",
      { operation: "query", question: "q" },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /\/graphify/);
    assert.match(result.content[0]!.text, /graphify \./);
    assert.equal(ext.execCalls.length, 0);
  });

  it("errors when graph.json is missing even if report exists", async () => {
    const root = tempDir();
    writeArtifacts(root, { report: true });
    const ext = loadExtension();
    const result = await ext.tools[0]!.execute(
      "id",
      { operation: "query", question: "q" },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /graph\.json is missing/);
    assert.match(result.content[0]!.text, /graphify \./);
    assert.equal(ext.execCalls.length, 0);
  });

  it("passes custom outputDir graph.json as --graph", async () => {
    const root = tempDir();
    writeArtifacts(root, { graph: true }, "kg-out");
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "graphify.json"),
      JSON.stringify({ outputDir: "kg-out" }),
    );
    const ext = loadExtension();
    await ext.tools[0]!.execute(
      "id",
      { operation: "explain", concept: "c" },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );
    assert.deepEqual(ext.execCalls[0]!.argv, [
      "explain",
      "c",
      "--graph",
      join(root, "kg-out", "graph.json"),
    ]);
  });

  it("nonzero exec returns bounded stderr and isError", async () => {
    const root = tempDir();
    writeArtifacts(root, { graph: true });
    const ext = loadExtension();
    const huge = "e".repeat(OUTPUT_CAP_CHARS + 80);
    ext.setExec(async () => ({ code: 2, stdout: "", stderr: huge }));
    const result = await ext.tools[0]!.execute(
      "id",
      { operation: "explain", concept: "x" },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.length <= OUTPUT_CAP_CHARS);
    assert.match(result.content[0]!.text, /truncated/);
  });

  it("rejects enabled:false without exec", async () => {
    const root = tempDir();
    writeArtifacts(root, { graph: true });
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "graphify.json"), JSON.stringify({ enabled: false }));
    const ext = loadExtension();
    const result = await ext.tools[0]!.execute(
      "id",
      { operation: "query", question: "q" },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /disabled/);
    assert.equal(ext.execCalls.length, 0);
  });

  it("rejects traversal outputDir without exec", async () => {
    const root = tempDir();
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "graphify.json"),
      JSON.stringify({ outputDir: "../outside-out" }),
    );
    const ext = loadExtension();
    const result = await ext.tools[0]!.execute(
      "id",
      { operation: "query", question: "q" },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /outputDir/);
    assert.equal(ext.execCalls.length, 0);
  });

  it("rejects executable outside project cwd before exec", async () => {
    const root = tempDir();
    writeArtifacts(root, { graph: true });
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "graphify.json"),
      JSON.stringify({ executable: join(root, "..", "evil-graphify") }),
    );
    const ext = loadExtension();
    const result = await ext.tools[0]!.execute(
      "id",
      { operation: "query", question: "q" },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /outside the project/);
    assert.equal(ext.execCalls.length, 0);
  });

  it("command-not-found thrown error is clean", async () => {
    const root = tempDir();
    writeArtifacts(root, { graph: true });
    const ext = loadExtension();
    const err = Object.assign(new Error("spawn graphify ENOENT"), { code: "ENOENT" });
    ext.setExec(async () => {
      throw err;
    });
    const result = await ext.tools[0]!.execute(
      "id",
      { operation: "query", question: "q" },
      new AbortController().signal,
      undefined,
      { cwd: root },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /executable not found/);
    assert.doesNotMatch(result.content[0]!.text, /stack/i);
    assert.doesNotMatch(result.content[0]!.text, /at Object/);
  });
});

describe("/graphify handoff", () => {
  it("sends idle message and busy followUp + notify", async () => {
    const sent: Array<{ prompt: string; opts?: unknown }> = [];
    const notices: string[] = [];
    const commands: Record<string, (args: string, ctx: unknown) => unknown> = {};
    graphifyExtension({
      registerTool() {},
      registerCommand(name: string, spec: { handler: typeof commands[string] }) {
        commands[name] = spec.handler;
      },
      on() {},
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      sendUserMessage(prompt: string, opts?: unknown) {
        sent.push({ prompt, opts });
      },
    } as any);

    const idleCtx = {
      isIdle: () => true,
      hasUI: true,
      ui: { notify: (m: string) => notices.push(m), setStatus() {} },
    };
    await commands.graphify!("", idleCtx);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.opts, undefined);
    const defaultHandoff = sent[0]!.prompt;
    assert.match(defaultHandoff, /agent\/skills\/graphify\/SKILL\.md/);
    assert.match(defaultHandoff, /machinist/);
    assert.match(defaultHandoff, /Do not ask for an API key/);
    assert.match(defaultHandoff, /Do not fall back to `graphify \. --code-only`/);
    assert.match(defaultHandoff, /never execute the CLI as `graphify build`/i);
    assert.doesNotMatch(defaultHandoff, /Translate this to a portable bash/);
    const updateHandoff = graphifyHandoffInstruction("update .");
    assert.match(updateHandoff, /agent\/skills\/graphify\/SKILL\.md/);
    assert.match(updateHandoff, /machinist/);
    assert.match(updateHandoff, /Do not ask for an API key/);
    assert.doesNotMatch(updateHandoff, /Run portable bash[\s\S]*graphify update/);
    assert.doesNotMatch(updateHandoff, /`graphify update \.` as the complete/);
    assert.match(updateHandoff, /not treat a raw shell `graphify update`/);

    const queryHandoff = graphifyHandoffInstruction("query foo");
    assert.match(queryHandoff, /graphify tool/);
    assert.doesNotMatch(queryHandoff, /SKILL\.md/);
    assert.doesNotMatch(queryHandoff, /machinist/);
    const buildHandoff = graphifyHandoffInstruction("build src");
    assert.match(buildHandoff, /agent\/skills\/graphify\/SKILL\.md/);
    assert.match(buildHandoff, /full Graphify build of src/);
    assert.match(buildHandoff, /machinist/);
    assert.match(buildHandoff, /Do not ask for an API key/);
    assert.match(buildHandoff, /Do not fall back to `graphify \. --code-only`/);
    assert.match(buildHandoff, /never execute the CLI as `graphify build`/i);
    assert.doesNotMatch(buildHandoff, /Translate this to a portable bash/i);
    const pathHandoff = graphifyHandoffInstruction(".");
    assert.match(pathHandoff, /SKILL\.md/);
    assert.match(pathHandoff, /machinist/);
    assert.match(pathHandoff, /Never execute the CLI as `graphify build`/);
    assert.doesNotMatch(pathHandoff, /`graphify build <path>`/);

    const busyCtx = {
      isIdle: () => false,
      hasUI: true,
      ui: { notify: (m: string) => notices.push(m), setStatus() {} },
    };
    await commands.graphify!("query foo", busyCtx);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1]!.opts, { deliverAs: "followUp" });
    assert.ok(notices.some((n) => /follow-up/i.test(n)));
  });
});

describe("system prompt and stale", () => {
  it("injects wiki-first system block and stale warning", async () => {
    const prev = process.env.PI_SUBAGENT;
    delete process.env.PI_SUBAGENT;
    try {
    const root = tempDir();
    writeArtifacts(root, { wiki: true, report: true, graph: true, needsUpdate: true });
    const ext = loadExtension();
    const event = { systemPrompt: "base" };
    await ext.emit("before_agent_start", event, { cwd: root, ui: { setStatus() {} } });
    assert.match(event.systemPrompt, /## Graphify/);
    const wikiIdx = event.systemPrompt.indexOf("Wiki:");
    const reportIdx = event.systemPrompt.indexOf("Report:");
    assert.ok(wikiIdx > 0 && reportIdx > wikiIdx);
    assert.match(event.systemPrompt, /stale/i);
    assert.match(event.systemPrompt, /graphify-out\/wiki\/index\.md/);
    assert.doesNotMatch(event.systemPrompt, /[A-Za-z]:\\/);
    assert.ok(event.systemPrompt.split("\n").length <= 20);
    const block = buildSystemBlock(detectArtifacts(root, "graphify-out")!, false, root);
    assert.ok(block.split("\n").length <= 10);
    assert.equal(toProjectRelPath(root, join(root, "graphify-out", "wiki", "index.md")), "graphify-out/wiki/index.md");
    } finally {
      if (prev === undefined) delete process.env.PI_SUBAGENT;
      else process.env.PI_SUBAGENT = prev;
    }
  });

  it("does not inject the wiki-first system block for subagents", async () => {
    const prev = process.env.PI_SUBAGENT;
    process.env.PI_SUBAGENT = "1";
    try {
      const root = tempDir();
      writeArtifacts(root, { wiki: true, report: true, graph: true, needsUpdate: true });
      const ext = loadExtension();
      const event = { systemPrompt: "base" };
      await ext.emit("before_agent_start", event, { cwd: root, ui: { setStatus() {} } });
      assert.equal(event.systemPrompt, "base");
      assert.doesNotMatch(event.systemPrompt, /## Graphify/);
    } finally {
      if (prev === undefined) delete process.env.PI_SUBAGENT;
      else process.env.PI_SUBAGENT = prev;
    }
  });

  it("edit marks stale once; graphify update clears in-session stale; needs_update stays", async () => {
    const root = tempDir();
    writeArtifacts(root, { graph: true, needsUpdate: true });
    const ext = loadExtension();
    const statuses: Array<string | undefined> = [];
    const ctx = {
      cwd: root,
      ui: {
        setStatus(_key: string, value: string | undefined) {
          statuses.push(value);
        },
      },
    };
    await ext.emit("turn_start", {}, ctx);

    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "x");
    const ev1 = {
      toolName: "edit",
      isError: false,
      input: { path: join(root, "src", "app.ts") },
      content: [{ type: "text", text: "patched" }],
    };
    const ret1 = await ext.emit("tool_result", ev1, ctx);
    assert.equal(ev1.content[0]!.text, "patched");
    assert.ok(Array.isArray(ret1?.content));
    assert.match(ret1.content.map((c: { text: string }) => c.text).join("\n"), /graph may be stale/i);
    assert.ok(statuses.includes("graphify stale"));
    const artsAfterEdit = detectArtifacts(root, "graphify-out")!;
    assert.equal(graphifyStatusText(artsAfterEdit, true, true), "graphify stale");

    const ev2 = {
      toolName: "edit",
      isError: false,
      input: { path: join(root, "src", "app.ts") },
      content: [{ type: "text", text: "patched again" }],
    };
    const ret2 = await ext.emit("tool_result", ev2, ctx);
    assert.equal(ev2.content[0]!.text, "patched again");
    assert.equal(ret2, undefined);

    assert.equal(isLikelyCodePath(join(root, "src", "app.ts"), join(root, "graphify-out")), true);
    assert.equal(isLikelyCodePath(join(root, "graphify-out", "wiki", "index.md"), join(root, "graphify-out")), false);
    assert.equal(isGraphifyUpdateCommand("graphify update ."), true);
    assert.equal(isGraphifyUpdateCommand("graphify ."), true);
    assert.equal(isGraphifyUpdateCommand("graphify ./src"), true);
    assert.equal(isGraphifyUpdateCommand("graphify C:/repo"), true);
    assert.equal(isGraphifyUpdateCommand("graphify src"), true);
    assert.equal(isGraphifyUpdateCommand("graphify extract ."), true);
    assert.equal(isGraphifyUpdateCommand("graphify cluster-only"), true);
    assert.equal(isGraphifyUpdateCommand('"graphify" .'), true);
    assert.equal(isGraphifyUpdateCommand("graphify query foo"), false);
    assert.equal(isGraphifyUpdateCommand("graphify path a b"), false);
    assert.equal(isGraphifyUpdateCommand("graphify explain x"), false);
    assert.equal(isGraphifyUpdateCommand("graphify install"), false);
    assert.equal(isGraphifyUpdateCommand("graphify --version"), false);
    assert.equal(isGraphifyUpdateCommand("graphify help"), false);
    assert.equal(isGraphifyUpdateCommand("graphify god-nodes"), false);
    assert.equal(isGraphifyUpdateCommand("graphify affected"), false);
    assert.equal(isGraphifyUpdateCommand("graphify tree"), false);
    assert.equal(isGraphifyUpdateCommand("graphify check-update"), false);
    assert.equal(isGraphifyUpdateCommand("graphify watch"), false);
    assert.equal(isGraphifyUpdateCommand("echo graphify ./x"), false);
    assert.equal(isGraphifyUpdateCommand("git log -- graphify path/to/file"), false);
    assert.equal(isGraphifyUpdateCommand("npx something graphify C:/repo"), false);
    assert.equal(isGraphifyUpdateCommand("ls"), false);
    assert.ok(parseGraphifyCommandTokens("graphify update .").includes("update"));

    await ext.emit(
      "tool_result",
      {
        toolName: "bash",
        isError: false,
        input: { command: "graphify update ." },
        content: [{ type: "text", text: "done" }],
      },
      ctx,
    );
    const arts = detectArtifacts(root, "graphify-out")!;
    assert.equal(arts.needsUpdate, true);
    assert.equal(graphifyStatusText(arts, true, false), "graphify stale");
    assert.equal(statuses.at(-1), "graphify stale");
  });

  it("successful rebuild without needs_update clears status", async () => {
    const root = tempDir();
    writeArtifacts(root, { graph: true });
    const ext = loadExtension();
    const statuses: Array<string | undefined> = [];
    const ctx = {
      cwd: root,
      ui: {
        setStatus(_key: string, value: string | undefined) {
          statuses.push(value);
        },
      },
    };
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "x");
    await ext.emit("turn_start", {}, ctx);
    await ext.emit(
      "tool_result",
      {
        toolName: "edit",
        isError: false,
        input: { path: join(root, "src", "app.ts") },
        content: [{ type: "text", text: "ok" }],
      },
      ctx,
    );
    assert.equal(statuses.at(-1), "graphify stale");
    const graphPath = join(root, "graphify-out", "graph.json");
    const later = Date.now() / 1000 + 5;
    utimesSync(graphPath, later, later);
    await ext.emit(
      "tool_result",
      {
        toolName: "bash",
        isError: false,
        input: { command: "graphify ." },
        content: [{ type: "text", text: "built" }],
      },
      ctx,
    );
    assert.equal(statuses.at(-1), undefined);
    assert.equal(graphifyStatusText(detectArtifacts(root, "graphify-out"), true, false), undefined);
  });

  it("session_start resets sessionStale before status refresh", async () => {
    const dirty = tempDir();
    writeArtifacts(dirty, { graph: true });
    const clean = tempDir();
    writeArtifacts(clean, { graph: true });
    const ext = loadExtension();
    const statuses: Array<string | undefined> = [];
    const dirtyCtx = {
      cwd: dirty,
      ui: {
        setStatus(_key: string, value: string | undefined) {
          statuses.push(value);
        },
      },
    };
    mkdirSync(join(dirty, "src"), { recursive: true });
    writeFileSync(join(dirty, "src", "app.ts"), "x");
    await ext.emit("turn_start", {}, dirtyCtx);
    await ext.emit(
      "tool_result",
      {
        toolName: "edit",
        isError: false,
        input: { path: join(dirty, "src", "app.ts") },
        content: [{ type: "text", text: "ok" }],
      },
      dirtyCtx,
    );
    assert.equal(statuses.at(-1), "graphify stale");
    const cleanCtx = {
      cwd: clean,
      ui: {
        setStatus(_key: string, value: string | undefined) {
          statuses.push(value);
        },
      },
    };
    await ext.emit("session_start", {}, cleanCtx);
    assert.equal(statuses.at(-1), undefined);
  });

  it("write marks stale; unchanged graph after rebuild stays stale; rewrite clears", async () => {
    const root = tempDir();
    writeArtifacts(root, { graph: true });
    const ext = loadExtension();
    const statuses: Array<string | undefined> = [];
    const ctx = {
      cwd: root,
      ui: {
        setStatus(_key: string, value: string | undefined) {
          statuses.push(value);
        },
      },
    };
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "x");
    await ext.emit("turn_start", {}, ctx);
    const ret = await ext.emit(
      "tool_result",
      {
        toolName: "write",
        isError: false,
        input: { path: join(root, "src", "app.ts") },
        content: [{ type: "text", text: "wrote" }],
      },
      ctx,
    );
    assert.ok(Array.isArray(ret?.content));
    assert.match(ret.content.map((c: { text: string }) => c.text).join("\n"), /graph may be stale/i);
    assert.equal(statuses.at(-1), "graphify stale");

    await ext.emit(
      "tool_result",
      {
        toolName: "bash",
        isError: false,
        input: { command: "graphify ." },
        content: [{ type: "text", text: "noop" }],
      },
      ctx,
    );
    assert.equal(statuses.at(-1), "graphify stale");

    const graphPath = join(root, "graphify-out", "graph.json");
    const later = Date.now() / 1000 + 10;
    utimesSync(graphPath, later, later);
    await ext.emit(
      "tool_result",
      {
        toolName: "powershell",
        isError: false,
        input: { command: "graphify update ." },
        content: [{ type: "text", text: "rebuilt" }],
      },
      ctx,
    );
    assert.equal(statuses.at(-1), undefined);
  });
});
