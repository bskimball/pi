// read-guard: stop repeated/oversized tool results from burning tokens.
//
// 1. Per-session: after a successful `read` that returns an image block, block
//    a later `read` of the same absolute path when mtime+size are unchanged.
// 2. Downscale image blocks in ANY tool result (read, mcp screenshots, ...)
//    to <=1568px on the long edge. Anthropic/OpenAI/Gemini vision endpoints
//    downscale past ~1568px server-side anyway, so larger payloads are pure
//    token waste with no quality impact. A dimension note is appended so the
//    model knows the coordinate mapping.
// 3. Advisory on bash results over ~20KB: nudge toward head/tail/grep piping.
// 4. Text re-read guard: the third unchanged read of the same path+region
//    is blocked. One confirmation re-read stays allowed. An edit, a write,
//    or a changed mtime/size clears it. Compaction clears it too, because
//    the earlier copy is no longer in context.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatDimensionNote,
  isBashToolResult,
  isReadToolResult,
  isToolCallEventType,
  resizeImage,
} from "@earendil-works/pi-coding-agent";

/** Long-edge cap; matches what vision APIs keep before server-side downscale. */
const MAX_IMAGE_DIMENSION = 1568;

/** Skip the WASM decode for images that cannot meaningfully shrink. */
const RESIZE_MIN_BASE64_CHARS = 256 * 1024;

/** Bash output size that triggers the piping advisory. */
const BASH_ADVISORY_CHARS = 20 * 1024;

const WILDCARD_ONLY =
  /^(?:\.\*|\.\+|\[\\s\\S\][*+]|\[\\S\\s\][*+]|\[\\w\\W\][*+]|\[\\W\\w\][*+]|\[\\d\\D\][*+]|\[\\D\\d\][*+])$/;

/**
 * Conservative: true only when the regex can only mean "every line/file".
 * Literal searches and discriminating regexes stay allowed.
 */
export function isWildcardOnlyGrepPattern(pattern: string): boolean {
  let p = pattern;
  if (!p) return false;
  const flags = /^\(\?[ims]+\)/.exec(p);
  if (flags) p = p.slice(flags[0].length);
  if (p.startsWith("^")) p = p.slice(1);
  if (p.endsWith("$")) p = p.slice(0, -1);
  return WILDCARD_ONLY.test(p);
}

const GREP_WILDCARD_REASON =
  "This is a catch-all grep pattern. Use read with offset/limit for file contents, or 1–2 discriminating search terms.";

interface ImageReadRecord {
  mtimeMs: number;
  size: number;
  base64Chars: number;
}

interface TextReadRecord {
  mtimeMs: number;
  size: number;
  count: number;
}

/** Third identical unchanged read of this region is the one that burns tokens. */
const TEXT_REREAD_BLOCK_AT = 2;

function readRegionKey(abs: string, offset: unknown, limit: unknown): string {
  const off = typeof offset === "number" ? String(offset) : "";
  const lim = typeof limit === "number" ? String(limit) : "";
  return `${abs}\0${off}\0${lim}`;
}

interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

function isImageBlock(block: unknown): block is ImageBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "image" &&
    typeof (block as { data?: unknown }).data === "string" &&
    typeof (block as { mimeType?: unknown }).mimeType === "string"
  );
}

function resolveReadPath(raw: string, cwd: string): string {
  return path.resolve(cwd, raw);
}

function formatMb(base64Chars: number): string {
  return (base64Chars / (1024 * 1024)).toFixed(1);
}

/**
 * Downscale oversized image blocks in-place order, returning new content and
 * notes. Returns null when nothing changed.
 */
async function downscaleImages(
  content: readonly unknown[],
): Promise<{ content: unknown[]; notes: string[] } | null> {
  let changed = false;
  const notes: string[] = [];
  const out: unknown[] = [];

  for (const block of content) {
    if (!isImageBlock(block) || block.data.length < RESIZE_MIN_BASE64_CHARS) {
      out.push(block);
      continue;
    }
    let resized: Awaited<ReturnType<typeof resizeImage>> = null;
    try {
      resized = await resizeImage(
        Buffer.from(block.data, "base64"),
        block.mimeType,
        { maxWidth: MAX_IMAGE_DIMENSION, maxHeight: MAX_IMAGE_DIMENSION },
      );
    } catch {
      // Photon unavailable or decode failure: keep the original block.
    }
    // Keep the original when resizing failed, was a no-op, or re-encoded
    // larger (e.g. noisy images that compress poorly after resampling).
    if (!resized || !resized.wasResized || resized.data.length >= block.data.length) {
      out.push(block);
      continue;
    }
    changed = true;
    out.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
    const note = formatDimensionNote(resized);
    notes.push(
      note ??
        `[Image downscaled from ${resized.originalWidth}x${resized.originalHeight} to ${resized.width}x${resized.height}.]`,
    );
  }

  return changed ? { content: out, notes } : null;
}

