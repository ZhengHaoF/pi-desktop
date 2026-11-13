import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement, Fragment } from "react";
import { act, create } from "react-test-renderer";

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const { ConfirmDialog, useConfirm } = await importTestBundle("src/renderer/components/ui/confirm-dialog", {
  stdin: {
    contents: 'export { ConfirmDialog, useConfirm } from "./ConfirmDialog.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "confirm-dialog-test-entry.tsx",
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  plugins: [
    {
      name: "confirm-dialog-portal-stub",
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

const text = (node) => (typeof node === "string" ? node : (node?.children?.map(text).join("") ?? ""));
const hostButtons = (root) => root.findAll((node) => node.type === "button");
// variant lives on the composite <Button> instance; the host <button> only
// carries the derived className.
const compositeButton = (root, label) =>
  root.findAll((node) => typeof node.type === "function" && text(node) === label);

test("renders title, message, cancel and confirm; each button settles its callback", async () => {
  let closed = 0;
  let confirmed = 0;
  let renderer;
  await act(async () => {
    renderer = create(
      createElement(ConfirmDialog, {
        open: true,
        onClose: () => closed++,
        onConfirm: () => confirmed++,
        title: "Delete session?",
        message: "Messages will be removed.",
      }),
    );
  });
  try {
    const card = text(renderer.root.find((node) => node.props.role === "dialog"));
    assert.match(card, /Delete session\?/);
    assert.match(card, /Messages will be removed\./);
    const labels = () => hostButtons(renderer.root).map((button) => text(button));
    assert.deepEqual(labels(), ["Cancel", "Confirm"]);
    await act(async () => hostButtons(renderer.root)[0].props.onClick());
    assert.equal(closed, 1);
    assert.equal(confirmed, 0);
    await act(async () => hostButtons(renderer.root)[1].props.onClick());
    assert.equal(confirmed, 1);
    assert.equal(closed, 1);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("danger confirms render the danger variant; custom labels win over defaults", async () => {
  let renderer;
  await act(async () => {
    renderer = create(
      createElement(ConfirmDialog, {
        open: true,
        onClose() {},
        onConfirm() {},
        title: "Delete account?",
        message: "Bindings go away too.",
        confirmLabel: "Delete",
        cancelLabel: "Keep",
        danger: true,
      }),
    );
  });
  try {
    const [cancel, confirm] = hostButtons(renderer.root);
    assert.equal(text(cancel), "Keep");
    assert.equal(text(confirm), "Delete");
    assert.equal(compositeButton(renderer.root, "Delete")[0].props.variant, "danger");
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("cancelLabel null switches to alert style: a single acknowledgement button", async () => {
  let confirmed = 0;
  let renderer;
  await act(async () => {
    renderer = create(
      createElement(ConfirmDialog, {
        open: true,
        onClose() {},
        onConfirm: () => confirmed++,
        title: "Session is running",
        message: "Stop it before deleting.",
        cancelLabel: null,
      }),
    );
  });
  try {
    const buttons = hostButtons(renderer.root);
    assert.deepEqual(
      buttons.map((button) => text(button)),
      ["OK"],
    );
    assert.equal(compositeButton(renderer.root, "OK")[0].props.variant, "default");
    await act(async () => buttons[0].props.onClick());
    assert.equal(confirmed, 1);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("useConfirm resolves true on confirm, false on cancel", async () => {
  const results = [];
  function Harness() {
    const { confirm, dialog } = useConfirm();
    return createElement(
      Fragment,
      null,
      createElement(
        "button",
        {
          id: "ask",
          onClick: () => void confirm({ title: "Proceed?", danger: true }).then((value) => results.push(value)),
        },
        "Ask",
      ),
      dialog,
    );
  }
  let renderer;
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  try {
    await act(async () => hostButtons(renderer.root)[0].props.onClick());
    assert.deepEqual(results, []);
    const confirmButton = hostButtons(renderer.root).find((button) => text(button) === "Confirm");
    assert.ok(confirmButton, "confirm dialog opened by the hook");
    // The harness requests danger: true; the hook forwards it to the dialog.
    assert.equal(compositeButton(renderer.root, "Confirm")[0].props.variant, "danger");
    await act(async () => {
      confirmButton.props.onClick();
      await Promise.resolve();
    });
    assert.deepEqual(results, [true]);

    await act(async () => hostButtons(renderer.root)[0].props.onClick());
    const cancelButton = hostButtons(renderer.root).find((button) => text(button) === "Cancel");
    await act(async () => {
      cancelButton.props.onClick();
      await Promise.resolve();
    });
    assert.deepEqual(results, [true, false]);
  } finally {
    await act(async () => renderer.unmount());
  }
});
