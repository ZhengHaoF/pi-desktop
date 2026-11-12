import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { Switch } = await importTestBundle("src/renderer/components/ui/switch", {
  stdin: {
    contents: 'export { Switch } from "./Switch.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "switch-test-entry.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
});

function renderSwitch(props) {
  return renderToStaticMarkup(createElement(Switch, { "aria-label": "Enable", ...props }));
}

test("renders the switch pattern with role and checked state", () => {
  const on = renderSwitch({ checked: true, onChange() {} });
  assert.match(on, /role="switch"/);
  assert.match(on, /aria-checked="true"/);
  assert.match(on, /class="pi-btn pi-switch"/);
  assert.match(on, /background:var\(--accent\)/);
  const off = renderSwitch({ checked: false, onChange() {} });
  assert.match(off, /aria-checked="false"/);
  assert.match(off, /background:var\(--border\)/);
});

test("knob slides via left offset between 3px and 21px", () => {
  const on = renderSwitch({ checked: true, onChange() {} });
  assert.match(on, /left:21px/);
  const off = renderSwitch({ checked: false, onChange() {} });
  assert.match(off, /left:3px/);
});

test("loading renders busy cursor, dimmed track and disabled button", () => {
  const html = renderSwitch({ checked: true, loading: true, onChange() {} });
  assert.match(html, /cursor:wait/);
  assert.match(html, /opacity:0\.65/);
  assert.match(html, /disabled/);
});

test("disabled passes through to the underlying button", () => {
  const html = renderSwitch({ checked: false, disabled: true, onChange() {} });
  assert.match(html, /disabled/);
});

test("aria-label and title pass through", () => {
  const html = renderSwitch({ checked: true, onChange() {}, title: "Enable plugin" });
  assert.match(html, /aria-label="Enable"/);
  assert.match(html, /title="Enable plugin"/);
});
