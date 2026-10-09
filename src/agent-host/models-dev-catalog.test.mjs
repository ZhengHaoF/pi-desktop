import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");
const isolatedAgentDirectory = mkdtempSync(path.join(tmpdir(), "pi-models-dev-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDirectory;
after(() => rmSync(isolatedAgentDirectory, { recursive: true, force: true }));

const {
  MODELS_DEV_CACHE_TTL_MS,
  buildModelInfoFill,
  loadModelsDevCatalog,
  matchBuiltinModelFacts,
  matchModelFacts,
  slimModelsDevCatalog,
} = await import(pathToFileURL(path.join(root, "src/agent-host/models-dev-catalog.ts")).href);

function pathToFileURL(filePath) {
  const url = new URL("file://");
  url.pathname = filePath.split(path.sep).join("/");
  return url;
}

// Fixture shaped like models.dev's api.json: provider entries carry the
// endpoint, limits and pricing; relay providers prefix model ids with a vendor.
const fixturePayload = {
  "stepfun-step-plan": {
    id: "stepfun-step-plan",
    name: "StepFun Step Plan (China)",
    api: "https://api.stepfun.com/step_plan/v1",
    models: {
      "step-5-preview": {
        id: "step-5-preview",
        name: "Step 5 Preview",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        modalities: { input: ["text", "image", "video"], output: ["text"] },
        limit: { context: 1_000_000, input: 1_000_000, output: 65_536 },
        canonical_model_id: "stepfun/step-5-preview",
        tool_call: true,
        release_date: "2026-09-16",
      },
    },
  },
  stepfun: {
    id: "stepfun",
    name: "StepFun (China)",
    api: "https://api.stepfun.com/v1",
    models: {
      "step-5-preview": {
        id: "step-5-preview",
        name: "Step 5 Preview",
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1_000_000, output: 65_536 },
        cost: { input: 0.959, output: 2.741, cache_read: 0.048 },
      },
    },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    api: "https://openrouter.ai/api/v1",
    models: {
      "stepfun/step-5-preview": {
        id: "stepfun/step-5-preview",
        name: "StepFun: Step 5 Preview",
        limit: { context: 256_000, output: 32_000 },
        cost: { input: 1, output: 3 },
      },
      "acme/relay-model": { id: "acme/relay-model", name: "Acme Relay", limit: { context: 8_192, output: 4_096 } },
    },
  },
};

const cacheFile = path.join(isolatedAgentDirectory, "models-dev-catalog.json");

function clearCache() {
  rmSync(cacheFile, { force: true });
}

function writeCache(catalog) {
  writeFileSync(cacheFile, JSON.stringify(catalog), "utf8");
}

test("the models.dev payload is reduced to the fields models.json can store", () => {
  const catalog = slimModelsDevCatalog(fixturePayload, 1_000);
  assert.equal(catalog.fetchedAt, 1_000);
  assert.deepEqual(catalog.providers["stepfun-step-plan"].models["step-5-preview"], {
    name: "Step 5 Preview",
    reasoning: true,
    // "video" is dropped: models.json input only supports text and image.
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    canonicalModelId: "stepfun/step-5-preview",
  });
  assert.deepEqual(catalog.providers.stepfun.models["step-5-preview"].cost, {
    input: 0.959,
    output: 2.741,
    cacheRead: 0.048,
  });
  // catalog.json nests the same provider map one level deeper.
  const nested = slimModelsDevCatalog({ providers: fixturePayload }, 1);
  assert.equal(nested.providers["stepfun-step-plan"].models["step-5-preview"].maxTokens, 65_536);
  assert.deepEqual(slimModelsDevCatalog({ nope: true }, 1).providers, {});
});

test("a base URL match wins, and pricing falls back to the sibling provider entry", () => {
  const catalog = slimModelsDevCatalog(fixturePayload, 1);
  const match = matchModelFacts(catalog, {
    modelId: "step-5-preview",
    providerName: "stepfun-provider",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
  });

  assert.equal(match.providerId, "stepfun-step-plan");
  assert.equal(match.providerName, "StepFun Step Plan (China)");
  assert.equal(match.matchedBy, "baseUrl");
  assert.equal(match.facts.contextWindow, 1_000_000);
  assert.equal(match.facts.cost, undefined, "the endpoint entry itself carries no pricing");
  assert.deepEqual(match.price, { input: 0.959, output: 2.741, cacheRead: 0.048 });
  assert.equal(match.priceProviderName, "StepFun (China)");
});

test("an unknown base URL falls back to the same host, then to a global id match", () => {
  const catalog = slimModelsDevCatalog(fixturePayload, 1);
  const sameHost = matchModelFacts(catalog, {
    modelId: "step-5-preview",
    baseUrl: "https://api.stepfun.com/unknown-path/v1",
  });
  assert.equal(sameHost.matchedBy, "host");

  const global = matchModelFacts(catalog, {
    modelId: "step-5-preview",
    providerName: "my-gateway",
    baseUrl: "https://example.com/v1",
  });
  assert.equal(global.matchedBy, "global");
  // The priced entry outranks the endpoint entry once the base URL cannot decide.
  assert.equal(global.providerId, "stepfun");
  assert.deepEqual(global.price, { input: 0.959, output: 2.741, cacheRead: 0.048 });

  const relay = matchModelFacts(catalog, { modelId: "acme/relay-model", baseUrl: "https://openrouter.ai/api/v1" });
  assert.equal(relay.providerId, "openrouter");
  assert.equal(relay.facts.contextWindow, 8_192);
  // Relay ids are also reachable without the vendor prefix.
  const relaySuffix = matchModelFacts(catalog, { modelId: "relay-model", baseUrl: "https://openrouter.ai/api/v1" });
  assert.equal(relaySuffix.providerId, "openrouter");
});

test("no catalog entry means no match", () => {
  const catalog = slimModelsDevCatalog(fixturePayload, 1);
  assert.equal(matchModelFacts(catalog, { modelId: "not-a-real-model" }), undefined);
  assert.equal(matchModelFacts(catalog, { modelId: "  " }), undefined);
});

test("filling only writes values the source provides and never clears user choices", () => {
  const catalog = slimModelsDevCatalog(fixturePayload, 1);
  const match = matchModelFacts(catalog, {
    modelId: "step-5-preview",
    providerName: "stepfun-provider",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
  });

  const fresh = buildModelInfoFill(match, { id: "step-5-preview" });
  assert.deepEqual(fresh.fields, {
    name: "Step 5 Preview",
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    reasoning: true,
    input: ["text", "image"],
    // models.json requires all four cost keys, so the fill always emits a complete cost.
    cost: { input: 0.959, output: 2.741, cacheRead: 0.048, cacheWrite: 0 },
  });
  assert.deepEqual([...fresh.filled].sort(), ["contextWindow", "cost", "input", "maxTokens", "name", "reasoning"]);

  const alreadySet = buildModelInfoFill(match, {
    name: "My own name",
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.959, output: 2.741, cacheRead: 0.048, cacheWrite: 0 },
  });
  assert.deepEqual(alreadySet.fields, {});
  assert.deepEqual(alreadySet.filled, [], "an entry that already matches must report nothing to fill");

  // Reasoning is only ever switched on, and a name is never replaced.
  const cleared = buildModelInfoFill(match, {
    name: "Keep me",
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal(cleared.fields.reasoning, true);
  assert.equal(cleared.fields.name, undefined);
  assert.deepEqual(cleared.fields.cost, { input: 0.959, output: 2.741, cacheRead: 0.048, cacheWrite: 0 });
  assert.deepEqual(cleared.filled, ["reasoning", "cost"]);
});

test("a filled cost is always complete and preserves values the source omits", () => {
  const catalog = slimModelsDevCatalog(fixturePayload, 1);
  const match = matchModelFacts(catalog, {
    modelId: "step-5-preview",
    providerName: "stepfun-provider",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
  });
  // The source only prices input/output/cacheRead; the user's cacheWrite survives
  // and the missing key defaults to 0 so the saved models.json stays valid.
  const merged = buildModelInfoFill(match, {
    name: "Step 5 Preview",
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.5, cacheWrite: 7 },
  });
  assert.deepEqual(merged.fields.cost, { input: 0.959, output: 2.741, cacheRead: 0.048, cacheWrite: 7 });
  assert.deepEqual(merged.filled, ["cost"]);

  // A model without any cost still receives a complete object.
  const fromScratch = buildModelInfoFill(match, {});
  assert.deepEqual(fromScratch.fields.cost, { input: 0.959, output: 2.741, cacheRead: 0.048, cacheWrite: 0 });

  // Identical complete costs report nothing to fill.
  const noop = buildModelInfoFill(match, {
    name: "Step 5 Preview",
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.959, output: 2.741, cacheRead: 0.048, cacheWrite: 0 },
  });
  assert.deepEqual(noop.filled, []);
  assert.equal(noop.fields.cost, undefined);
});

