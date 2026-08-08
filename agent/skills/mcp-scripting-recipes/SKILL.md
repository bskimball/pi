---
name: mcp-scripting-recipes
description: Local mcpScript patterns for discovery-first resolution, bounded fan-out, partial failures, and timeout budgeting. Read the authoritative mcp-scripting skill first for the API contract; use this skill for safe, server-agnostic composition recipes.
---

# mcpScript recipes

Read `mcp-scripting` first for the adapter's authoritative API. These recipes are local, server-agnostic patterns only. Never hardcode current MCP tool paths or server-specific argument shapes.

## Security boundaries

- `mcpScript` runs trusted agent-authored JavaScript. It is not a sandbox for untrusted code.
- Isolation stops runaway loops from freezing the main process; it does not protect against malicious scripts.
- `tools.call` preserves normal connection, authentication, approval, and per-call output controls. Final emitted/returned script output is separately output-guarded. `tools.search` and `tools.describe` inspect local adapter metadata and do not call a server.
- Never inline secrets in script source. Credentials stay in MCP config / environment resolution.
- Apex may hide script source from the call header summary only; the full source still exists in the model/tool transcript.

## Contracts to remember

- `tools.search` and `tools.describe` resolve bare results (not `{ok,...}` envelopes).
- `tools.call` returns `{ ok: true, data }` or `{ ok: false, error }`.
- Use `emit()` for useful intermediate/final user-visible output.
- Result `details.calls` is on the `mcpScript` tool result outside the script, not inside individual `tools.call` returns.

## 1. Resolve → describe → call

Handle empty search, describe failures, and call envelopes explicitly.

```js
const { items } = await tools.search({ query: "find the intended capability" });
const candidate = items[0];
if (!candidate) {
  emit({ error: "No matching tool" });
  return { error: "No matching tool" };
}

const details = await tools.describe({ path: candidate.path });
if (details.error) {
  emit({ error: "describe failed", path: candidate.path, details });
  return details;
}

const result = await tools.call(details.path, {/* args from schema */});
if (!result.ok) {
  emit({ error: result.error, path: details.path });
  return result;
}

emit({ path: details.path, completed: true });
return result.data;
```

## 2. Bounded fan-out with partial failures

Cap concurrency without external dependencies. Partition successes and errors.

```js
const paths = [/* exact paths from prior search/describe */];
const argsByPath = new Map(/* path -> args */);
const concurrency = 3;
const successes = [];
const errors = [];
let next = 0;

async function worker() {
  while (next < paths.length) {
    const i = next++;
    const path = paths[i];
    try {
      const result = await tools.call(path, argsByPath.get(path) ?? {});
      if (result.ok) successes.push({ path, data: result.data });
      else errors.push({ path, error: result.error });
    } catch (error) {
      errors.push({ path, error: String(error) });
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(concurrency, paths.length) }, () => worker()),
);

emit({ total: paths.length, ok: successes.length, failed: errors.length });
return { successes, errors };
```

## 3. Timeout budgeting

Cap the work list, set `timeoutMs` on the `mcpScript` tool call (outside the script), and inspect `details.calls` on the returned tool result after the run to tune future budgets. Do not expect `details` inside `tools.call` results.

```js
// mcpScript tool args (outside the script):
// { timeoutMs: 20000, code: "<source below>" }

const { items } = await tools.search({ query: "capability keywords", limit: 5 });
const selected = items.slice(0, 3); // hard cap: never unbounded fan-out
const outcomes = [];

for (const item of selected) {
  const details = await tools.describe({ path: item.path });
  if (details.error) {
    outcomes.push({ path: item.path, stage: "describe", error: details.error });
    continue;
  }
  const result = await tools.call(details.path, {/* minimal args */});
  outcomes.push(
    result.ok
      ? { path: details.path, stage: "call", ok: true }
      : { path: details.path, stage: "call", ok: false, error: result.error },
  );
}

emit({ attempted: selected.length, outcomes });
return outcomes;

// After mcpScript returns, inspect tool-result details.calls (search/describe/call
// query or path, outcome, duration) to tighten timeoutMs and caps next time.
```
