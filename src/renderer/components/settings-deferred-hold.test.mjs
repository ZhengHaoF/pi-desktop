import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { installDomTestEnvironment, inlinePortalPlugin } from "./ui/dom-test-env.mjs";

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const dom = installDomTestEnvironment();
after(() => dom.restore());
// Dialog takes the animated path only with a real matchMedia; the DOM stub
// has none, so provide one that never reports reduced motion. i18n's module
// init reads navigator/localStorage through the same stubbed window, and the
// wrapper's open-edge focus capture instanceof-checks HTMLElement.
globalThis.window.matchMedia = (query) => ({ matches: !query.includes("reduce") });
globalThis.window.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.window.navigator = { language: "en-US" };
globalThis.HTMLElement = class HTMLElement {};

const { SettingsConfig, DIALOG_EXIT_MS } = await importTestBundle("settings-deferred-hold", {
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "tsx",
    // Swap the real settings panel for a probe that mounts the real ui/Dialog
    // shell, so the wrapper's hold behavior and the exit classes are both
    // observable without pulling the whole panel graph into the bundle.
    contents: 'export { SettingsConfig } from "./DeferredPanels"; export { DIALOG_EXIT_MS } from "./ui/dialog-motion";',
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react/jsx-runtime"],
  plugins: [
    inlinePortalPlugin,
    {
      name: "settings-hold-stubs",
      setup(build) {
        // Wrapper-internal imports that must not drag in the real panel
        // (the dynamic preload imports "./SettingsConfig" without extension).
        // Virtual stubs resolve "./ui/Dialog" against their own (nonexistent)
        // directory, so alias it to the real component first.
        build.onResolve({ filter: /^\.\/ui\/Dialog$/ }, () => ({
          path: path.join(import.meta.dirname, "ui/Dialog.tsx"),
        }));
        build.onResolve({ filter: /^\.\/SettingsConfig(\.tsx)?$/ }, () => ({
          path: "probe",
          namespace: "settings-hold-test",
        }));
        build.onLoad({ filter: /^probe$/, namespace: "settings-hold-test" }, () => ({
          contents: `
            import { Dialog } from "./ui/Dialog";
            export function SettingsConfig({ open }) {
              return (
                <Dialog open={open} ariaLabel="probe">
                  <div data-probe="panel" />
                </Dialog>
              );
            }
          `,
          loader: "jsx",
        }));
        // Panel-independent renderer globals used by the wrapper graph.
        build.onResolve({ filter: /^@\/(i18n|hooks\/useIsMobile)$/ }, ({ path }) => ({
          path,
          namespace: "settings-hold-test",
        }));
        build.onLoad({ filter: /.*/, namespace: "settings-hold-test" }, ({ path }) => ({
          contents:
            path === "@/i18n"
              ? "const t = (key, fallback) => fallback; export function useI18n() { return { t: t, language: 'en-US', setLanguage: function () {} }; }"
              : "export function useIsMobile() { return false; }",
          loader: "js",
        }));
      },
    },
  ],
});

const baseProps = {
  open: true,
  cwd: null,
  onClose() {},
  onModelsChanged() {},
  onPluginsReloaded() {},
  onChannelsChanged() {},
  chatAppearance: {},
  chatAppearanceSaving: false,
  onChatAppearanceChange() {},
};

const withOpen = (open) => ({ ...baseProps, open });

const findProbeCard = (root) => {
  try {
    return root.find((node) => node.props.role === "dialog");
  } catch {
    return null;
  }
};

test("closing holds the panel mounted through the exit fade, then drops it", async (t) => {
  let renderer;
  await act(async () => {
    renderer = create(createElement(SettingsConfig, withOpen(true)));
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
  });
  assert.ok(findProbeCard(renderer.root), "panel mounted while open");

  // Close: the panel stays mounted through the fade and the Dialog shell
  // switched to its exit state (the exit class only applies with open=false).
  await act(async () => renderer.update(createElement(SettingsConfig, withOpen(false))));
  const card = findProbeCard(renderer.root);
  assert.ok(card, "panel held through the exit");
  assert.match(card.props.className ?? "", /pi-dialog-card-exit/);

  // After the fade the whole subtree drops.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, DIALOG_EXIT_MS + 150));
  });
  assert.equal(renderer.toJSON(), null, "panel unmounted after the exit fade");
});

test("reopening mid-fade cancels the drop and flips the panel back to open", async (t) => {
  let renderer;
  await act(async () => {
    renderer = create(createElement(SettingsConfig, withOpen(true)));
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
  });

  await act(async () => renderer.update(createElement(SettingsConfig, withOpen(false))));
  assert.ok(findProbeCard(renderer.root), "held during fade");

  await act(async () => renderer.update(createElement(SettingsConfig, withOpen(true))));
  const card = findProbeCard(renderer.root);
  assert.ok(card, "still mounted after reopen");
  assert.match(card.props.className ?? "", /pi-dialog-card-enter/, "Dialog back in enter state (open=true)");

  // The hold was cancelled: no delayed unmount fires.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, DIALOG_EXIT_MS + 150));
  });
  assert.ok(findProbeCard(renderer.root), "reopen cancelled the scheduled drop");
});

test("module-independent open cycles keep working when the chunk resolves late", async (t) => {
  // The wrapper resolves the deferred chunk by hand; with the probe panel
  // already in the graph the module is present from the first render, so this
  // cycle exercises the held-open handshake (preload effect gated on hold)
  // rather than the loading frame.
  let renderer;
  await act(async () => {
    renderer = create(createElement(SettingsConfig, withOpen(true)));
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
  });
  assert.ok(findProbeCard(renderer.root), "panel renders when the chunk is cached");

  await act(async () => renderer.update(createElement(SettingsConfig, withOpen(false))));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, DIALOG_EXIT_MS + 150));
  });
  assert.equal(renderer.toJSON(), null, "drop after fade clears the held panel");

  await act(async () => renderer.update(createElement(SettingsConfig, withOpen(true))));
  assert.ok(findProbeCard(renderer.root), "next open cycle mounts the panel again");
});
