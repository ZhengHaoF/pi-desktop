import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { ToolPresetPreferences, isSelectableToolPreset } = await importTestBundle("tool-preset-settings", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents:
      'export {ToolPresetPreferences} from "./tool-preset-settings.ts";export {isSelectableToolPreset} from "../shared/tool-presets.ts";',
  },
});

test("default tool preset persists, defaults to standard and rejects custom or unreadable state", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-tool-preset-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "default-tool-preset.json"),
    prefs = new ToolPresetPreferences(file);
  assert.deepEqual(prefs.get(), { preset: "default" });
  prefs.set("none");
  assert.deepEqual(new ToolPresetPreferences(file).get(), { preset: "none" });
  prefs.set("full");
  assert.deepEqual(new ToolPresetPreferences(file).get(), { preset: "full" });
  assert.throws(() => prefs.set("custom"));
  assert.equal(isSelectableToolPreset("custom"), false);
  assert.equal(isSelectableToolPreset(undefined), false);
  writeFileSync(file, "broken");
  assert.throws(() => prefs.get());
  writeFileSync(file, JSON.stringify({ version: 2, preset: "none" }));
  assert.throws(() => prefs.get());
});
