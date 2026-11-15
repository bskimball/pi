import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { normalizeContext } from "@earendil-works/pi-ai";
import { ReplayCheckpoints, withoutPiInstructions, workerContract } from "../antigravity-native/context.ts";
import type { GenerateOptions, RequestMessage } from "../antigravity-native/node_modules/pi-agy-acp/src/protocol.ts";

const user = (id: string, text: string): RequestMessage => ({ id, role: "user", content: [{ type: "text", text }] });
function directory(request: GenerateOptions): string {
  const file = JSON.parse(request.system!.match(/Recovery checkpoint: ("[^\n]+?")\./)![1]);
  const dir = dirname(file);
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + "/") || resolve(dir).startsWith(resolve(tmpdir()) + "\\"));
  assert.ok(dir.includes("pi-agy-checkpoint-"));
  return dir;
}

test("task contracts preserve role, constraints and report schema without taking the rendered Pi prompt", () => {
  const argv = ["node", "pi", "--system-prompt", "ROLE: read only", "--append-system-prompt", "HANDOFF", "--append-system-prompt", "SCHEMA"];
  assert.equal(workerContract(argv, { PI_SUBAGENT: "1", PI_TASK_PROMPT_CONTRACT: "1" }), "ROLE: read only\n\nHANDOFF\n\nSCHEMA");
  assert.equal(workerContract(argv, { PI_SUBAGENT: "1" }), "");
  assert.equal(workerContract(argv, { PI_TASK_PROMPT_CONTRACT: "1" }), "");
  const projected = withoutPiInstructions(normalizeContext({ messages: [
    { role: "system", content: "LEAD_PROMPT", sections: { private: "PROFILE" }, timestamp: 0 },
    { role: "user", content: "WORK_ORDER", timestamp: 1 },
  ] }));
  assert.doesNotMatch(JSON.stringify(projected), /LEAD_PROMPT|PROFILE/);
  assert.match(JSON.stringify(projected), /WORK_ORDER/);
});

