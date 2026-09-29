---
name: mcp-scripting-recipes
description: Native Pi codemode recipes for MCP tool discovery, bounded fan-out, partial failures, and timeout budgeting. Use when composing multiple MCP calls or filtering large tool results.
---

# Native MCP scripting recipes

Use Pi's built-in `codemode` for chains, loops, parallel calls, and result filtering. Native MCP configuration is `~/.pi/agent/mcp.json`; servers default to `codemode` exposure. For the authoritative contract, read the installed `node_modules/@earendil-works/pi-coding-agent/docs/cli.md` section "How codemode works" and `docs/mcp.md` in that package.

## Discover, inspect, call

1. Find candidates with `await searchTools(query, { limit, namespace })` or filter `ALL_TOOLS`. Both return metadata with `name` and `description`; namespace is optional.
2. Inspect an exact returned name with `await describeTool(name)`. It returns the description and declaration, or `undefined`.
3. Supply arguments from that declaration to `await tools[name](args)`. Native names have the form `mcp__<server>__<tool>` but may be sanitized or shortened; use the discovered name.
4. Validate the result shape before filtering or acting on it. Return useful output with `text(value)` or a top-level `return`.

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
const candidates = await searchTools("find the intended capability", { limit: 5 });
const candidate = candidates[0];
if (!candidate) return { error: "No matching tool" };
const declaration = await describeTool(candidate.name);
if (!declaration) return { error: "Tool unavailable", name: candidate.name };
text({ name: candidate.name, declaration });
// Inspect this output first, then call tools[theExactName] with the declared arguments.
```

## Results and failures

- MCP calls resolve to the full `CallToolResult`: `content`, optional `structuredContent`, and optional `isError`. A server result with `isError` resolves; check it explicitly.
- Invalid arguments, blocked calls, and pipeline failures reject with an Error. Use `try/catch` or `Promise.allSettled`; there is no `{ ok, data }` wrapper.
- Prefer validated `structuredContent` for domain fields. Otherwise inspect the text blocks in `content`. Return an unfamiliar result for inspection instead of coercing it into an empty array or object.
- `image(result.content[i])` forwards an individual MCP image block to the model.

## Bounded fan-out

Use only exact names and arguments already inspected. Limit the work list and concurrency; collect each failure without retrying a possibly completed action.

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
const work = [/* { name: exactDiscoveredName, args: inspectedArguments } */];
const outcomes = [];
let next = 0;
async function worker() {
  while (next < work.length) {
    const item = work[next++];
    try {
      const result = await tools[item.name](item.args);
      outcomes.push({ name: item.name, ok: result.isError !== true, result });
    } catch (error) {
      outcomes.push({ name: item.name, ok: false, error: String(error) });
    }
  }
}
await Promise.all(Array.from({ length: Math.min(3, work.length) }, () => worker()));
return outcomes;
```

## Execution boundaries

Codemode runs in a fresh QuickJS sandbox with no Node, direct filesystem, network, or timer access. It can execute enabled tools through `tools`, including tools with side effects. Each nested call follows Pi's tool pipeline and permission hooks. Failure does not undo earlier calls; await all intended work before returning.

Put credentials in configuration/environment resolution, not script source or output. Use an explicit first-line `// @options` deadline: `timeout_ms` has no default. `max_output_tokens` defaults to 10000; longer output is truncated and saved to a temporary file. Scripts have a 256 MB memory limit, so bound inputs, concurrency, and retained results rather than accumulating entire datasets. Keep observations fresh and stop on uncertainty, no progress, or an unrecognized result.

Use `/mcp` or `pi mcp list` for server status, and `/mcp login <server>` or `pi mcp login <server>` for user-approved OAuth. `tool_search` can load deferred tools for direct model calls; codemode's `searchTools` discovers tools without that declaration step.
