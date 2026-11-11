import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { Button } = await importTestBundle("src/renderer/components/ui/button", {
  stdin: {
    contents: 'export { Button } from "./Button.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "button-test-entry.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
});

function renderButton(props) {
  return renderToStaticMarkup(createElement(Button, { ...props }, "Label"));
}

test("Button maps each variant onto the shared pi-btn classes", () => {
  assert.match(renderButton({}), /class="pi-btn"/);
  assert.match(renderButton({ variant: "primary" }), /class="pi-btn pi-btn-primary"/);
  assert.match(renderButton({ variant: "danger" }), /class="pi-btn pi-btn-danger"/);
  assert.match(renderButton({ variant: "ghost" }), /class="pi-btn pi-btn-ghost"/);
  assert.match(renderButton({ variant: "link" }), /class="pi-btn pi-btn-link"/);
  assert.match(renderButton({ variant: "dashed" }), /class="pi-btn pi-btn-dashed"/);
});

test("Button defaults to type=button and forwards native attributes", () => {
  const html = renderButton({ disabled: true, title: "Close", "aria-label": "Close tab" });
  assert.match(html, /type="button"/);
  assert.match(html, /disabled/);
  assert.match(html, /title="Close"/);
  assert.match(html, /aria-label="Close tab"/);
});

test("pressed maps to aria-pressed so the shared toggle styles apply", () => {
  assert.match(renderButton({ pressed: true }), /aria-pressed="true"/);
  assert.match(renderButton({ pressed: false }), /aria-pressed="false"/);
  assert.doesNotMatch(renderButton({}), /aria-pressed/);
});

test("sizes expose the shared layout defaults", () => {
  assert.match(renderButton({}), /min-height:32px/);
  assert.match(renderButton({ size: "sm" }), /min-height:26px/);
  assert.match(renderButton({ size: "icon" }), /width:32px;height:32px/);
  assert.match(renderButton({ size: "icon" }), /padding:0;/);
});

test("block stretches the button and caller style wins over defaults", () => {
  assert.match(renderButton({ block: true }), /width:100%/);
  const overridden = renderButton({ size: "md", style: { minHeight: 44, padding: "9px 14px" } });
  assert.match(overridden, /min-height:44px/);
  assert.match(overridden, /padding:9px 14px/);
});

test("caller className is appended after the variant classes", () => {
  assert.match(renderButton({ variant: "ghost", className: "extra" }), /class="pi-btn pi-btn-ghost extra"/);
});
