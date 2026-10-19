import assert from "node:assert/strict";
import test from "node:test";
import {
  isWebSearchToolName,
  normalizeWebSearchSettings,
  WEB_SEARCH_DEFAULTS,
  WEB_SEARCH_LIMITS,
} from "./web-search.ts";

test("defaults keep web search off and reuse the deepseek provider", () => {
  assert.deepEqual(normalizeWebSearchSettings(undefined), WEB_SEARCH_DEFAULTS);
  assert.equal(WEB_SEARCH_DEFAULTS.enabled, false);
  assert.equal(WEB_SEARCH_DEFAULTS.providerId, "deepseek");
});

test("normalization clamps ranges, trims keys and drops unknown fields", () => {
  const settings = normalizeWebSearchSettings({
    enabled: "yes",
    providerId: "  deepseek  ",
    apiKeyOverride: "  sk-test  ",
    maxResults: 99,
    timeoutMs: 1,
    unknown: "ignored",
  });
  assert.equal(settings.enabled, false);
  assert.equal(settings.providerId, "deepseek");
  assert.equal(settings.apiKeyOverride, "sk-test");
  assert.equal(settings.maxResults, WEB_SEARCH_LIMITS.maxResults.max);
  assert.equal(settings.timeoutMs, WEB_SEARCH_LIMITS.timeoutMs.min);
  assert.equal("unknown" in settings, false);
});

test("web search tool names are recognized", () => {
  assert.equal(isWebSearchToolName("web_search"), true);
  assert.equal(isWebSearchToolName("web_fetch"), true);
  assert.equal(isWebSearchToolName("grep"), false);
});
