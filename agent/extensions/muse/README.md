# Muse

Config-owned Pi provider `muse-code` that runs prompts through the local Muse CLI under the user's Muse subscription. It replaces `npm:pi-muse-bridge`, which is removed from Pi's package configuration. Restart or reload Pi after changing that configuration.

## Requirements

- Muse CLI 1.4.14 or later, already installed. The extension does not install anything and does not check the version.
- A native browser/subscription login completed in the Muse CLI. Pi never reads Muse auth files.
- Muse's model catalog at `$XDG_DATA_HOME/muse/model-catalog/*.json` (default `~/.local/share/muse/model-catalog`). Run Muse Code once to refresh it. Startup fails if the catalog has no default chat model.
- Binary lookup: `PI_MUSE_BINARY` if set; otherwise `muse` on non-Windows; on Windows, `%LOCALAPPDATA%\Programs\muse\muse-bin-<version>.exe` using `.muse-version`. On Windows, an override naming a missing versioned executable in that default install directory (left by an older extension, then removed by a Muse update) resolves to the current `.muse-version`. Any other explicit override keeps priority.

## Authentication

Login is the CLI's subscription login. There is no API fallback and no remote API adapter. `META_API_KEY` (any casing) is stripped from the child environment. A key already stored in the CLI's own credentials is not inspected, so which credential the CLI picks is the user's responsibility.

## Models

Every catalog model is exposed as `muse-code/<model_id>`, so existing `muse-code/*` IDs keep working. `muse-code/muse-spark` is an alias for the catalog default. Image-generation models (`muse-image-*`) are skipped. Models advertise text and image input, reasoning, and zero cost (subscription billing).

## How a turn works

The adapter is stateless. Each Pi model turn starts a fresh `muse exec --preset empty` process with `--output-schema` set to an envelope `{ text, tool_calls: [{ name, arguments_json }] }`. The prompt carries the full Pi transcript, the current system prompt, and the current tool definitions.

Before submission, Pi's `onPayload` callback receives `{ prompt, images, tools }`. It may mutate or replace that payload, or reject to prevent the CLI call.

1. Muse returns the envelope. Pi validates it, and each tool call must name a tool in the effective payload.
2. Pi executes the tools itself.
3. The next request resends the whole transcript, including the full tool results.

Pi system instructions travel as labeled prompt content (`PI SYSTEM INSTRUCTIONS`), not as a native Muse system override. Every call passes `--yolo` to skip Muse approval and sandbox permissions, without `--disable-shell` or `--disable-write` restrictions that can cause the model to refuse Pi tool requests. This does not change Pi's own permissions. The empty preset keeps Muse's native tools out of the turn; Pi executes the returned tool calls. Web tools and reminders remain disabled. The CLI runs with `--max-model-steps 1` and `--no-session-log`.

## Behavior and limits

- Responses are buffered until the terminal structured envelope is validated. Output is not token-incremental; text and tool calls arrive at once.
- Every Pi model turn pays CLI process startup plus a full-transcript prompt, so latency is higher than a native provider.
- Reasoning content is not exposed. Pi's reasoning level maps to `--reasoning-effort` (`off` becomes `none`, `max` becomes `ultra`).
- PNG, JPEG, WebP, and GIF images are written to the temp workspace and passed as `--image`. The transcript holds numbered placeholders. Other MIME types fail the turn.
- Each turn uses Pi's working directory as Muse's workspace and process directory. Prompt, schema, and image files are held in a temporary directory that is deleted when the turn finishes.
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
- Not verified: live image inference. Image handling is covered offline (projection) only.
