import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { EnlargableImage } = await importTestBundle("image-lightbox", {
  stdin: {
    contents: 'export { EnlargableImage, ImageLightbox } from "./ImageLightbox.tsx";',
    resolveDir: import.meta.dirname,
    loader: "tsx",
  },
  tsconfig: path.resolve(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom"],
  plugins: [
    {
      name: "i18n-and-portal",
      setup(build) {
        build.onResolve({ filter: /^@\/i18n$|^react-dom$/ }, ({ path }) => ({ path, namespace: "image-lightbox" }));
        build.onLoad({ filter: /.*/, namespace: "image-lightbox" }, ({ path }) => ({
          contents:
            path === "react-dom"
              ? "export const createPortal = (children) => children;"
              : "export const useI18n=()=>({t:(_key,fallback)=>fallback});",
        }));
      },
    },
  ],
});

function fakeEvent(overrides = {}) {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    ...overrides,
  };
}

async function mountImage(props) {
  const saved = new Map(
    ["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const windowListeners = new Map();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.document = { body: {} };
  globalThis.window = {
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      windowListeners.get(type)?.delete(listener);
    },
  };
  let renderer;
  await act(async () => {
    renderer = create(createElement(EnlargableImage, props));
  });
  return {
    renderer,
    windowListeners,
    async cleanup() {
      await act(async () => renderer.unmount());
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else delete globalThis[key];
      }
    },
  };
}

test("clicking a message image opens the full-size preview", async (t) => {
  const { renderer, cleanup } = await mountImage({ src: "data:image/png;base64,aGVsbG8=", alt: "shot" });
  t.after(cleanup);
  const img = renderer.root.findByType("img");
  assert.equal(img.props.src, "data:image/png;base64,aGVsbG8=");
  assert.equal(img.props.style.cursor, "zoom-in");
  assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
  await act(async () => img.props.onClick(fakeEvent()));
  const dialog = renderer.root.findByProps({ role: "dialog" });
  assert.equal(dialog.props["aria-modal"], "true");
  assert.equal(dialog.props["aria-label"], "Image preview");
  const preview = dialog.findAllByType("img")[0];
  assert.equal(preview.props.src, "data:image/png;base64,aGVsbG8=");
});

test("the preview closes on Escape, backdrop click, and the close button", async (t) => {
  const { renderer, windowListeners, cleanup } = await mountImage({
    src: "data:image/png;base64,aGVsbG8=",
  });
  t.after(cleanup);
  await act(async () => renderer.root.findByType("img").props.onClick(fakeEvent()));
  assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 1);

  // Escape key removes its own listener on close.
  await act(async () => {
    for (const listener of windowListeners.get("keydown") ?? []) listener({ key: "Escape" });
  });
  assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
  assert.equal((windowListeners.get("keydown") ?? new Set()).size, 0);

  // Backdrop click closes; clicking the preview itself does not.
  await act(async () => renderer.root.findByType("img").props.onClick(fakeEvent()));
  const dialog = renderer.root.findByProps({ role: "dialog" });
  await act(async () => dialog.findAllByType("img")[0].props.onClick(fakeEvent()));
  assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 1);
  await act(async () => renderer.root.findByProps({ role: "dialog" }).props.onClick(fakeEvent()));
  assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);

  // Close button.
  await act(async () => renderer.root.findByType("img").props.onClick(fakeEvent()));
  const closeButton = renderer.root.findByProps({ "aria-label": "Close" });
  await act(async () => closeButton.props.onClick());
  assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
});

test("Enter/Space on a focused image opens the preview", async (t) => {
  const { renderer, cleanup } = await mountImage({ src: "data:image/png;base64,aGVsbG8=" });
  t.after(cleanup);
  const img = renderer.root.findByType("img");
  assert.equal(img.props.tabIndex, 0);
  await act(async () => img.props.onKeyDown(fakeEvent({ key: "Enter" })));
  assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 1);
  await act(async () => renderer.root.findByProps({ role: "dialog" }).props.onClick(fakeEvent()));
  await act(async () => img.props.onKeyDown(fakeEvent({ key: " " })));
  assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 1);
});

test("images without a src are inert", async (t) => {
  const { renderer, cleanup } = await mountImage({ src: "", alt: "" });
  t.after(cleanup);
  await act(async () => renderer.root.findByType("img").props.onClick(fakeEvent()));
  assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
});

test("a caller-provided onClick still runs and can veto the preview", async (t) => {
  const calls = [];
  const { renderer, cleanup } = await mountImage({
    src: "data:image/png;base64,aGVsbG8=",
    onClick: (event) => {
      calls.push("click");
      event.preventDefault();
    },
  });
  t.after(cleanup);
  await act(async () => renderer.root.findByType("img").props.onClick(fakeEvent()));
  assert.deepEqual(calls, ["click"]);
  assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
});
