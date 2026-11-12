import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const { Dialog } = await importTestBundle("src/renderer/components/ui/dialog", {
  stdin: {
    contents: 'export { Dialog } from "./Dialog.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "dialog-test-entry.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  plugins: [
    {
      name: "dialog-portal-stub",
      setup(build) {
        // Inline portal children so react-test-renderer sees the card.
        build.onResolve({ filter: /^react-dom$/ }, () => ({ path: "react-dom-stub", namespace: "dialog-stub" }));
        build.onLoad({ filter: /.*/, namespace: "dialog-stub" }, () => ({
          contents: "export const createPortal = (children) => children;",
        }));
      },
    },
  ],
});

const documentListeners = new Map();
let bodyOverflow = "";

// Minimal DOM: only what the scroll lock and capture keydown need. The portal
// itself is stubbed in the bundle (children inlined), so no container is needed.
Object.assign(globalThis, {
  document: {
    addEventListener: (t, l) => {
      if (!documentListeners.has(t)) documentListeners.set(t, new Set());
      documentListeners.get(t).add(l);
    },
    removeEventListener: (t, l) => documentListeners.get(t)?.delete(l),
    body: {
      style: {
        get overflow() {
          return bodyOverflow;
        },
        set overflow(value) {
          bodyOverflow = value;
        },
      },
    },
    createElement: () => ({ style: {}, focus() {} }),
    activeElement: null,
    querySelectorAll: () => [],
  },
});

const backdrop = (root) => root.find((node) => node.props.style?.position === "fixed" && node.props.style?.inset === 0);
const card = (root) => root.find((node) => node.props.role === "dialog");

test("renders backdrop and card with aria wiring when open, nothing when closed", async (t) => {
  let renderer;
  let closed = 0;
  await act(async () => {
    renderer = create(createElement(Dialog, { open: true, onClose: () => closed++, ariaLabel: "Confirm" }, "Body"));
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
  });
  assert.equal(backdrop(renderer.root).props.style.background, "rgba(0,0,0,0.38)");
  const dialog = card(renderer.root);
  assert.equal(dialog.props["aria-modal"], "true");
  assert.equal(dialog.props["aria-label"], "Confirm");
  // Body scroll lock active while open.
  assert.equal(bodyOverflow, "hidden");
  await act(async () => renderer.update(createElement(Dialog, { open: false, onClose: () => closed++ }, "Body")));
  assert.equal(renderer.toJSON(), null);
  assert.equal(bodyOverflow, "");
});

test("closeOnBackdrop=false keeps backdrop clicks inert", async (t) => {
  let renderer;
  let closed = 0;
  await act(async () => {
    renderer = create(createElement(Dialog, { open: true, onClose: () => closed++, closeOnBackdrop: false }, "Body"));
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
  });
  await act(async () => backdrop(renderer.root).props.onClick({ target: backdrop(renderer.root) }));
  assert.equal(closed, 0);
});

test("Escape closes via the capture keydown listener; closeOnEscape=false leaves it to the caller", async (t) => {
  let closed = 0;
  let renderer;
  await act(async () => {
    renderer = create(createElement(Dialog, { open: true, onClose: () => closed++ }, "Body"));
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
  });
  const escape = { key: "Escape", preventDefault() {}, stopPropagation() {} };
  for (const listener of documentListeners.get("keydown")) listener(escape);
  assert.equal(closed, 1);

  let escaped = 0;
  await act(async () =>
    renderer.update(createElement(Dialog, { open: true, onClose: () => escaped++, closeOnEscape: false }, "Body")),
  );
  for (const listener of documentListeners.get("keydown")) listener(escape);
  assert.equal(escaped, 0);
});

test("Tab reaches the trap listener; ref-less environments exit through the guard", async (t) => {
  let renderer;
  await act(async () => {
    renderer = create(
      createElement(
        Dialog,
        { open: true, onClose() {}, ariaLabel: "Trap" },
        createElement("button", { key: "first" }, "First"),
        createElement("button", { key: "last" }, "Last"),
      ),
    );
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
  });
  // The trap queries the card via cardRef; react-test-renderer without
  // createNodeMock yields null refs, so the trap exits through its guard.
  // Cycling itself is exercised by the settings shell at the app level.
  let prevented = 0;
  const tab = {
    key: "Tab",
    shiftKey: false,
    preventDefault() {
      prevented++;
    },
    stopPropagation() {},
  };
  for (const listener of documentListeners.get("keydown")) listener(tab);
  assert.equal(prevented, 0);
});
