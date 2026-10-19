import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSearchSettingsStore } from "./settings.ts";
import { WEB_SEARCH_DEFAULTS } from "../../shared/web-search.ts";

function store() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-search-settings-")), "web-search.json");
  return { file, store: new WebSearchSettingsStore(file) };
}

test("a missing file yields defaults without failing", () => {
  const { store: settings } = store();
  assert.deepEqual(settings.get(), WEB_SEARCH_DEFAULTS);
  assert.equal(settings.hasLoadFailed(), true);
});

test("a corrupt file degrades to defaults and a successful patch clears the failure", async () => {
  const { file, store: settings } = store();
  fs.writeFileSync(file, "{ not json", "utf8");
  assert.deepEqual(settings.get(), WEB_SEARCH_DEFAULTS);
  assert.equal(settings.hasLoadFailed(), true);

  const saved = await settings.patch({ enabled: true, maxResults: 3 });
  assert.equal(saved.enabled, true);
  assert.equal(saved.maxResults, 3);
  assert.equal(settings.hasLoadFailed(), false);

  const reloaded = new WebSearchSettingsStore(file);
  assert.deepEqual(reloaded.get(), saved);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("patch merges into the persisted state and serializes concurrent writes", async () => {
  const { file, store: settings } = store();
  await settings.patch({ enabled: true, apiKeyOverride: "sk-one" });
  const [second, third] = await Promise.all([settings.patch({ maxResults: 7 }), settings.patch({ timeoutMs: 30_000 })]);
  assert.equal(second.maxResults, 7);
  assert.equal(third.timeoutMs, 30_000);

  const merged = new WebSearchSettingsStore(file).get();
  assert.equal(merged.enabled, true);
  assert.equal(merged.apiKeyOverride, "sk-one");
  assert.equal(merged.maxResults, 7);
  assert.equal(merged.timeoutMs, 30_000);
});
