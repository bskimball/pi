import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isModelFallbackError,
  shouldRetryModelFallback,
  splitQualifiedModel,
} from "./worker-runtime.ts";

describe("async worker model fallback policy", () => {
  const retryable = {
    hasNextAttempt: true,
    fallbackInProgress: false,
    killReason: undefined,
    resultText: "",
    modelError: "503: auth_unavailable",
    activitiesStarted: 0,
  };

  it("retries a clean provider/model failure", () => {
    assert.equal(shouldRetryModelFallback(retryable), true);
  });

  it("classifies only provider/model availability failures", () => {
    assert.equal(isModelFallbackError("503: auth_unavailable"), true);
    assert.equal(isModelFallbackError("No API key found for provider"), true);
    assert.equal(isModelFallbackError("429: too many requests"), true);
    assert.equal(isModelFallbackError("Model not found: provider/id"), true);
    assert.equal(isModelFallbackError("tool execution failed"), false);
    assert.equal(isModelFallbackError("context window exceeded"), false);
    assert.equal(isModelFallbackError("abort requested"), false);
  });

  it("does not replay after output, tools, kills, non-model errors, or the last model", () => {
    assert.equal(
      shouldRetryModelFallback({ ...retryable, resultText: "partial result" }),
      false,
    );
    assert.equal(
      shouldRetryModelFallback({ ...retryable, activitiesStarted: 1 }),
      false,
    );
    assert.equal(
      shouldRetryModelFallback({ ...retryable, killReason: "abort requested" }),
      false,
    );
    assert.equal(
      shouldRetryModelFallback({ ...retryable, hasNextAttempt: false }),
      false,
    );
    assert.equal(
      shouldRetryModelFallback({ ...retryable, modelError: undefined }),
      false,
    );
    assert.equal(
      shouldRetryModelFallback({
        ...retryable,
        modelError: "implementation failed",
      }),
      false,
    );
  });

  it("splits provider-qualified model identifiers", () => {
    assert.deepEqual(splitQualifiedModel("local-proxy/claude-opus-5"), {
      provider: "local-proxy",
      modelId: "claude-opus-5",
    });
    assert.deepEqual(
      splitQualifiedModel("cloudflare-workers-ai/@cf/zai-org/glm-5.2"),
      {
        provider: "cloudflare-workers-ai",
        modelId: "@cf/zai-org/glm-5.2",
      },
    );
    assert.equal(splitQualifiedModel("bare-model"), undefined);
    assert.equal(splitQualifiedModel(undefined), undefined);
  });
});
