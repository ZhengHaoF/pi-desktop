import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { Input, Textarea } = await importTestBundle("src/renderer/components/ui/input", {
  stdin: {
    contents: 'export { Input } from "./Input.tsx"; export { Textarea } from "./Textarea.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "input-test-entry.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
});

function renderInput(props) {
  return renderToStaticMarkup(createElement(Input, { ...props }));
}

test("Input carries the shared pi-input class and form density by default", () => {
  const html = renderInput({ value: "x", onChange() {} });
  assert.match(html, /class="pi-input"/);
  assert.match(html, /min-height:36px/);
  assert.match(html, /font-size:13px/);
  assert.match(html, /width:100%/);
});

test("compact size shrinks the row for sidebar filters", () => {
  const html = renderInput({ size: "sm", value: "x", onChange() {} });
  assert.match(html, /min-height:26px/);
  assert.match(html, /font-size:12px/);
  assert.match(html, /padding:4px 8px/);
});

test("invalid and mono toggle the corresponding class and font", () => {
  assert.match(renderInput({ invalid: true, value: "", onChange() {} }), /pi-input pi-input-invalid/);
  assert.match(renderInput({ mono: true, value: "", onChange() {} }), /font-family:var\(--font-mono\)/);
});

test("native attributes and caller style pass through; caller style wins", () => {
  const html = renderInput({
    value: "x",
    onChange() {},
    disabled: true,
    placeholder: "Search…",
    "aria-label": "Filter sessions",
    style: { width: 160, minHeight: 28 },
  });
  assert.match(html, /disabled/);
  assert.match(html, /placeholder="Search…"/);
  assert.match(html, /aria-label="Filter sessions"/);
  assert.match(html, /width:160px/);
  assert.match(html, /min-height:28px/);
});

test("Textarea defaults to mono and keeps prose opt-out", () => {
  const mono = renderToStaticMarkup(createElement(Textarea, { value: "", onChange() {} }));
  assert.match(mono, /class="pi-input"/);
  assert.match(mono, /font-family:var\(--font-mono\)/);
  assert.match(mono, /min-height:80px/);
  assert.match(mono, /resize:vertical/);
  const prose = renderToStaticMarkup(createElement(Textarea, { mono: false, value: "", onChange() {} }));
  assert.doesNotMatch(prose, /font-family/);
});
