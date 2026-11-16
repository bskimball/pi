import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { normalizeContext } from "@earendil-works/pi-ai";
import { ReplayCheckpoints } from "../antigravity-native/context.ts";
import type { GenerateOptions, RequestMessage } from "../antigravity-native/node_modules/pi-agy-acp/src/protocol.ts";

const user = (id: string, text: string): RequestMessage => ({ id, role: "user", content: [{ type: "text", text }] });
function directory(request: GenerateOptions): string {
  const file = JSON.parse(request.system!.match(/Recovery checkpoint: ("[^\n]+?")\./)![1]);
  const dir = dirname(file);
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + "/") || resolve(dir).startsWith(resolve(tmpdir()) + "\\"));
  assert.ok(dir.includes("pi-agy-checkpoint-"));
  return dir;
}

test("checkpoints preserve system instructions and updates without changing their message order", () => {
  const checkpoints = new ReplayCheckpoints();
  const messages: RequestMessage[] = [
    { role: "system", content: [{ type: "text", text: "ROLE_AND_PROFILE" }] },
    user("task", "WORK_ORDER"),
    { role: "system", content: [{ type: "text", text: "UPDATED_MODE" }] },
  ];
  const request = checkpoints.prepare({ model: "test", messages, system: "PAYLOAD_SYSTEM" });
  try {
    assert.equal(request.messages, messages);
    assert.match(request.system!, /PAYLOAD_SYSTEM/);
    assert.match(readFileSync(join(directory(request), "history.json"), "utf8"), /UPDATED_MODE/);
  } finally { rmSync(directory(request), { recursive: true, force: true }); }
});

