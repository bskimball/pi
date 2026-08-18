import assert from "node:assert/strict";
import test from "node:test";
import continualMemory from "../continual-memory.ts";

function withPiSubagent<T>(value: string | undefined, run: () => Promise<T> | T): Promise<T> | T {
  const prev = process.env.PI_SUBAGENT;
  if (value === undefined) delete process.env.PI_SUBAGENT;
  else process.env.PI_SUBAGENT = value;
  const restore = () => {
    if (prev === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = prev;
  };
  try {
    const result = run();
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function loadBeforeAgentStart(): (event: { systemPrompt: string }) => Promise<unknown> {
  let handler: ((event: { systemPrompt: string }) => Promise<unknown>) | undefined;
  continualMemory({
    on(name: string, fn: (event: { systemPrompt: string }) => Promise<unknown>) {
      if (name === "before_agent_start") handler = fn;
    },
    registerTool() {},
    appendEntry() {},
  } as never);
  assert.ok(handler, "expected before_agent_start handler");
  return handler;
}

test("continual memory skips overview injection for subagents", async () => {
  await withPiSubagent("1", async () => {
    const handler = loadBeforeAgentStart();
    const result = await handler({ systemPrompt: "base" });
    assert.equal(result, undefined);
  });
});

test("continual memory injects overview when not a subagent", async () => {
  await withPiSubagent(undefined, async () => {
    const handler = loadBeforeAgentStart();
    const result = await handler({ systemPrompt: "base" });
    assert.ok(result && typeof result === "object");
    const prompt = (result as { systemPrompt: string }).systemPrompt;
    assert.match(prompt, /^base\n\n/);
    assert.ok(prompt.length > "base\n\n".length);
  });
});
