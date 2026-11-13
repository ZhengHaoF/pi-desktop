import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { installDomTestEnvironment, inlinePortalPlugin } from "./ui/dom-test-env.mjs";

const { AskUserDialog } = await importTestBundle("ask-user-dialog-ui", {
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "tsx",
    contents: 'export { AskUserDialog } from "./AskUserDialog.tsx";',
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react"],
  plugins: [inlinePortalPlugin],
});

const createNodeMock = () => ({
  focus() {},
  contains: () => false,
  style: {},
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0 }),
});

function flatten(children) {
  if (children === null || children === undefined || children === false) return "";
  if (Array.isArray(children)) return children.map(flatten).join("");
  if (typeof children === "object" && children.props) return flatten(children.props.children);
  return String(children);
}

function renderDialog(request) {
  const responses = [];
  let renderer;
  return {
    responses,
    get renderer() {
      return renderer;
    },
    async mount() {
      await act(async () => {
        renderer = create(
          createElement(AskUserDialog, { request, onRespond: (_request, response) => responses.push(response) }),
          { createNodeMock },
        );
      });
    },
    async unmount() {
      if (renderer) await act(async () => renderer.unmount());
    },
    buttons() {
      return renderer.root.findAll((node) => node.type === "button");
    },
    button(label) {
      const match = this.buttons().find((node) => flatten(node.props.children).startsWith(label));
      assert.ok(match, `button ${label} should render`);
      return match;
    },
  };
}

const questions = [
  {
    header: "Auth method",
    question: "Which authentication should the client use?",
    options: [{ label: "OAuth", description: "Browser login" }, { label: "API key" }],
  },
  {
    header: "Scopes",
    question: "Which scopes are needed?",
    options: [{ label: "Read" }, { label: "Write" }],
    multiSelect: true,
  },
];

const request = { type: "extension_ui_request", id: "ask-1", method: "ask", questions };

test("collects one answer per question and submits them in order", async (t) => {
  const dom = installDomTestEnvironment();
  const dialog = renderDialog(request);
  t.after(async () => {
    await dialog.unmount();
    dom.restore();
  });
  await dialog.mount();

  assert.match(JSON.stringify(dialog.renderer.toJSON()), /Browser login/);
  assert.equal(dialog.button("Submit").props.disabled, true);

  await act(async () => dialog.button("OAuth").props.onClick());
  assert.equal(dialog.button("OAuth").props["aria-pressed"], true);
  assert.equal(dialog.button("Submit").props.disabled, true);

  await act(async () => dialog.button("Read").props.onClick());
  await act(async () => dialog.button("Write").props.onClick());
  assert.equal(dialog.button("Read").props["aria-pressed"], true);
  assert.equal(dialog.button("Write").props["aria-pressed"], true);
  assert.equal(dialog.button("Submit").props.disabled, false);

  await act(async () => dialog.button("Submit").props.onClick());
  assert.deepEqual(dialog.responses, [
    {
      answers: [
        { header: "Auth method", question: questions[0].question, selected: ["OAuth"] },
        { header: "Scopes", question: questions[1].question, selected: ["Read", "Write"] },
      ],
    },
  ]);
});

test("single-select replaces the choice and Other answers in free text", async (t) => {
  const dom = installDomTestEnvironment();
  const single = {
    type: "extension_ui_request",
    id: "ask-2",
    method: "ask",
    questions: [
      {
        header: "Target",
        question: "Where should this deploy?",
        options: [{ label: "Staging" }, { label: "Production" }],
      },
    ],
  };
  const dialog = renderDialog(single);
  t.after(async () => {
    await dialog.unmount();
    dom.restore();
  });
  await dialog.mount();

  await act(async () => dialog.button("Staging").props.onClick());
  await act(async () => dialog.button("Production").props.onClick());
  assert.equal(dialog.button("Staging").props["aria-pressed"], false);
  assert.equal(dialog.button("Production").props["aria-pressed"], true);

  // Choosing Other clears the picked option so the answer is unambiguous.
  await act(async () => dialog.button("Other…").props.onClick());
  assert.equal(dialog.button("Production").props["aria-pressed"], false);
  const inputs = dialog.renderer.root.findAll((node) => node.type === "input");
  assert.equal(inputs.length, 1);
  assert.equal(dialog.button("Submit").props.disabled, true);

  await act(async () => inputs[0].props.onChange({ target: { value: "Local ring" } }));
  assert.equal(dialog.button("Submit").props.disabled, false);
  await act(async () => dialog.button("Submit").props.onClick());
  assert.deepEqual(dialog.responses, [
    {
      answers: [{ header: "Target", question: "Where should this deploy?", selected: [], other: "Local ring" }],
    },
  ]);
});

test("cancelling answers the request as dismissed", async (t) => {
  const dom = installDomTestEnvironment();
  const dialog = renderDialog(request);
  t.after(async () => {
    await dialog.unmount();
    dom.restore();
  });
  await dialog.mount();
  await act(async () => dialog.button("Cancel").props.onClick());
  assert.deepEqual(dialog.responses, [{ cancelled: true }]);
});

test("toggling Other off clears the typed text so Submit locks again", async (t) => {
  const dom = installDomTestEnvironment();
  const dialog = renderDialog({
    type: "extension_ui_request",
    id: "ask-3",
    method: "ask",
    questions: [{ question: "Scope?", options: [{ label: "Read" }, { label: "Write" }], multiSelect: true }],
  });
  t.after(async () => {
    await dialog.unmount();
    dom.restore();
  });
  await dialog.mount();
  await act(async () => dialog.button("Other…").props.onClick());
  const input = () => dialog.renderer.root.findByType("input");
  await act(async () => input().props.onChange({ target: { value: "Admin" } }));
  assert.equal(dialog.button("Submit").props.disabled, false);
  // Selecting an option alongside Other keeps both for a multi-select question.
  await act(async () => dialog.button("Read").props.onClick());
  assert.equal(dialog.button("Other…").props["aria-pressed"], true);
  await act(async () => dialog.button("Other…").props.onClick());
  assert.equal(dialog.button("Other…").props["aria-pressed"], false);
  assert.equal(dialog.renderer.root.findAll((node) => node.type === "input").length, 0);
  assert.equal(dialog.button("Submit").props.disabled, false);
  await act(async () => dialog.button("Submit").props.onClick());
  assert.deepEqual(dialog.responses, [{ answers: [{ question: "Scope?", selected: ["Read"] }] }]);
});