test("checkpoint stays stable across tool continuations and archives text without image or reasoning payloads", () => {
  const checkpoints = new ReplayCheckpoints();
  const initial: GenerateOptions = { model: "test", sessionId: "lead", messages: [user("u1", "Do not edit production")] };
  const first = checkpoints.prepare(initial, "MODE");
  const dir = directory(first);
  try {
    const next = checkpoints.prepare({ ...initial, system: "PAYLOAD_OVERRIDE", messages: [...initial.messages,
      { id: "a1", role: "assistant", source: { kind: "model", provider: "test" }, content: [
        { type: "reasoning", text: "PRIVATE_REASONING" },
        { type: "tool-call", id: "call", name: "read", arguments: "{}" },
      ] },
      { id: "t1", role: "tool", toolCallId: "call", content: [{ type: "text", text: "DECISIVE_EVIDENCE" }, { type: "image", data: "PIXEL_SECRET", mimeType: "image/png" }] },
    ] }, "MODE");
    assert.equal(next.system, first.system);
    assert.doesNotMatch(next.system!, /PAYLOAD_OVERRIDE/);
    const history = readFileSync(join(dir, "history.jsonl"), "utf8");
    assert.match(history, /DECISIVE_EVIDENCE/);
    assert.doesNotMatch(history, /PRIVATE_REASONING|PIXEL_SECRET/);
    assert.match(history, /Historical image/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compaction retains original task, explicit handoff and pre-reset evidence; worker forks pin the new work order", () => {
  const checkpoints = new ReplayCheckpoints(true);
  const initial: GenerateOptions = { model: "test", sessionId: "worker", messages: [user("parent", "Unrelated parent task"), user("unit", "Owned path src/a.ts")] };
  const first = checkpoints.prepare(initial, "WORKER");
  const dir = directory(first);
  try {
    assert.match(first.system!, /Owned path src\/a.ts/);
    assert.doesNotMatch(first.system!, /Unrelated parent task/);
    checkpoints.prepare({ ...initial, messages: [...initial.messages, {
      id: "a1", role: "assistant", source: { kind: "model", provider: "test" },
      content: [{ type: "text", text: '```handoff\n{"findings":"Do not retry migration"}\n```' }],
    }] }, "WORKER");
    checkpoints.reset();
    const compacted = checkpoints.prepare({ ...initial, messages: [user("summary", "Compaction summary: validation pending")] }, "WORKER");
    assert.equal(compacted.system, first.system);
    assert.match(readFileSync(join(dir, "history-1.jsonl"), "utf8"), /Do not retry migration/);
    const checkpoint = readFileSync(join(dir, "checkpoint.md"), "utf8");
    assert.match(checkpoint, /Do not retry migration/);
    assert.match(checkpoint, /validation pending/);
    assert.equal(readFileSync(join(dir, "task.txt"), "utf8"), "Owned path src/a.ts");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("actual pinned ACP replay omits an old constraint that remains recoverable from the checkpoint", async () => {
  const bundleDir = mkdtempSync(join(tmpdir(), "pi-agy-replay-test-"));
  const checkpoints = new ReplayCheckpoints();
  const request = checkpoints.prepare({ model: "test", sessionId: "large", messages: [
    user("original", "MUST_PRESERVE_CONSTRAINT"),
    { id: "large-result", role: "tool", toolCallId: "call", content: [{ type: "text", text: "x".repeat(180_000) }] },
    user("next", "Continue validation"),
  ] }, "MODE");
  const dir = directory(request);
  try {
    const outfile = join(bundleDir, "history.mjs");
    await build({ entryPoints: ["agent/extensions/antigravity-native/node_modules/pi-agy-acp/src/history.ts"], outfile, bundle: true, platform: "node", format: "esm" });
    const { replayPrompt } = await import(pathToFileURL(outfile).href);
    const replay = JSON.stringify(replayPrompt(request.messages.slice(0, -1), request.messages.slice(-1)));
    assert.match(replay, /omitted|truncated/);
    assert.doesNotMatch(replay, /MUST_PRESERVE_CONSTRAINT/);
    assert.match(request.system!, /MUST_PRESERVE_CONSTRAINT/);
    assert.match(readFileSync(join(dir, "history.jsonl"), "utf8"), /MUST_PRESERVE_CONSTRAINT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
  }
});

test("sessions are isolated and branch switches do not reuse an abandoned handoff", () => {
  const checkpoints = new ReplayCheckpoints();
  const first = checkpoints.prepare({ model: "test", sessionId: "first", messages: [user("one", "FIRST_TASK"), {
    id: "answer", role: "assistant", source: { kind: "model", provider: "test" },
    content: [{ type: "text", text: '```handoff\n{"findings":"ABANDONED_DECISION"}\n```' }],
  }] }, "MODE");
  const second = checkpoints.prepare({ model: "test", sessionId: "second", messages: [user("two", "SECOND_TASK")] }, "MODE");
  const firstDir = directory(first), secondDir = directory(second);
  try {
    assert.notEqual(firstDir, secondDir);
    assert.doesNotMatch(second.system!, /FIRST_TASK/);
    assert.doesNotMatch(readFileSync(join(secondDir, "checkpoint.md"), "utf8"), /ABANDONED_DECISION/);
    checkpoints.reset(false);
    checkpoints.prepare({ model: "test", sessionId: "first", messages: [user("one", "FIRST_TASK"), user("branch", "Different approach")] }, "MODE");
    assert.doesNotMatch(readFileSync(join(firstDir, "checkpoint.md"), "utf8"), /ABANDONED_DECISION/);
  } finally {
    rmSync(firstDir, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
});

test("registered provider forwards only the worker contract and recovery instructions after payload projection", async () => {
  const bundleDir = mkdtempSync(join(tmpdir(), "pi-agy-provider-test-"));
  const oldArgv = process.argv;
  const oldSubagent = process.env.PI_SUBAGENT;
  const oldContract = process.env.PI_TASK_PROMPT_CONTRACT;
  let checkpointDir: string | undefined;
  const handlers = new Map<string, Function>();
  try {
    const outfile = join(bundleDir, "provider.mjs");
    await build({ entryPoints: ["agent/extensions/antigravity-native/index.ts"], outfile, bundle: true, platform: "node", format: "esm", plugins: [{
      name: "offline-runtime", setup(builder) {
        builder.onResolve({ filter: /^@earendil-works\// }, args => ({ path: import.meta.resolve(args.path), external: true }));
        builder.onResolve({ filter: /^pi-agy-acp\// }, args => ({ path: args.path, namespace: "offline" }));
        builder.onLoad({ filter: /.*/, namespace: "offline" }, args => ({ contents:
          args.path.endsWith("runtime.ts") ? `export class AntigravityRuntime {
            catalog = { list: () => [] }; async warmup() {} async dispose() {}
            resetConversations() {} settleSession() {} stream(request) { return request; }
          }` : args.path.endsWith("config.ts") ? "export const defaults = {};"
          : args.path.endsWith("host.ts") ? "export function runCommand() { throw Error('Unexpected CLI invocation'); }"
          : "export function streamPi(runtime, model, context, options) { return runtime.stream(options.request); }",
        }));
      },
    }] });
    process.argv = ["node", "pi", "--system-prompt", "ROLE_ONLY", "--append-system-prompt", "HANDOFF_AND_SCHEMA"];
    process.env.PI_SUBAGENT = "1";
    process.env.PI_TASK_PROMPT_CONTRACT = "1";
    let provider: any;
    const { default: install } = await import(pathToFileURL(outfile).href);
    await install({ registerProvider(_name: string, config: unknown) { provider = config; },
      events: { on() { return () => {}; } }, on(name: string, handler: Function) { handlers.set(name, handler); },
    });
    const tool = { name: "read", description: "Read exact evidence", parameters: { type: "object" } };
    const result = provider.streamSimple({}, normalizeContext({ messages: [] }), { request: {
      model: "test", sessionId: "worker", tools: [tool], system: "PAYLOAD_SYSTEM",
      messages: [{ role: "system", content: [{ type: "text", text: "PAYLOAD_MESSAGE" }] }, user("unit", "WORK_ORDER")],
    } });
    checkpointDir = directory(result);
    assert.match(result.system, /ROLE_ONLY\n\nHANDOFF_AND_SCHEMA/);
    assert.doesNotMatch(result.system, /PAYLOAD_SYSTEM|PAYLOAD_MESSAGE/);
    assert.deepEqual(result.tools, [tool]);
    assert.deepEqual(result.messages, [user("unit", "WORK_ORDER")]);
  } finally {
    await handlers.get("session_shutdown")?.();
    process.argv = oldArgv;
    if (oldSubagent === undefined) delete process.env.PI_SUBAGENT; else process.env.PI_SUBAGENT = oldSubagent;
    if (oldContract === undefined) delete process.env.PI_TASK_PROMPT_CONTRACT; else process.env.PI_TASK_PROMPT_CONTRACT = oldContract;
    if (checkpointDir) rmSync(checkpointDir, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
  }
});
