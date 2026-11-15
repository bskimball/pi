# Antigravity native ACP provider

Registers `antigravity` through the installed official `agy` CLI (verified with 1.5.9). The adapter uses the pinned `pi-agy-acp@0.1.3` runtime and Pi stream translator. Install dependencies with `npm install --legacy-peer-deps --ignore-scripts` in this directory; Pi host packages are not installed as local peers.

## Instructions and modes

The full Pi system prompt is **not forwarded**. System-message text, named sections, and legacy `systemPrompt` / `systemPromptOptions` fields are discarded. System-injected memory, profile, skills, and context-file instructions are therefore not automatically delivered. User messages, assistant history, tool results, tool descriptions, and tool declarations remain available.

Task children explicitly opt into `PI_TASK_PROMPT_CONTRACT=1` alongside `PI_SUBAGENT=1`. For these children only, the adapter forwards the task runner's CLI `--system-prompt` and `--append-system-prompt` values: specialist role, shared constraints, handoff instructions, and requested report schema. It does not capture the rendered lead prompt or later memory/profile injections. Payload hooks cannot replace this contract. Sync, async, and reused sidekick workers share this behavior; a new unit still needs a self-contained work order.

The mode extension publishes the authoritative active card on `pi:modes:guidance`. Only Apex, Apex Orchestrate, and Fusion cards are appended through ACP's system-instruction support. Fusion includes its lead preface. Other modes clear this guidance. The adapter does not import another extension's source or duplicate its cards. The pinned runtime rebuilds the ACP session when the instruction digest changes and reattaches instructions after session resets. Full Pi prompt fields supplied by payload hooks are discarded again at the runtime boundary.

These cards guide behavior; they do not guarantee model obedience or restore omitted base-prompt rules. Mode references to general safety, completion, and verification instructions do not supply the omitted base prompt. Explicit user requests and Pi's tool execution policies still apply.

## Replay recovery and context cost

ACP retains live conversation state and normally consumes incremental input. Its pinned runtime limits text replay after a rebuild to 160,000 bytes; older messages and historical image pixels may be absent. The adapter adds a stable recovery instruction and a bounded original-request excerpt, plus paths to OS-temp recovery files. Instructions remain unchanged as tool results arrive, preserving ACP's system-digest reuse.

`checkpoint.md` contains the latest user input excerpt and latest explicit worker-authored handoff, with links to complete text. `task.txt` preserves the original request (the new work order for a forked worker). `history.jsonl` retains current text/tool evidence; pre-compaction and replaced-prefix snapshots are retained separately. Historical images are placeholders and reasoning blocks are excluded. Prior snapshots are historical evidence, not authority over current instructions. A branch switch clears the cached handoff. When ACP announces replay omissions, the model is instructed to read this checkpoint before acting and report unresolved gaps in its handoff. Recovery is available on disk; model compliance is not mechanically guaranteed.

Recovery files are created lazily on inference, never during catalog discovery. They remain in `pi-agy-checkpoint-*` directories under OS temp after worker shutdown so the parent can inspect them, like task report files. They are local transcript artifacts and can be removed when no longer needed. No authentication files are included.

Task role tool lists also restrict context: fixed lists without MCP names or discovery tools exclude unrelated MCP schemas. Explicit MCP lists, `codemode`/`tool_search` roles, wildcard lists, and unrestricted sidekicks retain their intended discovery behavior. The upstream MCP schema compactor still retains full instructions for oversized tools; the adapter does not remove schema constraints or arbitrary tool prose.

## Execution and authentication

The dedicated child runs `agy acp --dangerously-skip-permissions`, explicitly authorized by the user. This automatically approves the CLI's tool-permission requests. Upstream's minimal `pi-bridge` agent declares `tools: []` and `excludeDefaultComponents: true`; native filesystem and shell tools are disabled. The authenticated local MCP bridge exposes Pi tools, returns their calls to Pi, and resumes with Pi's results. The adapter does not enable unrestricted native shell execution.

This is a minimal bridge agent, not the complete default Antigravity agent. Bridge-owned tool and history instructions remain. The official CLI owns remote authentication and inference. The dependency may copy an existing CLI credential file into its isolated home during normal setup; this adapter does not read token contents, spoof a client header, or call the remote model API directly.

Each runtime has a unique OS-temp home. Startup and sessionless model refresh use a temporary runtime that is disposed before returning; inference creates its long-lived runtime lazily. Discovery obtains current CLI model IDs, including Carbon and Hydrogen. Shutdown disposes sessions and MCP, stops the owned Windows process tree, and removes the temporary home only after successful child shutdown. A failed tree stop or unexpected front exit retains the home and reports an error. Hard termination of Pi can leave a temporary home behind.

## Verification

Offline regression coverage: `node --experimental-transform-types --test agent/extensions/test/antigravity-context.test.ts agent/extensions/task/runtime/test/child-process.test.ts`. This exercises the registered provider with a mocked inference runtime, the actual pinned ACP replay formatter, stable continuation instructions, forked worker work orders, compaction recovery, and role-scoped MCP tools. The context-recovery changes have not been live-inference tested.

Live checks passed for Carbon text generation, a real Pi `read` call and matching result continuation, omission of sentinel system fields, Fusion sidekick-versus-lead guidance, Apex inline-first guidance, and both cards after a conversation reset. These are bounded smoke checks, not a statistical guarantee of delegation behavior. Windows ACP process-tree shutdown was also checked during the implementation.

The same-ID migration preserves the previous stored OAuth entry as `antigravity-legacy-oauth-inactive` in Pi's credential store and configures `antigravity` with a non-secret `local-agy` API-key marker. Pi's stored credentials take precedence over ambient provider configuration, so the old OAuth entry cannot remain under the active ID. Actual Google authentication remains with the CLI. Restart existing Pi sessions after migration; do not use the disabled direct-API provider with the local marker.

The provider replaces chat inference only. It does not reimplement the old package's `google_search`, `generate_image`, OAuth commands, or image-generation models. Use the model picker after reloading/restarting Pi. Existing provider IDs remain `antigravity/*`; available models come from the installed CLI.
