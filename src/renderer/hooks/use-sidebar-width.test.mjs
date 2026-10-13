import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { useSidebarWidth } = await importTestBundle("sidebar-width-hook", {
  entryPoints: [path.join(import.meta.dirname, "useSidebarWidth.ts")],
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
});

const SIDEBAR_WIDTH_STORAGE_KEY = "pi-desktop:sidebar-width:v1";

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? new Set();
      values.add(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, value) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(value);
    },
    count() {
      return [...listeners.values()].reduce((total, values) => total + values.size, 0);
    },
  };
}

function createLocalStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

function createWindow({ innerWidth = 1514, storage = {} } = {}) {
  return Object.assign(eventTarget(), {
    innerWidth,
    localStorage: createLocalStorage(storage),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
}

function mount(t, options) {
  const originals = new Map();
  const install = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const window = createWindow(options);
  const document = { body: { style: {} } };
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("window", window);
  install("document", document);

  let latest;
  function Probe() {
    latest = useSidebarWidth();
    return null;
  }
  let renderer;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return {
    window,
    document,
    get controls() {
      return latest;
    },
    async render() {
      await act(async () => {
        renderer = create(createElement(Probe));
      });
    },
  };
}

function pointerEvent(clientX, button = 0) {
  return { button, clientX, preventDefault() {} };
}

test("initial width comes from storage and is clamped to the viewport", async (t) => {
  const wide = await mount(t, { innerWidth: 1514, storage: { [SIDEBAR_WIDTH_STORAGE_KEY]: "400" } });
  await wide.render();
  assert.equal(wide.controls.sidebarWidth, 400);
});

test("a stored width beyond the viewport limit is clamped on first render", async (t) => {
  const narrow = await mount(t, { innerWidth: 700, storage: { [SIDEBAR_WIDTH_STORAGE_KEY]: "600" } });
  await narrow.render();
  assert.equal(narrow.controls.sidebarWidth, 350);
});

test("an unusable stored width falls back to the default", async (t) => {
  const stored = await mount(t, { innerWidth: 1514, storage: { [SIDEBAR_WIDTH_STORAGE_KEY]: "12" } });
  await stored.render();
  assert.equal(stored.controls.sidebarWidth, 280);
});

test("dragging the separator resizes both directions and persists on pointer up", async (t) => {
  const fixture = await mount(t, { innerWidth: 1514, storage: { [SIDEBAR_WIDTH_STORAGE_KEY]: "300" } });
  await fixture.render();
  const { window, document } = fixture;

  await act(async () => fixture.controls.startSidebarResize(pointerEvent(100)));
  assert.equal(fixture.controls.sidebarResizing, true);
  assert.equal(document.body.style.cursor, "col-resize");
  assert.equal(document.body.style.userSelect, "none");

  await act(async () => window.emit("pointermove", { clientX: 160 }));
  assert.equal(fixture.controls.sidebarWidth, 360);

  await act(async () => window.emit("pointermove", { clientX: 130 }));
  assert.equal(fixture.controls.sidebarWidth, 330);

  await act(async () => window.emit("pointerup", { clientX: 130 }));
  assert.equal(fixture.controls.sidebarResizing, false);
  assert.equal(document.body.style.cursor, "");
  assert.equal(document.body.style.userSelect, "");
  assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY), "330");
  assert.equal(window.count(), 1); // only the viewport fit listener remains
});

test("drag width is clamped to the sidebar bounds", async (t) => {
  const fixture = await mount(t, { innerWidth: 1514 });
  await fixture.render();
  const { window } = fixture;

  await act(async () => fixture.controls.startSidebarResize(pointerEvent(100)));
  await act(async () => window.emit("pointermove", { clientX: 5_000 }));
  assert.equal(fixture.controls.sidebarWidth, 480);
  await act(async () => window.emit("pointerup", { clientX: 5_000 }));

  await act(async () => fixture.controls.startSidebarResize(pointerEvent(100)));
  await act(async () => window.emit("pointermove", { clientX: -5_000 }));
  assert.equal(fixture.controls.sidebarWidth, 240);
  await act(async () => window.emit("pointerup", { clientX: -5_000 }));
  assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY), "240");
});

test("a cancelled drag restores nothing and keeps the previous preference", async (t) => {
  const fixture = await mount(t, { innerWidth: 1514, storage: { [SIDEBAR_WIDTH_STORAGE_KEY]: "300" } });
  await fixture.render();
  const { window, document } = fixture;

  await act(async () => fixture.controls.startSidebarResize(pointerEvent(100)));
  await act(async () => window.emit("pointermove", { clientX: 200 }));
  assert.equal(fixture.controls.sidebarWidth, 400);

  await act(async () => window.emit("pointercancel", { clientX: 200 }));
  assert.equal(fixture.controls.sidebarResizing, false);
  assert.equal(document.body.style.cursor, "");
  assert.equal(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY), "300");
});

test("non-primary buttons do not start a drag", async (t) => {
  const fixture = await mount(t, { innerWidth: 1514 });
  await fixture.render();
  const { window, document } = fixture;
  const baseline = window.count();

  await act(async () => fixture.controls.startSidebarResize(pointerEvent(100, 2)));
  assert.equal(fixture.controls.sidebarResizing, false);
  assert.equal(window.count(), baseline);
  assert.ok(!document.body.style.cursor, "cursor must stay unset");
});

test("a narrower viewport pulls an over-wide sidebar back into bounds", async (t) => {
  const fixture = await mount(t, { innerWidth: 1514, storage: { [SIDEBAR_WIDTH_STORAGE_KEY]: "480" } });
  await fixture.render();
  const { window } = fixture;

  window.innerWidth = 500;
  await act(async () => window.emit("resize"));
  assert.equal(fixture.controls.sidebarWidth, 250);

  window.innerWidth = 1514;
  await act(async () => window.emit("resize"));
  assert.equal(fixture.controls.sidebarWidth, 480);
});
