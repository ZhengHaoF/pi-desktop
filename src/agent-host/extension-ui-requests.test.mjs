import assert from "node:assert/strict";
import test from "node:test";
import { extensionUiResolvedRequest, normalizeExtensionUiResponse } from "./extension-ui-requests.ts";

test("keeps a flat renderer response as is", () => {
  const flat = { type: "extension_ui_response", id: "r1", confirmed: true };
  assert.deepEqual(normalizeExtensionUiResponse(flat), flat);
  const answers = { type: "extension_ui_response", id: "r2", answers: [] };
  assert.deepEqual(normalizeExtensionUiResponse(answers), answers);
});

test("unwraps the response body remote clients send", () => {
  const command = { type: "extension_ui_response", id: "r3", response: { confirmed: true } };
  assert.deepEqual(normalizeExtensionUiResponse(command), {
    type: "extension_ui_response",
    id: "r3",
    confirmed: true,
  });
  const withAnswers = {
    type: "extension_ui_response",
    id: "r4",
    response: { answers: [{ question: "Q?", selected: ["A"] }] },
  };
  assert.deepEqual(normalizeExtensionUiResponse(withAnswers), {
    type: "extension_ui_response",
    id: "r4",
    answers: [{ question: "Q?", selected: ["A"] }],
  });
});

test("the wrapper id wins and non-object bodies are ignored", () => {
  assert.equal(
    normalizeExtensionUiResponse({ type: "extension_ui_response", id: "outer", response: { cancelled: true } }).id,
    "outer",
  );
  const primitive = { type: "extension_ui_response", id: "r5", response: "plain" };
  assert.deepEqual(normalizeExtensionUiResponse(primitive), primitive);
  const array = { type: "extension_ui_response", id: "r6", response: [] };
  assert.deepEqual(normalizeExtensionUiResponse(array), array);
});

test("resolved broadcasts name the wrapper request it closes", () => {
  assert.deepEqual(extensionUiResolvedRequest("wrapper-1", "ask-1"), {
    type: "extension_ui_request",
    id: "wrapper-1",
    method: "resolved",
    requestId: "ask-1",
  });
});
