import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { installDomTestEnvironment, inlinePortalPlugin } from "./ui/dom-test-env.mjs";
const { AgentShellSetting, api } = await importTestBundle("agent-shell-setting-ui", {
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "tsx",
    contents: 'export {AgentShellSetting} from "./AgentShellSetting.tsx";export * as api from "@/lib/api-client";',
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react"],
  plugins: [
    inlinePortalPlugin,
    {
      name: "shell-setting-api",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/api-client$/ }, () => ({ path: "api", namespace: "shell-setting-test" }));
        build.onLoad({ filter: /.*/, namespace: "shell-setting-test" }, () => ({
          contents:
            'export const state={shell:"powershell",fail:false,calls:[]};export async function call(method,params){state.calls.push({method,params});if(state.fail)throw new Error("failed");if(params)state.shell=params.shell;return {platform:"win32",shell:state.shell};}',
        }));
      },
    },
  ],
});
test("settings offer one persisted shell, explain new-session scope and retain the saved value after failure", async (t) => {
  const dom = installDomTestEnvironment();
  const state = {
    platform: "win32",
    capabilities: { "shell.bash": { health: "healthy" }, "shell.powershell": { health: "healthy" } },
  };
  let renderer;
  await act(async () => {
    renderer = create(createElement(AgentShellSetting, { state }), {
      createNodeMock: () => ({
        getBoundingClientRect: () => ({ top: 100, left: 40, width: 180, bottom: 136 }),
        closest: () => null,
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
  assert.equal(value(), "PowerShell");
  assert.equal(renderer.root.findAllByType("input").length, 0);
  assert.match(JSON.stringify(renderer.toJSON()), /Existing sessions keep their shell/);
  await choose("Bash");
  assert.equal(value(), "Bash");
  assert.deepEqual(api.state.calls.at(-1), { method: "settings.setAgentShell", params: { shell: "bash" } });
  await act(async () => renderer.unmount());
  await act(async () => {
    renderer = create(createElement(AgentShellSetting, { state }), {
      createNodeMock: () => ({
        getBoundingClientRect: () => ({ top: 100, left: 40, width: 180, bottom: 136 }),
        closest: () => null,
        contains: () => false,
        scrollIntoView: () => {},
        focus: () => {},
      }),
    });
  });
  assert.equal(value(), "Bash");
  api.state.fail = true;
  await choose("PowerShell");
  assert.equal(value(), "Bash");
  assert.match(JSON.stringify(renderer.root.findByProps({ role: "alert" }).children), /could not be saved/);
  await act(async () =>
    renderer.update(
      createElement(AgentShellSetting, {
        state: { ...state, capabilities: { ...state.capabilities, "shell.powershell": { health: "missing" } } },
      }),
    ),
  );
  await act(async () => trigger().props.onClick());
  const powershell = renderer.root
    .findAll((node) => node.type === "div" && node.props.role === "option")
    .find((node) => node.props.children.at(-1) === "PowerShell");
  assert.equal(powershell.props["aria-disabled"], true);
});
