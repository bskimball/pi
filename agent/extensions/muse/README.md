# Muse

Config-owned Pi provider `muse-code` that runs prompts through the local Muse CLI under the user's Muse subscription. It replaces `npm:pi-muse-bridge`, which is removed from Pi's package configuration. Restart or reload Pi after changing that configuration.

## Requirements

- Muse CLI already installed; context controls are live-verified on 1.4.20. The extension does not install anything or check the version. Unsupported CLI settings fail the request rather than silently restoring expensive native context.
- A native browser/subscription login completed in the Muse CLI. Pi never reads Muse auth files.
- Muse's model catalog at `$XDG_DATA_HOME/muse/model-catalog/*.json` (default `~/.local/share/muse/model-catalog`). Run Muse Code once to refresh it. Startup fails if the catalog has no default chat model.
- Binary lookup: `PI_MUSE_BINARY` if set; otherwise `muse` on non-Windows; on Windows, `%LOCALAPPDATA%\Programs\muse\muse-bin-<version>.exe` using `.muse-version`. On Windows, an override naming a missing versioned executable in that default install directory (left by an older extension, then removed by a Muse update) resolves to the current `.muse-version`. Any other explicit override keeps priority.

## Authentication

Login is the CLI's subscription login. There is no API fallback and no remote API adapter. `META_API_KEY` (any casing) is stripped from the child environment. A key already stored in the CLI's own credentials is not inspected, so which credential the CLI picks is the user's responsibility.

## Models

Every catalog model is exposed as `muse-code/<model_id>`, so existing `muse-code/*` IDs keep working. `muse-code/muse-spark` is an alias for the catalog default. Image-generation models (`muse-image-*`) are skipped. Models advertise text and image input, reasoning, and zero cost (subscription billing).

Contributor mode is pinned per run to the selected ID: `--contributor-mode on` for IDs ending in `-contributor`, `off` otherwise. The backend serves a contributor twin only for some models; leaving the mode to the ambient CLI setting rewrites a plain ID such as `muse-ember-1.0` to a nonexistent `muse-ember-1.0-contributor` and the request fails with `does not exist or you lack access`.

## How a turn works

The adapter is stateless. Each Pi model turn starts a fresh `muse exec --preset empty` process with `--output-schema` set to an envelope `{ text, tool_calls: [{ name, arguments_json }] }`. The prompt carries the full Pi transcript, the current system prompt, and the current tool definitions.

Before submission, Pi's `onPayload` callback receives `{ prompt, images, tools }`. It may mutate or replace that payload, or reject to prevent the CLI call.

1. Muse returns the envelope. The adapter validates its shape and arguments; unknown tool names reach Pi's normal tool-not-found handling.
2. Pi executes the tools itself.
3. The next request resends the whole transcript, including the full tool results.

Pi system instructions travel as labeled prompt content (`PI SYSTEM INSTRUCTIONS`). A short native `run.system_prompt` override tells Muse to follow that context, replacing its large default coding-agent prompt. Every call passes `--yolo` to skip Muse approval and sandbox permissions, without `--disable-shell` or `--disable-write` restrictions that can cause the model to refuse Pi tool requests. This does not change Pi's own permissions. The empty preset keeps Muse's native tools out of the turn; Pi executes the returned tool calls. Web tools and reminders remain disabled. The CLI uses its default model-step budget and runs with `--no-session-log`. Do not cap it at one model step: producing a terminal structured envelope can require additional internal steps, even though Pi owns tool execution.

## Context and skills

Pi remains the source of system instructions, project context, skill descriptions and paths, tools, and compacted conversation history. Skill bodies are loaded on demand through Pi's `read` tool, not eagerly copied into every prompt. Existing projection drops renderer details, usage metadata, private reasoning, and aborted assistant output without truncating successful tool results.

Muse runs in an empty temporary workspace so it does not load the project rules a second time. Before each request, the adapter lists Muse's native skills locally and disables their user, bundled, and plugin entries with per-run settings. This does not disable Pi's skills or modify Muse's saved settings. Native context-usage messages and identity/meta notes are disabled as well. No credential copies, symlinks, elevated process, or Windows Developer Mode are required.

## Behavior and limits

- Responses are buffered until the terminal structured envelope is validated. Output is not token-incremental; text and tool calls arrive at once.
- Every Pi model turn pays CLI process startup plus a full-transcript prompt, so latency is higher than a native provider.
- Reasoning content is not exposed. Pi's reasoning level maps to `--reasoning-effort` (`off` becomes `minimal`, because the CLI rejects `none` with `--provider meta`; `max` becomes `ultra`).
- PNG, JPEG, WebP, and GIF images are written to the temp workspace and passed as `--image`. The transcript holds numbered placeholders. Other MIME types fail the turn.
- Muse's workspace and process directory are temporary; Pi's actual working directory stays in the prompt and Pi executes tools there. Prompt, schema, and image files are deleted when the turn finishes.
- CLI output over 16 MiB, a failed or missing terminal event, or an invalid envelope fails the turn. Abort and session shutdown kill the process tree.

## Usage accounting

The CLI emits a `run.usage` event with per-model `models[]` counts, which the adapter maps to Pi usage. A turn with no usage record fails. The CLI does not document whether input includes cached tokens, so mapped totals involving cached tokens are estimates, not exact cache accounting.

## Verification

Validation gates, run from the repo root:

- `npm run typecheck` and `npm run lint`
- `node --experimental-transform-types --test agent/extensions/test/prompt-delivery.test.ts agent/extensions/test/extension-discovery.test.ts agent/extensions/test/jev-skill-context.test.ts agent/extensions/test/orchestrate-status.test.ts`

Observed results:

- Offline: discovery registers exactly one `muse-code` provider at runtime. A missing binary fails. A pre-aborted request starts no child. Cancelling an in-flight request kills the child process tree and cleans the temp workspace.
- Live, two Muse Wonder1.0 turns passed. The prompt carried the full earlier history plus the actual user task, followed by a Jev advisory. Muse answered with a native Pi `read` tool call, Pi returned the generated file contents, and Muse's final answer matched the expected prefix plus those contents. Stream event order was balanced, and IDs and response-model attribution were correct.
- Live on Muse Code 1.4.20: Pi's own agent loop with Spark 1.3 Contributor discovered and read `benchmark-checklist` from Pi's skill listing, then answered using its contents and the project context. Ember 1.0 executed Pi's `bash` (`pwd`), read the same skill by relative path, and continued correctly after both results.
- A fresh Pi process dispatched the configured Artisan worker on `muse-code/muse-spark-1.3-contributor` without fallback. The worker identified its specialist role, read the Pi skill, and returned the expected guidance. Already-running task runtimes may retain old agent routing; restart Pi after changing provider assignments.
- Relative `PI_MUSE_BINARY` was live-verified; pre-aborted and early-cancelled requests left no new temporary directories.
- Tiny-prompt probes observed 24,300 input tokens before context controls and 336–337 after, on Wonder 1.0. These are single-run transport probes, not a subscription savings guarantee. The real skill/tool checks used roughly 9.4–10.3k input tokens per model step, including Pi's actual instructions and skill listings. This adapter still resends the transcript; it does not implement persistent Muse sessions or guarantee prompt-cache reuse.
- Not verified: live image inference. Image handling is covered offline (projection) only.
