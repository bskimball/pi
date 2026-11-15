# Pi skill mechanics

A skill folder contains `SKILL.md` with YAML `name` and `description`, followed by task instructions. Supporting scripts and references are loaded only when needed. Resolve relative links from the skill directory.

Pi discovers skills under `agent/skills`, including linked directories, and configured package or project skill paths. Its system prompt lists each visible skill's name, description, and location; it does not inline the body. A matching task or `/skill:<name>` loads the body.

`disable-model-invocation: true` hides a skill from the automatic discovery list while keeping explicit invocation available. It is a discovery setting, not an access restriction on reading a referenced file. Preserve the existing invocation policy unless the user requests a change. Do not use unrelated runtimes' metadata fields to assume Pi behavior.

Keep descriptions specific enough to route the right task without attracting every coding request. Put substantive recipes in the body and conditional detail behind pointers naming when to read it. A router or extra reference file is useful only when it saves loading irrelevant instructions.
