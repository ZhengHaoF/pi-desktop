import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const root = path.resolve(import.meta.dirname, "..", "..", "..");

// The runtime reaches ModelRuntime through the credential reader; bundle the graph for type stripping.
const { createWebSearchToolDefinitions, WebSearchRuntime, WebSearchSettingsStore, deepseekProvider, WebSearchError } =
  await importTestBundle("src/agent-host/web-search/tools", {
    packages: "external",
    absWorkingDir: root,
    stdin: {
      contents: `
        export { createWebSearchToolDefinitions } from "./tools.ts";
        export { WebSearchRuntime } from "./runtime.ts";
        export { WebSearchSettingsStore } from "./settings.ts";
        export { deepseekProvider } from "./providers/deepseek.ts";
        export { WebSearchError } from "./client.ts";
      `,
      resolveDir: import.meta.dirname,
      loader: "ts",
    },
  });

function harness(provider = deepseekProvider) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-tools-")), "web-search.json");
  const store = new WebSearchSettingsStore(file);
  const searchCalls = [];
  const fetchCalls = [];
  const spy = {
    id: provider.id,
    label: provider.label,
    async search(input, ctx) {
      searchCalls.push({ query: input.query, count: input.count, apiKey: ctx.apiKey });
      return provider.search(input, ctx);
    },
    async fetch(input, ctx) {
      fetchCalls.push({ url: input.url, apiKey: ctx.apiKey });
      return provider.fetch(input, ctx);
    },
  };
  const runtime = new WebSearchRuntime({ store, providers: [spy], readProviderKey: async () => undefined });
  const [search, fetch] = createWebSearchToolDefinitions(runtime);
  return { store, runtime, search, fetch, searchCalls, fetchCalls };
}

const items = [
  {
    title: "DeepSeek V4 发布",
    url: "https://example.com/v4",
    snippet: "snippet",
    summary: "DeepSeek 发布了 V4 模型，改进了工具调用与长上下文能力。",
    siteName: "Example News",
    date: "2026-06-01T00:00:00+00:00",
    authority: 3,
  },
];

const stubProvider = {
  id: "deepseek",
  label: "Stub",
  async search() {
    return items;
  },
  async fetch() {
    return { title: "Example article", content: "# Example article\n\nArticle content." };
  },
};

const { Response } = globalThis;

test("web_search formats results, marks them untrusted and forwards the resolved key", async () => {
  const { store, search, searchCalls } = harness(stubProvider);
  await store.patch({ enabled: true, apiKeyOverride: "sk-override" });
  const result = await search.execute("call-1", { query: "DeepSeek V4", count: 3 }, undefined, undefined, {});
  const text = result.content[0].text;
  assert.match(text, /1\. DeepSeek V4 发布 — 2026-06-01, authority 3/);
  assert.match(text, /https:\/\/example\.com\/v4/);
  assert.match(text, /DeepSeek 发布了 V4 模型/);
  assert.match(text, /untrusted data/);
  assert.deepEqual(searchCalls, [{ query: "DeepSeek V4", count: 3, apiKey: "sk-override" }]);
});

test("web_search defaults the result count from settings", async () => {
  const { store, search, searchCalls } = harness(stubProvider);
  await store.patch({ enabled: true, apiKeyOverride: "sk-override", maxResults: 2 });
  await search.execute("call-1", { query: "q" }, undefined, undefined, {});
  assert.equal(searchCalls[0].count, 2);
});

test("a disabled feature fails closed before contacting the provider", async () => {
  const { store, search, searchCalls } = harness(stubProvider);
  await store.patch({ apiKeyOverride: "sk-override" });
  await assert.rejects(
    () => search.execute("call-1", { query: "q" }, undefined, undefined, {}),
    (error) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "NOT_CONFIGURED");
      return true;
    },
  );
  assert.equal(searchCalls.length, 0);
});

test("a missing key fails closed with configuration guidance", async () => {
  const { store, search } = harness(stubProvider);
  await store.patch({ enabled: true });
  await assert.rejects(
    () => search.execute("call-1", { query: "q" }, undefined, undefined, {}),
    (error) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "NOT_CONFIGURED");
      assert.match(error.message, /Settings → Models/);
      return true;
    },
  );
});

test("web_fetch returns the page with its title and the untrusted footer", async () => {
  const { store, fetch, fetchCalls } = harness(stubProvider);
  await store.patch({ enabled: true, apiKeyOverride: "sk-override" });
  const result = await fetch.execute("call-1", { url: "https://example.com/article" }, undefined, undefined, {});
  assert.match(result.content[0].text, /^# Example article/);
  assert.match(result.content[0].text, /Article content\./);
  assert.match(result.content[0].text, /untrusted data/);
  assert.deepEqual(fetchCalls, [{ url: "https://example.com/article", apiKey: "sk-override" }]);
});

test("web_fetch rejects invalid URLs before any billable request", async () => {
  const original = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response("{}", { status: 200 });
  };
  try {
    const { store, fetch } = harness();
    await store.patch({ enabled: true, apiKeyOverride: "sk-override" });
    for (const url of ["not-a-url", "ftp://example.com", "https://user:pass@example.com"]) {
      await assert.rejects(
        () => fetch.execute("call-1", { url }, undefined, undefined, {}),
        (error) => {
          assert.ok(error instanceof WebSearchError);
          assert.equal(error.code, "BAD_REQUEST");
          return true;
        },
      );
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("both tools declare read-only annotations and never activate by default", () => {
  const { search, fetch } = harness(stubProvider);
  for (const tool of [search, fetch]) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.openWorldHint, true);
    assert.equal(tool.defaultActive, false);
  }
});

test("settings defaults leave the tools registered but unavailable", async () => {
  const { runtime } = harness(stubProvider);
  await runtime.refresh();
  assert.deepEqual(runtime.getAvailability(), { enabled: false, hasCredential: false, source: "none" });
});

test("enabling the feature with a resolvable provider key flips availability", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-avail-")), "web-search.json");
  const store = new WebSearchSettingsStore(file);
  const runtime = new WebSearchRuntime({
    store,
    providers: [stubProvider],
    readProviderKey: async () => "sk-provider",
  });
  await runtime.refresh();
  assert.equal(runtime.getAvailability().enabled, false);

  await store.patch({ enabled: true });
  await runtime.refresh();
  assert.deepEqual(runtime.getAvailability(), { enabled: true, hasCredential: true, source: "provider" });
});
