import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

// One table per SDK catalog fact the Desktop selection UI depends on. Every pi
// bump used to re-assert these same facts in a new pi-<version>-provider file;
// adding or retiring a model is now a one-row edit here.

const CONTEXT_WINDOWS = [
  ["anthropic", "claude-opus-5-5", 1_000_000],
  ["anthropic", "claude-sonnet-5-5", 1_000_000],
  ["github-copilot", "claude-opus-5.5", 1_000_000],
  ["github-copilot", "gpt-6-sol", 1_000_000],
  ["openai", "gpt-6-sol", 272_000],
  ["openai-codex", "gpt-6-sol", 272_000],
  ["openai", "gpt-6-luna", 272_000],
  ["openai-codex", "gpt-6-luna", 272_000],
  ["openai", "gpt-6.1-sol", 272_000],
  ["azure", "gpt-6.1-sol", 1_050_000],
  ["openai-codex", "gpt-6.1-sol", 500_000],
  ["openai", "gpt-6.1-terra", 272_000],
  ["azure", "gpt-6.1-terra", 1_050_000],
  ["openai-codex", "gpt-6.1-terra", 500_000],
  ["xai", "grok-4.7", 500_000],
];

test("context windows stay provider- and model-specific", () => {
  for (const [provider, id, contextWindow] of CONTEXT_WINDOWS) {
    assert.equal(getModel(provider, id)?.contextWindow, contextWindow, `${provider}/${id}`);
  }
});

const THINKING_LEVELS = [
  ["anthropic", "claude-haiku-5-5", ["max", "off"]],
  ["anthropic", "claude-opus-5", ["off"]],
  ["openai", "gpt-6.1-terra", ["off"]],
  ["azure", "gpt-6.1-terra", ["off"]],
  ["openai-codex", "gpt-6.1-terra", ["off"]],
];

test("models the selection UI offers still advertise their thinking levels", () => {
  for (const [provider, id, levels] of THINKING_LEVELS) {
    const model = getModel(provider, id);
    assert.ok(model, `${provider}/${id}`);
    for (const level of levels)
      assert.ok(getSupportedThinkingLevels(model).includes(level), `${provider}/${id} must support ${level}`);
  }
});

const RETIRED_MODELS = [
  ["openai", "gpt-realtime-2.1"],
  ["openai-codex", "gpt-5.5"],
  ["openai-codex", "gpt-5.3-codex-spark"],
];

test("retired models stay out of the catalog", () => {
  for (const [provider, id] of RETIRED_MODELS) assert.equal(getModel(provider, id), undefined, `${provider}/${id}`);
});

test("classifier availability follows the credential type", async () => {
  for (const credential of [
    { type: "api_key", key: "sk-offline-fixture" },
    { type: "oauth", access: "offline-subscription", refresh: "offline-refresh", expires: Date.now() + 3600000 },
  ]) {
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
      credentials: {
        async read(provider) {
          return provider === "openai" ? credential : undefined;
        },
        async list() {
          return [{ providerId: "openai", type: credential.type }];
        },
        async modify() {
          throw new Error("read-only fixture");
        },
        async delete() {
          throw new Error("read-only fixture");
        },
      },
    });
    const available = await runtime.getAvailableOfType("classifier", "openai");
    assert.equal(
      available.some((model) => model.id === "gpt-6-luna"),
      credential.type === "api_key",
    );
    assert.ok(runtime.getModels().every((model) => (model.type ?? "chat") === "chat"));
  }
});
