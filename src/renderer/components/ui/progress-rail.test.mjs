import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { ProgressRail } = await importTestBundle("progress-rail-ui", {
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "tsx",
    contents: 'export { ProgressRail } from "./ProgressRail.tsx";',
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  external: ["react"],
});

/** Collect text from a react-test-renderer JSON tree (node.children, not props). */
function flatten(children) {
  if (children === null || children === undefined || children === false) return "";
  if (Array.isArray(children)) return children.map(flatten).join("");
  if (typeof children === "object") return flatten(children.children);
  return String(children);
}

test("renders one node per item; completed glyphs carry the check, only in-progress pulses", async () => {
  const items = [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }, { status: "completed" }];
  let renderer;
  await act(async () => {
    renderer = create(createElement(ProgressRail, { items }));
  });
  const json = renderer.toJSON();
  assert.ok(json, "the rail must render");
  assert.equal(flatten(json.children).replace(/\s+/g, " ").trim(), "✓✓");

  // Only the in-progress node carries the pulsing class.
  const pulsing = renderer.root.findAll((node) => node.props.className === "rail-node-active");
  assert.equal(pulsing.length, 1);
});

test("an empty item list renders nothing", async () => {
  let renderer;
  await act(async () => {
    renderer = create(createElement(ProgressRail, { items: [] }));
  });
  assert.equal(renderer.toJSON(), null);
});