test("checkpoint stays stable across tool continuations and preserves images without private reasoning", () => {
  const checkpoints = new ReplayCheckpoints();
  const initial: GenerateOptions = { model: "test", sessionId: "lead", system: "MODE", messages: [user("u1", "Do not edit production")] };
  const first = checkpoints.prepare(initial);
  const dir = directory(first);
  const pixels = Buffer.from("offline image bytes");
  try {
    const next = checkpoints.prepare({ ...initial, messages: [...initial.messages,
      { id: "a1", role: "assistant", source: { kind: "model", provider: "test" }, content: [
        { type: "reasoning", text: "PRIVATE_REASONING" },
        { type: "tool-call", id: "call", name: "read", arguments: "{}" },
      ] },
      { id: "t1", role: "tool", toolCallId: "call", content: [{ type: "text", text: "DECISIVE_EVIDENCE" }, { type: "image", data: pixels.toString("base64"), mimeType: "image/png" }] },
    ] });
    assert.equal(next.system, first.system);
    const history = readFileSync(join(dir, "history.json"), "utf8");
    assert.match(history, /DECISIVE_EVIDENCE/);
    assert.doesNotMatch(history, /PRIVATE_REASONING/);
    const image = JSON.parse(history)[2].content[1];
    assert.equal(image.type, "image-file");
    assert.equal(dirname(image.path), dir);
    assert.deepEqual(readFileSync(image.path), pixels);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compaction retains original task, explicit handoff and pre-reset evidence; worker forks pin the new work order", () => {
  const checkpoints = new ReplayCheckpoints(true);
  const initial: GenerateOptions = { model: "test", sessionId: "worker", system: "WORKER", messages: [user("parent", "Unrelated parent task"), user("unit", "Owned path src/a.ts")] };
  const first = checkpoints.prepare(initial);
  const dir = directory(first);
  try {
    assert.match(first.system!, /Owned path src\/a.ts/);
    assert.doesNotMatch(first.system!, /Unrelated parent task/);
    checkpoints.prepare({ ...initial, messages: [...initial.messages, {
      id: "a1", role: "assistant", source: { kind: "model", provider: "test" },
      content: [{ type: "text", text: '```handoff\n{"findings":"Do not retry migration"}\n```' }],
    }] });
    checkpoints.reset();
    const compacted = checkpoints.prepare({ ...initial, messages: [user("summary", "Compaction summary: validation pending")] });
    assert.equal(compacted.system, first.system);
    assert.match(readFileSync(join(dir, "history-1.json"), "utf8"), /Do not retry migration/);
    const checkpoint = readFileSync(join(dir, "checkpoint.md"), "utf8");
    assert.match(checkpoint, /Do not retry migration/);
    assert.match(checkpoint, /validation pending/);
    assert.equal(readFileSync(join(dir, "task.txt"), "utf8"), "Owned path src/a.ts");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pinned ACP replay remains bounded while large omitted results are fully recoverable by line", async () => {
  const bundleDir = mkdtempSync(join(tmpdir(), "pi-agy-replay-test-"));
  const checkpoints = new ReplayCheckpoints();
  const evidence = "x".repeat(180_000) + "DECISIVE_TAIL";
  const request = checkpoints.prepare({ model: "test", sessionId: "large", system: "MODE", messages: [
    user("original", "MUST_PRESERVE_CONSTRAINT"),
    { id: "large-result", role: "tool", toolCallId: "call", content: [{ type: "text", text: evidence }] },
    user("next", "Continue validation"),
  ] });
  const dir = directory(request);
  try {
    const outfile = join(bundleDir, "history.mjs");
    await build({ entryPoints: ["agent/extensions/antigravity-native/node_modules/pi-agy-acp/src/history.ts"], outfile, bundle: true, platform: "node", format: "esm" });
    const { replayPrompt } = await import(pathToFileURL(outfile).href);
    const replay = JSON.stringify(replayPrompt(request.messages.slice(0, -1), request.messages.slice(-1)));
    assert.match(replay, /omitted|truncated/);
    assert.doesNotMatch(replay, /MUST_PRESERVE_CONSTRAINT/);
    assert.match(request.system!, /MUST_PRESERVE_CONSTRAINT/);
    const history = readFileSync(join(dir, "history.json"), "utf8");
    assert.equal(JSON.parse(history)[1].content[0].text.chunks.join(""), evidence);
    assert.ok(history.split("\n").every(line => Buffer.byteLength(line) < 16_000));
    assert.match(history, /DECISIVE_TAIL/);
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
  }] });
  const second = checkpoints.prepare({ model: "test", sessionId: "second", messages: [user("two", "SECOND_TASK")] });
  const firstDir = directory(first), secondDir = directory(second);
  try {
    assert.notEqual(firstDir, secondDir);
    assert.doesNotMatch(second.system!, /FIRST_TASK/);
    assert.doesNotMatch(readFileSync(join(secondDir, "checkpoint.md"), "utf8"), /ABANDONED_DECISION/);
    checkpoints.reset(false);
    checkpoints.prepare({ model: "test", sessionId: "first", messages: [user("one", "FIRST_TASK"), user("branch", "Different approach")] });
    assert.doesNotMatch(readFileSync(join(firstDir, "checkpoint.md"), "utf8"), /ABANDONED_DECISION/);
  } finally {
    rmSync(firstDir, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
});

test("registered provider uses actual Pi projection for full instructions, tools, updates and payload hooks", async () => {
  const bundleDir = mkdtempSync(join(tmpdir(), "pi-agy-provider-test-"));
  const captureKey = Symbol.for("pi-agy-context-test");
  const captures: GenerateOptions[] = [];
  (globalThis as any)[captureKey] = captures;
  const handlers = new Map<string, Function>();
  try {
    const outfile = join(bundleDir, "provider.mjs");
    await build({ entryPoints: ["agent/extensions/antigravity-native/index.ts"], outfile, bundle: true, platform: "node", format: "esm", plugins: [{
      name: "offline-runtime", setup(builder) {
        builder.onResolve({ filter: /^@earendil-works\// }, args => ({ path: import.meta.resolve(args.path), external: true }));
        builder.onResolve({ filter: /^pi-agy-acp\/src\/(runtime|host)\.ts$/ }, args => ({ path: args.path, namespace: "offline" }));
        builder.onLoad({ filter: /.*/, namespace: "offline" }, args => ({ contents:
          args.path.endsWith("runtime.ts") ? `export class AntigravityRuntime {
            catalog = { list: () => [] }; async warmup() {} async dispose() {}
            resetConversations() {} settleSession() {}
            async *stream(request) {
              globalThis[Symbol.for("pi-agy-context-test")].push(request);
              yield { type: "finish", reason: { kind: "stop" } };
            }
          }` : "export function runCommand() { throw Error('Unexpected CLI invocation'); }",
        }));
      },
    }] });
    let provider: any;
    const { default: install } = await import(pathToFileURL(outfile).href);
    await install({ registerProvider(_name: string, config: unknown) { provider = config; },
      on(name: string, handler: Function) { handlers.set(name, handler); },
    });
    const tool = { name: "read", description: "Read exact evidence", parameters: { type: "object" as const } };
    const context = normalizeContext({ messages: [
      { role: "system", content: "BASE_ROLE", sections: { preamble: "BASE_ROLE", memory: "MEMORY", profile: "PROFILE", skills: "SKILLS", context: "AGENTS", mode: "WORKER_HANDOFF_SCHEMA" }, toolsAdded: [tool], timestamp: 0 },
      { role: "user", content: "WORK_ORDER", timestamp: 1 },
      { role: "system", content: "", sections: { mode: "UPDATED_MODE" }, timestamp: 2 },
    ] });
    const model = { id: "test", api: "antigravity-native-acp", provider: "antigravity", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    for (const onPayload of [undefined, (request: GenerateOptions) => ({ ...request, system: "PAYLOAD_SYSTEM" })]) {
      const stream = provider.streamSimple(model, context, { sessionId: "worker", onPayload });
      for await (const _event of stream) { /* Drain the actual translator. */ }
      const result = await stream.result();
      assert.notEqual(result.stopReason, "error", result.errorMessage);
    }
    assert.equal(captures.length, 2);
    const result = captures[0];
    const text = JSON.stringify(result.messages);
    for (const marker of ["BASE_ROLE", "MEMORY", "PROFILE", "SKILLS", "AGENTS", "WORKER_HANDOFF_SCHEMA", "UPDATED_MODE", "WORK_ORDER"]) assert.ok(text.includes(marker), marker);
    assert.deepEqual(result.tools, [tool]);
    assert.deepEqual(result.messages.map(message => message.role), ["system", "user", "system"]);
    assert.match(captures[1].system!, /PAYLOAD_SYSTEM/);
    assert.match(captures[1].system!, /Conversation recovery/);
  } finally {
    await handlers.get("session_shutdown")?.();
    for (const dir of new Set(captures.map(directory))) rmSync(dir, { recursive: true, force: true });
    delete (globalThis as any)[captureKey];
    rmSync(bundleDir, { recursive: true, force: true });
  }
});
