import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
const { DefaultToolPresetSetting, api } = await importTestBundle("default-tool-preset-setting-ui", {
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "tsx",
    contents:
      'export {DefaultToolPresetSetting} from "./settings/DefaultToolPresetSetting.tsx";export * as api from "@/lib/api-client";',
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react"],
  plugins: [
    {
      name: "default-preset-setting-api",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/api-client$/ }, () => ({
          path: "api",
          namespace: "default-preset-setting-test",
        }));
        build.onLoad({ filter: /.*/, namespace: "default-preset-setting-test" }, () => ({
          contents:
            'export const state={preset:"default",fail:false,calls:[]};export async function call(method,params){state.calls.push({method,params});if(state.fail)throw new Error("failed");if(params)state.preset=params.preset;return {preset:state.preset};}',
        }));
      },
    },
  ],
});

test("settings persist one default preset, explain the new-session scope and retain the saved value after failure", async (t) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  api.state.calls.length = 0;
  api.state.preset = "default";
  let renderer;
  await act(async () => {
    renderer = create(createElement(DefaultToolPresetSetting));
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
    if (before) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", before);
    else delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  const select = () => renderer.root.findByType("select");
  assert.equal(select().props.value, "default");
  assert.deepEqual(
    renderer.root.findAllByType("option").map((option) => option.props.value),
    ["none", "default", "full"],
  );
  assert.match(JSON.stringify(renderer.toJSON()), /Existing sessions keep their saved tool selection/);
  await act(async () => select().props.onChange({ target: { value: "full" } }));
  assert.equal(select().props.value, "full");
  assert.deepEqual(api.state.calls.at(-1), { method: "settings.setDefaultToolPreset", params: { preset: "full" } });
  api.state.fail = true;
  await act(async () => select().props.onChange({ target: { value: "none" } }));
  assert.equal(select().props.value, "full");
  assert.match(JSON.stringify(renderer.root.findByProps({ role: "alert" }).children), /could not be saved/);
});
