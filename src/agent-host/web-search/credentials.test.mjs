import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const root = path.resolve(import.meta.dirname, "..", "..", "..");

// The credential reader reaches ModelRuntime, whose graph needs esbuild bundling under type stripping.
const { probeWebSearchCredential, resolveWebSearchApiKey, WebSearchError } = await importTestBundle(
  "src/agent-host/web-search/credentials",
  {
    packages: "external",
    absWorkingDir: root,
    stdin: {
      contents: `
        export { probeWebSearchCredential, resolveWebSearchApiKey } from "./credentials.ts";
        export { WebSearchError } from "./client.ts";
      `,
      resolveDir: import.meta.dirname,
      loader: "ts",
    },
  },
);

const settings = { enabled: true, providerId: "deepseek", apiKeyOverride: "", maxResults: 5, timeoutMs: 20_000 };

test("an explicit override wins over the provider credential", async () => {
  const resolved = await resolveWebSearchApiKey(
    { ...settings, apiKeyOverride: "sk-override" },
    async () => "sk-provider",
  );
  assert.deepEqual(resolved, { apiKey: "sk-override", source: "override" });
});

test("the provider credential is used when no override is set", async () => {
  const resolved = await resolveWebSearchApiKey(settings, async () => " sk-provider ");
  assert.deepEqual(resolved, { apiKey: "sk-provider", source: "provider" });
});

test("a missing provider key fails with an actionable configuration error", async () => {
  await assert.rejects(
    () => resolveWebSearchApiKey(settings, async () => undefined),
    (error) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "NOT_CONFIGURED");
      assert.match(error.message, /Settings → Models/);
      return true;
    },
  );
});

test("the credential probe reports override, provider and none without throwing", async () => {
  assert.equal(
    await probeWebSearchCredential({ ...settings, apiKeyOverride: "sk" }, async () => undefined),
    "override",
  );
  assert.equal(await probeWebSearchCredential(settings, async () => "sk"), "provider");
  assert.equal(await probeWebSearchCredential(settings, async () => undefined), "none");
});
