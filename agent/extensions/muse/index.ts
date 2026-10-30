import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type Context, type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { museCatalog } from "./catalog.ts";
import { parseRequest, parseResponse, prepareRequest } from "./protocol.ts";
import { runMuse } from "./transport.ts";

const API = "muse-code-cli" as Api;

export function streamMuse(model: Model<Api>, context: Context, options?: SimpleStreamOptions, shutdown?: AbortSignal) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "pending", timestamp: Date.now(),
  };
  const signals = [options?.signal, shutdown].filter((signal): signal is AbortSignal => signal !== undefined);
  const signal = AbortSignal.any(signals);
  void (async () => {
    try {
      stream.push({ type: "start", partial: output });
      signal.throwIfAborted();
      const prepared = prepareRequest(context, process.cwd(), options?.toolChoice);
      const replacement = await options?.onPayload?.(prepared, model);
      const request = parseRequest(replacement === undefined ? prepared : replacement);
      const id = model.id === "muse-spark" ? museCatalog().defaultId : model.id;
      const result = await runMuse(request, id, options, signal);
      signal.throwIfAborted();
      const response = parseResponse(result.text, request.tools);
      output.responseModel = result.model;
      output.usage.input = result.input;
      output.usage.output = result.output;
      output.usage.cacheRead = result.cacheRead;
      output.usage.cacheWrite = result.cacheWrite;
      output.usage.totalTokens = result.input + result.output + result.cacheRead + result.cacheWrite;
      if (response.text) {
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex, partial: output });
        output.content[contentIndex] = { type: "text", text: response.text };
        stream.push({ type: "text_delta", contentIndex, delta: response.text, partial: output });
        stream.push({ type: "text_end", contentIndex, content: response.text, partial: output });
      }
      for (const call of response.calls) {
        const contentIndex = output.content.length;
        output.content.push({ ...call, arguments: {} });
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        output.content[contentIndex] = call;
        stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: output });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: output });
      }
      const reason = response.calls.length ? "toolUse" : "stop";
      output.stopReason = reason;
      stream.push({ type: "done", reason, message: output });
      stream.end();
    } catch (error) {
      const reason = signal.aborted ? "aborted" : "error";
      output.stopReason = reason;
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export default function muse(pi: ExtensionAPI): void {
  let shutdown = new AbortController();
  pi.on("session_start", () => { if (shutdown.signal.aborted) shutdown = new AbortController(); });
  pi.on("session_shutdown", () => shutdown.abort());
  const catalog = museCatalog();
  const defaultModel = catalog.models.find(model => model.id === catalog.defaultId)!;
  const models = [{ ...defaultModel, id: "muse-spark", name: "Muse (catalog default)" }, ...catalog.models];
  pi.registerProvider("muse-code", {
    name: "Muse subscription", baseUrl: "http://localhost", apiKey: "muse-cli-subscription", api: API,
    models: models.map(model => ({
      ...model, reasoning: true, thinkingLevelMap: { off: "off", xhigh: "xhigh", max: "max" },
      input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple: (model, context, options) => streamMuse(model, context, options, shutdown.signal),
  });
}
