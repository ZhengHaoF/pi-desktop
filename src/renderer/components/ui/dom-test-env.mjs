/**
 * Shared test-environment helpers for component tests that exercise ui/Select
 * and ui/Dialog. Select portals its option list via react-dom and registers
 * document listeners while open; Dialog locks body scroll via body.style.
 * Bundles need a DOM-ish global mock and a portal stub for
 * react-test-renderer to see the portaled children.
 */
export function installDomTestEnvironment() {
  const saved = new Map(
    ["window", "document", "ResizeObserver", "requestAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const documentListeners = new Map(),
    windowListeners = new Map();
  const surface = (listeners) => ({
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  });
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: {
      ...surface(documentListeners),
      // Dialog's scroll lock reads and restores body.style.overflow.
      body: { style: { overflow: "" } },
      createElement: () => ({ style: {}, focus() {} }),
      activeElement: null,
      querySelectorAll: () => [],
    },
    window: {
      ...surface(windowListeners),
      innerHeight: 800,
      innerWidth: 1200,
      visualViewport: null,
      requestAnimationFrame: (cb) => cb(),
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  return {
    documentListeners,
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

/** esbuild plugin: inline portal children so react-test-renderer renders them. */
export const inlinePortalPlugin = {
  name: "inline-react-dom-portal",
  setup(build) {
    build.onResolve({ filter: /^react-dom$/ }, () => ({ path: "react-dom-stub", namespace: "dom-stub" }));
    build.onLoad({ filter: /.*/, namespace: "dom-stub" }, () => ({
      contents: "export const createPortal = (children) => children;",
    }));
  },
};
