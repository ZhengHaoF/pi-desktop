import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { Checkbox } = await importTestBundle("src/renderer/components/ui/checkbox", {
  stdin: {
    contents: 'export { Checkbox } from "./Checkbox.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "checkbox-test-entry.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
});

function renderCheckbox(props) {
  return renderToStaticMarkup(createElement(Checkbox, { ...props }));
}

test("Checkbox renders a native input carrying the shared pi-checkbox class", () => {
  const html = renderCheckbox({ checked: true, onChange() {} });
  assert.match(html, /<input[^>]*type="checkbox"/);
  assert.match(html, /class="pi-checkbox"/);
  assert.match(html, /checked/);
});

test("sizes map to 18px default and 15px compact", () => {
  assert.match(renderCheckbox({ checked: false, onChange() {} }), /width:18px;height:18px/);
  assert.match(renderCheckbox({ checked: false, size: "sm", onChange() {} }), /width:15px;height:15px/);
});

test("checked passes through and label wraps the box in an implicit label", () => {
  const labeled = renderCheckbox({ checked: false, onChange() {}, label: "Enable X" });
  assert.match(labeled, /<label[^>]*><input[^>]*type="checkbox"/);
  assert.match(labeled, /Enable X/);
  const bare = renderCheckbox({ checked: false, onChange() {} });
  assert.match(bare, /^<input/);
});

test("native attributes pass through for explicit association", () => {
  const html = renderCheckbox({
    checked: false,
    onChange() {},
    id: "auto-updates",
    disabled: true,
    "aria-label": "Enable automatic checks",
    "aria-describedby": "auto-updates-desc",
  });
  assert.match(html, /id="auto-updates"/);
  assert.match(html, /disabled/);
  assert.match(html, /aria-label="Enable automatic checks"/);
  assert.match(html, /aria-describedby="auto-updates-desc"/);
});

test("caller style wins over the size default", () => {
  const html = renderCheckbox({ checked: false, onChange() {}, style: { width: 15, height: 15 } });
  assert.match(html, /width:15px;height:15px/);
});
