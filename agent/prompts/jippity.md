---
description: Use each sub-agent's configured OpenAI Codex model, without model fallbacks
argument-hint: "[task]"
---
For subsequent delegations in this conversation, until I revoke this preference, use only each sub-agent's configured OpenAI Codex model. Keep the lead's current model and the active mode's delegation rules unchanged; this preference alone does not authorize delegation.

Before dispatching an agent:
1. Read its active agent definition. Select the first exact `openai-codex/...` model in its `model` followed by `fallbackModels`, in declaration order. Preserve its configured reasoning level.
2. Pass that exact model as `model` and `allowFallback: false` to `task` or `task_start`. This invocation explicitly authorizes those model overrides. Keep agent definitions and global settings unchanged.
3. If no Codex model is configured, the tool lacks `allowFallback`, or the selected model is unavailable, report the blocker rather than substituting another model or provider. Leave unrelated inline work actionable.

Use individual `task` or `task_start` calls instead of `task_chain`, which lacks per-step model controls. Start fresh workers for new delegations; apply this policy to recovered workers only after confirming their model and fallback policy. Existing workers and Fusion's configured sidekick are not switched by this prompt; report a conflict before using them if they cannot satisfy this policy.

If a task is supplied, proceed under this preference; otherwise briefly acknowledge it and wait.

Task: $ARGUMENTS