function fileIdentity(abs: string): { mtimeMs: number; size: number } | undefined {
  try {
    const st = fs.statSync(abs);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI): void {
  /** Absolute path → last successful image-read identity for this session. */
  let imageReads = new Map<string, ImageReadRecord>();
  /** path+region → unchanged text reads still in context. */
  let textReads = new Map<string, TextReadRecord>();

  const clearReads = () => {
    imageReads = new Map();
    textReads = new Map();
  };

  const forgetPath = (abs: string) => {
    imageReads.delete(abs);
    const prefix = `${abs}\0`;
    for (const key of textReads.keys()) {
      if (key.startsWith(prefix)) textReads.delete(key);
    }
  };

  pi.on("session_start", clearReads);
  pi.on("session_compact", clearReads);

  pi.on("tool_call", (event, ctx) => {
    if (process.env.PI_BEHAVIOR_MODE === "pi") return;
    if (isToolCallEventType("grep", event)) {
      const { pattern, literal } = event.input;
      if (literal === true || typeof pattern !== "string") return;
      if (!isWildcardOnlyGrepPattern(pattern)) return;
      return { block: true, reason: GREP_WILDCARD_REASON };
    }

    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      const raw = event.input.path;
      if (typeof raw === "string" && raw.length > 0) forgetPath(resolveReadPath(raw, ctx.cwd));
      return;
    }

    if (!isToolCallEventType("read", event)) return;

    const raw = event.input.path;
    if (typeof raw !== "string" || raw.length === 0) return;

    const abs = resolveReadPath(raw, ctx.cwd);
    const identity = fileIdentity(abs);
    const region = readRegionKey(abs, event.input.offset, event.input.limit);
    const textPrev = textReads.get(region);
    if (identity && textPrev && textPrev.mtimeMs === identity.mtimeMs && textPrev.size === identity.size && textPrev.count >= TEXT_REREAD_BLOCK_AT) {
      return {
        block: true,
        reason: `Text ${path.basename(abs)} is unchanged and already in context from earlier reads of this region. Use that copy, or read a different offset/limit. A re-read is allowed after the file changes.`,
      };
    }
    if (textPrev && identity && (textPrev.mtimeMs !== identity.mtimeMs || textPrev.size !== identity.size)) {
      textReads.delete(region);
    }

    const prev = imageReads.get(abs);
    if (!prev) return;

    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      // Missing / unreadable: let the real read tool report the error.
      return;
    }

    // Screenshots often get regenerated during UI iteration — allow those.
    if (st.mtimeMs !== prev.mtimeMs || st.size !== prev.size) return;

    const name = path.basename(abs);
    const mb = formatMb(prev.base64Chars);
    return {
      block: true,
      reason: `Image ${name} was already read earlier in this session and is unchanged — it is still in your context. Re-reading re-sends ~${mb} MB of base64. Reason from the version you already have, or state what specifically changed.`,
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (process.env.PI_BEHAVIOR_MODE === "pi") return;
    if (event.isError) return;

    // Bash: advise piping when output is unusually large. Never truncate.
    if (isBashToolResult(event)) {
      let chars = 0;
      for (const block of event.content) {
        if (block.type === "text") chars += block.text.length;
      }
      if (chars <= BASH_ADVISORY_CHARS) return;
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: `Note: this command produced ~${Math.round(chars / 1024)} KB of output. For similar commands, pipe through head/tail/grep or redirect to a file and read selectively.`,
          },
        ],
      };
    }

    // Text reads: count unchanged repeats of the same region. The block
    // fires on the next tool_call, so this result is already in context.
    if (isReadToolResult(event) && !event.content.some(isImageBlock)) {
      const raw = event.input.path;
      if (typeof raw === "string" && raw.length > 0) {
        const abs = resolveReadPath(raw, ctx.cwd);
        const identity = fileIdentity(abs);
        if (identity) {
          const region = readRegionKey(abs, event.input.offset, event.input.limit);
          const prev = textReads.get(region);
          const same = prev !== undefined && prev.mtimeMs === identity.mtimeMs && prev.size === identity.size;
          textReads.set(region, {
            mtimeMs: identity.mtimeMs,
            size: identity.size,
            count: same && prev ? prev.count + 1 : 1,
          });
        }
      }
    }

    // Any tool (read, mcp screenshots, ...): downscale oversized images.
    const hasImage = event.content.some(isImageBlock);
    if (!hasImage) return;

    const downscaled = await downscaleImages(event.content);
    const content = (downscaled?.content ?? [...event.content]) as Array<
      ImageBlock | { type: "text"; text: string }
    >;
    if (downscaled && downscaled.notes.length > 0) {
      content.push({ type: "text", text: downscaled.notes.join("\n") });
    }

    // Record read-image identity (post-downscale size) for the re-read guard.
    if (isReadToolResult(event)) {
      const raw = event.input.path;
      if (typeof raw === "string" && raw.length > 0) {
        let base64Chars = 0;
        for (const block of content) {
          if (isImageBlock(block)) base64Chars += block.data.length;
        }
        const abs = resolveReadPath(raw, ctx.cwd);
        try {
          const st = fs.statSync(abs);
          imageReads.set(abs, {
            mtimeMs: st.mtimeMs,
            size: st.size,
            base64Chars,
          });
        } catch {
          // Without a stable mtime/size we cannot safely de-dupe later.
        }
      }
    }

    return downscaled ? { content } : undefined;
  });
}
