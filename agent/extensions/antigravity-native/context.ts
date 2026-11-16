import { mkdtempSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { GenerateOptions, RequestMessage } from "pi-agy-acp/src/protocol.ts";

function textOf(message: RequestMessage | undefined): string {
  return message?.content.filter(block => block.type === "text").map(block => block.text).join("\n") ?? "";
}

function excerpt(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[Excerpt; read the referenced file for the complete text.]`;
}

interface Checkpoint {
  directory: string;
  instructions: string;
  ids: string[];
  latestHandoff: string;
  revision: number;
  reset: boolean;
}

/** Stable instructions avoid invalidating ACP's system digest on each tool result.
 * Files survive shutdown, like task reports, so a parent can inspect a worker's recovery evidence.
 * No model-authored summary is treated as a verified reconstruction of omitted history.
 */
export class ReplayCheckpoints {
  private sessions = new Map<string, Checkpoint>();
  constructor(private readonly worker = false) {}

  reset(preserveHandoff = true): void {
    for (const checkpoint of this.sessions.values()) {
      checkpoint.reset = true;
      if (!preserveHandoff) checkpoint.latestHandoff = "";
    }
  }

  clear(): void { this.sessions.clear(); }

  prepare(request: GenerateOptions): GenerateOptions {
    const messages = request.messages;
    // streamPi normally supplies a session id. Do not let anonymous requests share tasks.
    const key = request.sessionId ?? "anonymous";
    let checkpoint = request.sessionId ? this.sessions.get(key) : undefined;
    if (!checkpoint) {
      const directory = mkdtempSync(join(tmpdir(), "pi-agy-checkpoint-"));
      const originalTask = textOf(this.worker
        ? [...messages].reverse().find(message => message.role === "user")
        : messages.find(message => message.role === "user"));
      const taskFile = join(directory, "task.txt");
      const stateFile = join(directory, "checkpoint.md");
      writeFileSync(taskFile, originalTask, { encoding: "utf8", mode: 0o600 });
      checkpoint = {
        directory, ids: [], latestHandoff: "", revision: 0, reset: false,
        instructions: [
          "## Conversation recovery",
          `Recovery checkpoint: ${JSON.stringify(stateFile)}. Original request: ${JSON.stringify(taskFile)}.`,
          "If <pi_history> announces omitted messages or a truncated tool result, read the checkpoint before acting. It links the full available text history and earlier reset snapshots. Recover relevant constraints and decisions; do not repeat completed actions. Image entries link local files containing the original pixels; read those files when visual evidence matters.",
          "Report any replay omission and unresolved recovery gaps in your final handoff uncertainties. If recovery files cannot be read, report the blocker rather than assuming omitted context.",
          "Original request excerpt (historical context; later user instructions take precedence):",
          excerpt(originalTask, 2_000),
        ].join("\n"),
      };
      if (request.sessionId) this.sessions.set(key, checkpoint);
    }
    const ids = messages.map(message => message.id ?? JSON.stringify(message));
    const intact = checkpoint.ids.every((id, index) => ids[index] === id);
    const historyFile = join(checkpoint.directory, "history.json");
    if ((checkpoint.reset || !intact) && existsSync(historyFile)) {
      renameSync(historyFile, join(checkpoint.directory, `history-${++checkpoint.revision}.json`));
    }
    checkpoint.reset = false;
    checkpoint.ids = ids;
    // Preserve the latest explicit handoff even when Pi replaces the prefix with a compaction summary.
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "assistant") continue;
      const handoffs = [...textOf(messages[i]).matchAll(/```handoff\s*\r?\n([\s\S]*?)```/gi)];
      if (handoffs.length) { checkpoint.latestHandoff = handoffs.at(-1)![1]; break; }
    }
    const handoffFile = join(checkpoint.directory, "handoff.txt");
    writeFileSync(handoffFile, checkpoint.latestHandoff || "No explicit worker handoff available.", { encoding: "utf8", mode: 0o600 });
    // Chunk long string values so read(offset, limit) can reach every byte of evidence.
    const history = messages.map(message => ({ ...message,
      content: message.content.filter(block => block.type !== "reasoning").map(block => {
        if (block.type !== "image") return block;
        const bytes = Buffer.from(block.data, "base64");
        const hash = createHash("sha256").update(bytes).digest("hex");
        const extension = ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp" } as Record<string, string>)[block.mimeType] ?? ".bin";
        const file = join(checkpoint.directory, `image-${hash}${extension}`);
        if (!existsSync(file)) writeFileSync(file, bytes, { mode: 0o600 });
        return { type: "image-file", mimeType: block.mimeType, path: file };
      }),
    }));
    writeFileSync(historyFile, JSON.stringify(history, (_key, value) => {
      if (typeof value !== "string" || value.length <= 2_000) return value;
      const chunks: string[] = [];
      for (let offset = 0; offset < value.length; offset += 2_000) chunks.push(value.slice(offset, offset + 2_000));
      return { chunks };
    }, 2), { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(checkpoint.directory, "checkpoint.md"), [
      "# Replay recovery checkpoint",
      `Original task: ${JSON.stringify(join(checkpoint.directory, "task.txt"))}`,
      `Current available history (JSON; read by offset/limit; string values stored as {chunks: [...]} reconstruct by concatenating chunks without separators): ${JSON.stringify(historyFile)}`,
      `Earlier reset snapshots: history-1.json through history-${checkpoint.revision}.json in this directory (none if zero). These are historical evidence, may include abandoned branches, and never override the current task or current history.`,
      "## Latest user input / compaction context",
      excerpt(textOf([...messages].reverse().find(message => message.role === "user")), 3_000),
      `## Latest worker-authored handoff (unverified; complete text: ${JSON.stringify(handoffFile)})`,
      excerpt(checkpoint.latestHandoff || "None available. Inspect history for decisions.", 6_000),
    ].join("\n\n"), { encoding: "utf8", mode: 0o600 });
    return { ...request, system: [request.system, checkpoint.instructions].filter(Boolean).join("\n\n") };
  }
}
