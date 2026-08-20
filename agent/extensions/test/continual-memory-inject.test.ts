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

function loadHandlers(): Record<string, (...args: unknown[]) => unknown> {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  continualMemory({
    on(name: string, fn: (...args: unknown[]) => unknown) {
      handlers[name] = fn;
    },
    registerTool() {},
    appendEntry() {},
  } as never);
  return handlers;
}

function loadBeforeAgentStart(): (event: { systemPrompt: string }) => Promise<unknown> {
  const handler = loadHandlers().before_agent_start;
  assert.ok(handler, "expected before_agent_start handler");
  return handler as (event: { systemPrompt: string }) => Promise<unknown>;
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

test("continual memory injects the compact reminder once", async () => {
  await withPiSubagent(undefined, async () => {
    const handlers = loadHandlers();
    assert.ok(handlers.session_compact, "expected session_compact handler");
    assert.ok(handlers.before_agent_start, "expected before_agent_start handler");
    handlers.session_compact({});
    const first = await handlers.before_agent_start({ systemPrompt: "base" }) as {
      systemPrompt: string;
    };
    assert.match(first.systemPrompt, /offer memory_write — do not auto-write/);
    const second = await handlers.before_agent_start({ systemPrompt: "base" }) as {
      systemPrompt: string;
    };
    assert.doesNotMatch(second.systemPrompt, /offer memory_write — do not auto-write/);
  });
});

test("continual memory never injects the compact reminder for subagents", async () => {
  await withPiSubagent("1", async () => {
    const handlers = loadHandlers();
    handlers.session_compact?.({});
    const result = await handlers.before_agent_start?.({ systemPrompt: "base" });
    assert.equal(result, undefined);
  });
});
