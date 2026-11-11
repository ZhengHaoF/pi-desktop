import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { installDomTestEnvironment, inlinePortalPlugin } from "./ui/dom-test-env.mjs";
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
    inlinePortalPlugin,
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
  const dom = installDomTestEnvironment();
  api.state.calls.length = 0;
  api.state.preset = "default";
  let renderer;
  await act(async () => {
    renderer = create(createElement(DefaultToolPresetSetting), {
      createNodeMock: () => ({
        getBoundingClientRect: () => ({ top: 100, left: 40, width: 180, bottom: 136 }),
        contains: () => false,
        scrollIntoView: () => {},
        focus: () => {},
      }),
    });
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
    dom.restore();
  });
  const trigger = () => renderer.root.findByProps({ "aria-haspopup": "listbox" });
  const value = () => trigger().props.children[0].props.children;
  const choose = async (label) => {
    await act(async () => trigger().props.onClick());
    const option = renderer.root
      .findAll((node) => node.type === "div" && node.props.role === "option")
      .find((node) => node.props.children.at(-1) === label);
    await act(async () => option.props.onClick());
  };
  assert.equal(value(), "Standard");
  assert.match(JSON.stringify(renderer.toJSON()), /Existing sessions keep their saved tool selection/);
  await choose("Full access");
  assert.equal(value(), "Full access");
  assert.deepEqual(api.state.calls.at(-1), { method: "settings.setDefaultToolPreset", params: { preset: "full" } });
  api.state.fail = true;
  await choose("Read only");
  assert.equal(value(), "Full access");
  assert.match(JSON.stringify(renderer.root.findByProps({ role: "alert" }).children), /could not be saved/);
});
