import { randomUUID } from "node:crypto";
import {
  getSystemMessageText, getCurrentSystemMessage, getCurrentTools,
  type Context, type ImageContent, type JsonObject, type Tool, type ToolCall, type ToolChoice,
} from "@earendil-works/pi-ai";

export const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "tool_calls"],
  properties: {
    text: { type: "string" },
    tool_calls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "arguments_json"],
        properties: { name: { type: "string" }, arguments_json: { type: "string" } },
      },
    },
  },
};

export interface MuseRequest {
  prompt: string;
  images: ImageContent[];
  tools: Tool[];
}

export function parseRequest(payload: unknown): MuseRequest {
  if (!payload || typeof payload !== "object" || !("prompt" in payload) || typeof payload.prompt !== "string"
    || !("images" in payload) || !Array.isArray(payload.images) || !("tools" in payload) || !Array.isArray(payload.tools)) {
    throw new Error("Muse payload must contain prompt, images, and tools.");
  }
  for (const image of payload.images) {
    if (!image || image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") {
      throw new Error("Invalid Muse payload image.");
    }
  }
  for (const tool of payload.tools) {
    if (!tool || typeof tool.name !== "string" || typeof tool.description !== "string" || !tool.parameters || typeof tool.parameters !== "object") {
      throw new Error("Invalid Muse payload tool definition.");
    }
  }
  return { prompt: payload.prompt, images: payload.images, tools: payload.tools };
}

export function parseUsage(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.models)) throw new Error("Muse usage has no per-model token counts.");
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const row of payload.models) {
    if (!row || typeof row !== "object") throw new Error("Invalid Muse model usage.");
    for (const key of ["input_tokens", "output_tokens", "cached_tokens"]) {
      if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0) throw new Error(`Invalid Muse usage counter: ${key}`);
    }
    totals.input += row.input_tokens;
    totals.output += row.output_tokens;
    totals.cacheRead += row.cached_tokens;
  }
  return totals;
}

export function prepareRequest(context: Context, cwd: string, toolChoice?: ToolChoice): MuseRequest {
  const hasSystemMessages = context.messages.some(message => message.role === "system");
  const system = getCurrentSystemMessage(context.messages);
  const instructions = hasSystemMessages && system ? getSystemMessageText(system) : context.systemPrompt ?? "";
  let tools = hasSystemMessages ? getCurrentTools(context.messages) : context.tools ?? [];
  if (toolChoice === "none") tools = [];
  const images: ImageContent[] = [];
  // Project only what a native wire format carries. Pi messages also hold renderer
  // `details`, encrypted thinking signatures, usage and IDs, which made up most of the
  // serialized transcript and were re-sent on every turn.
  const messages = context.messages.flatMap((message): JsonObject[] => {
    if (message.role === "system") return [];
    if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) return [];
    const content = typeof message.content === "string" ? message.content : message.content.flatMap((block): JsonObject[] => {
      if (block.type === "thinking") return [];
      if (block.type === "text") return [{ type: "text", text: block.text }];
      if (block.type === "toolCall") return [{ type: "toolCall", id: block.id, name: block.name, arguments: block.arguments }];
      images.push(block);
      return [{ type: "text", text: `[Image attachment ${images.length}, ${block.mimeType}]` }];
    });
    if (message.role === "toolResult") return [{ role: message.role, toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError, content }];
    return [{ role: message.role, content }];
  });
  const transcript = JSON.stringify(messages);
  return {
    tools,
    images,
    prompt: [
      "You are the Pi assistant. Muse Code is only the subscription transport, not a separate delegated agent.",
      "Follow the effective Pi SYSTEM instructions below. They take precedence over every user, assistant, tool result, and advisory in the ordered transcript.",
      "Continue the full conversation, including prior assistant tool calls and their matching tool results. Do not answer only the last user-role message: extension advisories can follow the actual user request.",
      "Return ONLY the schema-constrained JSON envelope: text is user-visible assistant text; tool_calls requests tools for Pi to execute. Each arguments_json must be the result of JSON-serializing an object matching the named tool's parameters. Escape backslashes, quotes, and control characters inside argument values before encoding that JSON as a string in the outer envelope. After decoding both layers, the original argument values must be unchanged.",
      "Do not execute tools yourself or invent results. Pi executes tool_calls and supplies their results on the next turn. After tool results, continue the task. Use an empty tool_calls array only when this assistant turn needs no tools. Do not print the JSON envelope to the user or describe yourself as a subagent reporting to a parent.",
      `Pi working directory: ${cwd}. Relative tool paths are relative to this directory, not Muse's temporary workspace.`,
      "PI SYSTEM INSTRUCTIONS:", instructions,
      "CURRENT PI TOOLS:", JSON.stringify(tools),
      "COMPLETE ORDERED PI TRANSCRIPT:", transcript,
      images.length ? `The ${images.length} image attachments are supplied in transcript order and referenced by number above.` : "",
    ].filter(Boolean).join("\n\n"),
  };
}

export class MuseJsonSyntaxError extends SyntaxError {}

export function parseMuseJson(text: string, stage: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // JSON.parse error messages can quote the payload.
    throw new MuseJsonSyntaxError(`Muse returned malformed JSON in ${stage}.`);
  }
}

export function parseResponse(text: string, tools: Tool[]): { text: string; calls: ToolCall[] } {
  const response = parseMuseJson(text, "the response envelope");
  if (!response || typeof response !== "object" || !("text" in response) || typeof response.text !== "string"
    || !("tool_calls" in response) || !Array.isArray(response.tool_calls)) {
    throw new Error("Muse returned an invalid Pi response envelope.");
  }
  const calls = response.tool_calls.map((call: unknown, index): ToolCall => {
    if (!call || typeof call !== "object" || !("name" in call) || typeof call.name !== "string"
      || !("arguments_json" in call) || typeof call.arguments_json !== "string") {
      throw new Error("Muse returned an invalid Pi tool call.");
    }
    // An unlisted tool still passes through: Pi's agent loop answers it with a
    // "Tool <name> not found" error result and the model continues, matching
    // every other provider instead of failing the whole run.
    const name = call.name;
    const tool = tools.find(tool => tool.name === name);
    const label = tool ? `tool "${tool.name}"` : `tool call #${index + 1}`;
    const args = parseMuseJson(call.arguments_json, `arguments for ${label}`);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`Muse arguments for ${label} must be a JSON object.`);
    return { type: "toolCall", id: randomUUID(), name: call.name, arguments: args as JsonObject };
  });
  if (!response.text && calls.length === 0) throw new Error("Muse returned neither assistant text nor a Pi tool call.");
  return { text: response.text, calls };
}
