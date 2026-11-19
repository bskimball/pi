# Antigravity native ACP provider

Registers `agy-acp` through the installed official `agy` CLI using the pinned `pi-agy-acp@0.2.0` runtime and Pi stream translator. Install dependencies with `npm ci --legacy-peer-deps --ignore-scripts` in this directory; Pi host packages are not installed as local peers. Sign in with `agy` if needed, then restart Pi and choose `agy-acp/gemini-4-neon`.

## Instructions and modes

The adapter forwards Pi's normalized transcript through the pinned runtime's native Pi translator. Leading system messages become ACP system instructions; later system updates retain their position in history. Named sections carry the active base prompt, mode, memory, profile, skills, and context-file instructions. Tool declarations and tool results use the same translator. No separate mode-event allowlist or CLI-argument prompt reconstruction is needed.

Task children receive the effective prompt Pi rendered for that child, including specialist role, shared constraints, handoff instructions, and report schema. Forked workers still require a self-contained work order. The normal Pi `onPayload` hook remains effective; recovery instructions are appended after it rather than replacing its system content. Raw legacy fields are not a second prompt source: Pi must normalize them into its transcript.

The pinned runtime rebuilds sessions when the system digest or history prefix changes and reattaches leading system instructions after resets. Later in-history system updates share the replay budget: an older update can be omitted from inline replay and then requires checkpoint recovery, even though the initial system instructions remain attached. Instruction delivery and checkpoint recovery do not guarantee model obedience; Pi's tool execution policies still apply.

## Replay recovery and context cost

ACP retains live conversation state and normally consumes incremental input. Its pinned runtime limits text replay after a rebuild to 160,000 bytes; older messages and historical image pixels may be absent. The adapter adds a stable recovery instruction and a bounded original-request excerpt, plus paths to OS-temp recovery files. Instructions remain unchanged as tool results arrive, preserving ACP's system-digest reuse.

`checkpoint.md` contains the latest user input excerpt, a bounded recent user/assistant conversation digest (so lead sessions without explicit worker handoffs can recover without shelling out to parse `history.json`), and the latest explicit worker-authored handoff, with links to complete evidence. `task.txt` preserves the original request (the new work order for a forked worker). `history.json` retains current system/text/tool evidence; pre-compaction and replaced-prefix snapshots are retained separately. Long string values use `{ "chunks": [...] }`, reconstructed by concatenating without separators, so bounded line-based reads can reach even the end of a large tool result. Image entries link content-addressed local files containing the original pixels; reasoning blocks are excluded. Prior snapshots are historical evidence, not authority over current instructions. A branch switch clears the cached handoff. When ACP announces replay omissions, the model is instructed to read this checkpoint before acting and report unresolved gaps in its handoff; when a long-running tool triggers an ACP relay notice, the model is instructed to call `mcp_pi_pi_await_result` with that exact `call_id` before ending its turn. Recovery is available on disk; model compliance is not mechanically guaranteed. The 160,000-byte replay cap remains necessary for the CLI's single-input limit.

Recovery files are created lazily on inference, never during catalog discovery. They remain in `pi-agy-checkpoint-*` directories under OS temp after worker shutdown so the parent can inspect them, like task report files, and stale directories older than 24 hours are pruned automatically on first checkpoint creation. They contain transcript instructions, text, and images, which may be sensitive; remove them sooner when no longer needed. No authentication files are copied.

Task role tool lists also restrict context: fixed lists without MCP names or discovery tools exclude unrelated MCP schemas. Explicit MCP lists, `codemode`/`tool_search` roles, wildcard lists, and unrestricted sidekicks retain their intended discovery behavior. The upstream MCP schema compactor still retains full instructions for oversized tools; the adapter does not remove schema constraints or arbitrary tool prose.

## Reasoning effort

Omitted reasoning (including Pi's `off` selection) falls back to `medium`, not the upstream runtime's `high` default. This is a fallback effort, not a promise of zero reasoning: the runtime selects the nearest effort the model offers, and fixed-effort model IDs retain their built-in level. Explicit `low`, `medium`, and `high` selections remain unchanged; the translator maps `minimal` to `low` and `xhigh`/`max` to `high`. Payload-hook effort overrides remain effective. The model picker still advertises only levels the CLI actually supports.

## Execution and authentication

The dedicated child runs `agy acp --dangerously-skip-permissions`, explicitly authorized by the user. This automatically approves the CLI's tool-permission requests. Upstream's minimal `pi-bridge` agent declares `tools: []` and `excludeDefaultComponents: true`; native filesystem and shell tools are disabled. The authenticated local MCP bridge exposes Pi tools, returns their calls to Pi, and resumes with Pi's results. The adapter does not enable unrestricted native shell execution.

This is a minimal bridge agent, not the complete default Antigravity agent. Bridge-owned tool and history instructions remain. The official CLI owns remote authentication and inference. The dependency may copy an existing CLI credential file into its isolated home during normal setup; this adapter does not read token contents, spoof a client header, or call the remote model API directly.

Each runtime has a unique OS-temp home. Startup and sessionless model refresh use a temporary runtime that is disposed before returning; inference creates its long-lived runtime lazily. Discovery obtains current CLI model IDs, including Carbon and Hydrogen. Shutdown disposes sessions and MCP, stops the owned Windows process tree, and removes the temporary home only after successful child shutdown. A failed tree stop or unexpected front exit retains the home and reports an error. Hard termination of Pi can leave a temporary home behind.

## Verification

Offline regression coverage: `node --experimental-transform-types --test agent/extensions/test/antigravity-context.test.ts agent/extensions/task/runtime/test/child-process.test.ts`. This exercises the registered provider through the actual pinned Pi translator with a mocked inference runtime, the pinned ACP replay formatter, prompt sections and updates, payload hooks, stable continuation instructions, forked worker work orders, chunked text and image recovery, compaction, role-scoped MCP tools, medium default effort, and preservation of explicit reasoning levels and payload overrides.

An isolated live Hydrogen smoke check passed after the rollback-readiness changes: custom and appended system-prompt markers both reached ACP, a real Pi `read` call completed, and the continuation returned the file's dependency version plus both markers. It used an ephemeral session and a process-local `local-agy` key override, without changing the active direct-API provider or stored OAuth. Large-history reset recovery and archived-image retrieval are covered offline, not live. Earlier live checks also covered Carbon, selected mode guidance, and Windows process-tree shutdown.

The native adapter registers `agy-acp/*` as the active Antigravity chat provider; the legacy `npm:pi-antigravity` package is disabled in `agent/settings.json`. Its `local-agy` marker is not a credential: the CLI owns Google authentication. No Pi OAuth migration or `ANTIGRAVITY_USER_AGENT` override is needed.
