import assert from "node:assert/strict";
import test from "node:test";

import { getPresetFromTools, getToolNamesForPreset, PRESET_DEFAULT, PRESET_FULL } from "./tool-presets.ts";
import { WEB_SEARCH_TOOL_NAMES } from "./web-search.ts";

const tools = (activeNames) =>
  PRESET_FULL.map((name) => ({ name, description: name, active: activeNames.includes(name) }));

test("tool preset detection distinguishes none, default, full, and custom built-ins", () => {
  assert.equal(getPresetFromTools(tools([])), "none");
  assert.equal(getPresetFromTools(tools(PRESET_DEFAULT)), "default");
  assert.equal(getPresetFromTools(tools(PRESET_FULL)), "full");
  assert.equal(getPresetFromTools(tools(["read"])), "custom");
  assert.equal(getPresetFromTools(tools(PRESET_FULL.filter((name) => name !== "codemode"))), "custom");
  assert.ok(getToolNamesForPreset("full").includes("codemode"));
  assert.ok(getToolNamesForPreset("full").includes("tool_search"));
});

test("preset tool arrays are defensive copies", () => {
  const selected = getToolNamesForPreset("full");
  selected.pop();
  assert.deepEqual(getToolNamesForPreset("full"), PRESET_FULL);
  assert.deepEqual(getToolNamesForPreset("none"), []);
});

test("web tools join the full preset only while explicitly available", () => {
  // Without availability information (channel presets, plain calls) they stay out.
  assert.deepEqual(getToolNamesForPreset("full"), PRESET_FULL);
  assert.ok(!getToolNamesForPreset("full", []).some((name) => WEB_SEARCH_TOOL_NAMES.includes(name)));

  const available = [
    { name: "web_search", available: true },
    { name: "web_fetch", available: false },
  ];
  const full = getToolNamesForPreset("full", available);
  assert.ok(full.includes("web_search"));
  assert.ok(!full.includes("web_fetch"));

  // A session whose selection already contains web tools still detects as full.
  const selected = [...PRESET_FULL, ...WEB_SEARCH_TOOL_NAMES];
  assert.equal(getPresetFromTools(selected.map((name) => ({ name, description: name, active: true }))), "full");
});
