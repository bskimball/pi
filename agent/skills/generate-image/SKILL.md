---
name: generate-image
description: Generates image files from text prompts via the local proxy image API (gpt-image-2, with automatic fallback to grok-imagine-image and gpt-image-1.5). Use when asked to create, generate, or draw an image, illustration, icon, logo, texture, concept art, or other visual asset file from a description — not for editing existing app UI code.
---

# Generate Image

Deterministic image generation via `{skill_dir}/generate_image.py`. Do not hand-roll curl calls to the image API; use this script.

## Usage

Reads the local proxy key from `~/.pi/agent/models.json`, with `PI_LOCAL_PROXY_API_KEY` as an optional override.

```bash
python "{skill_dir}/generate_image.py" "PROMPT" --out path/to/image.png [--size 1024x1024] [--n 2] [--model MODEL]
```

- `--out`: output PNG path (default `image.png`). For `--n > 1`, files get `_2`, `_3` suffixes.
- `--size`: `1024x1024` (default per model), `1536x1024` (landscape), `1024x1536` (portrait).
- `--model`: pin one model, disables fallback. Otherwise chain is `gpt-image-2` → `grok-imagine-image` → `gpt-image-1.5` (2 attempts each).

Validates each result before and after writing (nonzero bytes, PNG signature, IHDR dimensions), then prints bounded metadata. The exact `model: <used model>` and `saved: <path>` lines remain present on success, followed by `png: <width>x<height>, <bytes> bytes`; exit code 1 if all models fail.

## Notes

- Known issue: the proxy currently 503s on `grok-imagine-image`/`grok-imagine-image-quality` with a misleading "only supported on /v1/images/generations" message. The chain falls through automatically.
- Write detailed, concrete prompts: subject, style, composition, lighting, color palette, background. The script passes the prompt verbatim.
- Treat the script's PNG metadata as the default artifact validation; do not use the `read` tool on the generated PNG unless the orchestrator explicitly requests visual inspection.
