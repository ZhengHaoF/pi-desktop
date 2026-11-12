import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { StatusDot } = await importTestBundle("src/renderer/components/ui/status-dot", {
  stdin: {
    contents: 'export { StatusDot } from "./StatusDot.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "status-dot-test-entry.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
});

function renderDot(props) {
  return renderToStaticMarkup(createElement(StatusDot, { ...props }));
}

test("renders a presentational span with the shared class and default size/color", () => {
  const html = renderDot({});
  assert.match(html, /<span[^>]*role="presentation"/);
  assert.match(html, /class="pi-status-dot"/);
  assert.match(html, /width:8px;height:8px/);
  assert.match(html, /background:var\(--text-dim\)/);
});

test("semantic color names map to tokens; unknown values pass through raw", () => {
  assert.match(renderDot({ color: "success" }), /background:var\(--success\)/);
  assert.match(renderDot({ color: "danger" }), /background:var\(--danger\)/);
  assert.match(renderDot({ color: "#16a34a" }), /background:#16a34a/);
});

test("sm size renders 6px", () => {
  assert.match(renderDot({ size: "sm" }), /width:6px;height:6px/);
});

test("pulse toggles the data attribute driving the shared animation", () => {
  assert.match(renderDot({ pulse: true }), /data-pulse="true"/);
  assert.doesNotMatch(renderDot({}), /data-pulse/);
});

test("title and className pass through", () => {
  const html = renderDot({ title: "Running", className: "extra" });
  assert.match(html, /title="Running"/);
  assert.match(html, /class="pi-status-dot extra"/);
});
