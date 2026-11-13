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

test("track geometry: Button's min-height preset must not inflate the pill", () => {
  const html = renderSwitch({ checked: false, onChange() {} });
  const minHeight = Number(/min-height:(\d+(?:\.\d+)?)px/.exec(html)?.[1] ?? 0);
  const height = Number(/(?:^|;)height:(\d+(?:\.\d+)?)px/.exec(html)?.[1] ?? 0);
  assert.ok(height > 0, "track height must be declared");
  assert.ok(
    minHeight <= height,
    `min-height ${minHeight}px exceeds track height ${height}px — Button preset leaks into the switch`,
  );
  // Knob centers vertically via transform so it stays centered whatever the
  // track height resolves to.
  assert.match(html, /top:50%/);
  assert.match(html, /transform:translateY\(-50%\)/);
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