test("the built-in catalog fallback skips the user's own providers", () => {
  const source = {
    getModels: () => [
      // A metadata-less models.json entry: the runtime injects placeholder values.
      {
        id: "step-5-preview",
        name: "step-5-preview",
        provider: "stepfun-provider",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
      {
        id: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        provider: "deepseek",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 384_000,
      },
    ],
    getProvider: (providerId) => ({ name: providerId === "deepseek" ? "DeepSeek" : "StepFun Provider" }),
  };

  assert.equal(
    matchBuiltinModelFacts(source, "step-5-preview", new Set(["stepfun-provider"])),
    undefined,
    "the user's own entry must never be used as a fill source",
  );
  const builtin = matchBuiltinModelFacts(source, "deepseek-flash");
  assert.equal(builtin.matchedBy, "builtin");
  assert.equal(builtin.providerName, "DeepSeek");
  assert.deepEqual(builtin.price, { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
  const fill = buildModelInfoFill(builtin, {});
  assert.deepEqual(fill.fields.input, ["text", "image"]);
  assert.equal(fill.fields.reasoning, true);
  assert.equal(matchBuiltinModelFacts(source, "unknown-model"), undefined);
});

test("a fresh cache is used without any network access", async () => {
  clearCache();
  writeCache(slimModelsDevCatalog(fixturePayload, Date.now()));
  let calls = 0;
  const result = await loadModelsDevCatalog({
    fetchImpl: async () => {
      calls++;
      throw new Error("must not fetch");
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.stale, false);
  assert.equal(result.catalog.providers["stepfun-step-plan"].models["step-5-preview"].contextWindow, 1_000_000);
});

test("an expired cache is refreshed and persisted atomically", async () => {
  clearCache();
  const now = 1_700_000_000_000;
  writeCache(slimModelsDevCatalog({ stale: { name: "Stale", models: {} } }, now - MODELS_DEV_CACHE_TTL_MS - 1));
  const result = await loadModelsDevCatalog({
    now,
    fetchImpl: async () => ({ ok: true, json: async () => fixturePayload }),
  });
  assert.equal(result.stale, false);
  assert.equal(result.catalog.providers["stepfun-step-plan"].models["step-5-preview"].maxTokens, 65_536);
  const persisted = JSON.parse(readFileSync(cacheFile, "utf8"));
  assert.equal(persisted.fetchedAt, now);
  assert.equal(existsSync(`${cacheFile}.${process.pid}.tmp`), false);
});

test("a failed refresh falls back to the stale cache, and a missing cache surfaces the error", async () => {
  clearCache();
  const cachedAt = 1_700_000_000_000;
  writeCache(slimModelsDevCatalog(fixturePayload, cachedAt));
  const stale = await loadModelsDevCatalog({
    now: cachedAt + MODELS_DEV_CACHE_TTL_MS + 1,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.catalog.providers.stepfun.models["step-5-preview"].cost.input, 0.959);

  clearCache();
  await assert.rejects(
    () =>
      loadModelsDevCatalog({
        fetchImpl: async () => ({ ok: false, status: 503 }),
      }),
    /HTTP 503/,
  );
  await assert.rejects(
    () =>
      loadModelsDevCatalog({
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    /offline/,
  );
});

test("a corrupt cache file is ignored instead of breaking the fill action", async () => {
  clearCache();
  writeFileSync(cacheFile, "{ not json", "utf8");
  const result = await loadModelsDevCatalog({
    fetchImpl: async () => ({ ok: true, json: async () => fixturePayload }),
  });
  assert.equal(result.stale, false);
  assert.equal(result.catalog.providers.stepfun.models["step-5-preview"].cost.output, 2.741);
});
