import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement, useState } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
const { useNewSessionDefaultPreset, api } = await importTestBundle("new-session-default-preset", {
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents:
      'export {useNewSessionDefaultPreset} from "./useNewSessionDefaultPreset.ts";export * as api from "@/lib/api-client";',
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react"],
  plugins: [
    {
      name: "default-preset-api",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/api-client$/ }, () => ({ path: "api", namespace: "default-preset-test" }));
        build.onLoad({ filter: /.*/, namespace: "default-preset-test" }, () => ({
          contents: `
      export const state={calls:[],preset:"none",gate:null};
      export async function call(method){state.calls.push(method);const value={preset:state.preset};if(state.gate)await state.gate;return value;}`,
        }));
      },
    },
  ],
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("new sessions adopt the desktop default once it loads; an explicit pick wins and existing sessions never fetch", async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  api.state.calls.length = 0;
  api.state.preset = "none";
  const gate = deferred();
  api.state.gate = gate.promise;
  let latest = null;
  function Fixture({ isNew }) {
    const [preset, setPreset] = useState("default");
    const defaultPreset = useNewSessionDefaultPreset(isNew, setPreset);
    latest = { preset, ...defaultPreset };
    return null;
  }
  let renderer;
  await act(async () => {
    renderer = create(createElement(Fixture, { isNew: true }));
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
    if (saved) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", saved);
    else delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  assert.equal(latest.preset, "default", "the read must not block the first render");
  const pending = latest.resolve("default");
  assert.equal(latest.preset, "default");
  await act(async () => {
    gate.resolve();
    api.state.gate = null;
  });
  assert.equal(await pending, "none");
  assert.equal(latest.preset, "none");
  assert.deepEqual(api.state.calls, ["settings.getDefaultToolPreset"]);

  latest.markChosen();
  api.state.preset = "full";
  await act(async () => renderer.update(createElement(Fixture, { isNew: true })));
  assert.equal(latest.preset, "none");
  assert.equal(await latest.resolve("default"), "default", "a manual choice bypasses the loaded default");

  api.state.calls.length = 0;
  await act(async () => renderer.update(createElement(Fixture, { isNew: false })));
  assert.equal(await latest.resolve("full"), "full");
  assert.deepEqual(api.state.calls, [], "existing sessions keep their stored selection");
});
