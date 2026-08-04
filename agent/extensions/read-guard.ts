// read-guard: stop repeated/oversized image reads from burning tokens.
//
// 1. Per-session: after a successful `read` that returns an image block, block
//    a later `read` of the same absolute path when mtime+size are unchanged.
// 2. On image results whose base64 payload exceeds ~1.5MB, append a short
//    advisory note (do not strip the image).
// 3. No text re-read guard — text re-reads are intentional and cheap enough.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isReadToolResult,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";

/** ~1.5MB of base64 characters (advisory threshold only; never blocks). */
const LARGE_IMAGE_BASE64_CHARS = Math.floor(1.5 * 1024 * 1024);

interface ImageReadRecord {
  mtimeMs: number;
  size: number;
  base64Chars: number;
}

function resolveReadPath(raw: string, cwd: string): string {
  return path.resolve(cwd, raw);
}

function formatMb(base64Chars: number): string {
  return (base64Chars / (1024 * 1024)).toFixed(1);
}

export default function (pi: ExtensionAPI): void {
  /** Absolute path → last successful image-read identity for this session. */
  let imageReads = new Map<string, ImageReadRecord>();

  pi.on("session_start", () => {
    imageReads = new Map();
  });

  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("read", event)) return;

    const raw = event.input.path;
    if (typeof raw !== "string" || raw.length === 0) return;

    const abs = resolveReadPath(raw, ctx.cwd);
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

  pi.on("tool_result", (event, ctx) => {
    if (!isReadToolResult(event) || event.isError) return;

    const raw = event.input.path;
    if (typeof raw !== "string" || raw.length === 0) return;

    const imageBlocks = event.content.filter(
      (block): block is { type: "image"; data: string; mimeType: string } =>
        block.type === "image" &&
        typeof (block as { data?: unknown }).data === "string",
    );
    if (imageBlocks.length === 0) return;

    let base64Chars = 0;
    for (const block of imageBlocks) base64Chars += block.data.length;

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

    if (base64Chars <= LARGE_IMAGE_BASE64_CHARS) return;

    const mb = formatMb(base64Chars);
    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text: `Note: this image is very large (~${mb} MB base64). For future large screenshots, downscale before reading to reduce token cost.`,
        },
      ],
    };
  });
}
