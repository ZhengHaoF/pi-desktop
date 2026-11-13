import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const { ApprovalBridge } = await importTestBundle("approval-bridge", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: 'export { ApprovalBridge } from "./approval-bridge.ts";',
  },
});

function observe(bridge, data, key = "session-1") {
  bridge.observeEvent({ kind: "event", topic: "agent.events", key, data });
}

test("mirrors confirm requests to the remote plane", () => {
  const sent = [];
  const bridge = new ApprovalBridge((envelope) => sent.push(envelope));
  observe(bridge, {
    type: "extension_ui_request",
    id: "ui-1",
    method: "confirm",
    title: "Allow?",
    message: "Details",
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.topic, "remote.approval");
  assert.equal(sent[0].payload.data.method, "confirm");
  assert.equal(sent[0].payload.data.options, undefined);
  assert.equal(bridge.pendingCount(), 1);
});

test("mirrors ask questions with their options so phones can answer them", () => {
  const sent = [];
  const bridge = new ApprovalBridge((envelope) => sent.push(envelope));
  const questions = [
    {
      header: "Auth",
      question: "Which auth?",
      options: [{ label: "OAuth", description: "Browser" }, { label: "Key" }],
    },
    { question: "Scopes?", options: [{ label: "Read" }], multiSelect: true },
  ];
  observe(bridge, { type: "extension_ui_request", id: "ui-2", method: "ask", questions });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.data.method, "ask");
  assert.deepEqual(sent[0].payload.data.questions, questions);
  assert.equal(bridge.pendingCount(), 1);
  assert.deepEqual(
    bridge.buildResponseCommand("ui-2", { answers: [{ question: "Which auth?", selected: ["OAuth"] }] }),
    {
      sessionId: "session-1",
      command: {
        type: "extension_ui_response",
        id: "ui-2",
        answers: [{ question: "Which auth?", selected: ["OAuth"] }],
      },
    },
  );
});

test("ignores fire-and-forget extension UI methods", () => {
  const sent = [];
  const bridge = new ApprovalBridge((envelope) => sent.push(envelope));
  for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "custom", "resolved"])
    observe(bridge, { type: "extension_ui_request", id: `ui-${method}`, method, message: "x" });
  assert.deepEqual(sent, []);
  assert.equal(bridge.pendingCount(), 0);
});

test("replays only the unresolved dialogs of one session to a late subscriber", () => {
  const bridge = new ApprovalBridge(() => {});
  observe(bridge, { type: "extension_ui_request", id: "a", method: "confirm", title: "A" });
  observe(bridge, { type: "extension_ui_request", id: "b", method: "ask", questions: [] }, "session-2");
  assert.deepEqual(
    bridge.pendingFor("session-1").map((entry) => entry.requestId),
    ["a"],
  );
  assert.deepEqual(
    bridge.pendingFor("session-2").map((entry) => entry.requestId),
    ["b"],
  );
  assert.deepEqual(bridge.pendingFor("unknown"), []);
});

test("a resolved signal drops the pending request and mirrors the closure", () => {
  const sent = [];
  const bridge = new ApprovalBridge((envelope) => sent.push(envelope));
  observe(bridge, { type: "extension_ui_request", id: "ui-3", method: "confirm", title: "Allow?" });
  const before = sent.length;
  observe(bridge, { type: "extension_ui_request", id: "wrapper", method: "resolved", requestId: "ui-3" });
  assert.equal(bridge.pendingCount(), 0);
  assert.deepEqual(
    sent.slice(before).map((entry) => entry.payload.data),
    [{ requestId: "ui-3", sessionId: "session-1", resolved: true }],
  );
  // A repeated resolved signal must not mirror again.
  observe(bridge, { type: "extension_ui_request", id: "wrapper-2", method: "resolved", requestId: "ui-3" });
  assert.equal(sent.length, before + 1);
});

test("stopping a session aborts its pending approvals", () => {
  const decisions = [];
  const bridge = new ApprovalBridge(() => {});
  bridge.onDecision((decision) => decisions.push(decision));
  observe(bridge, { type: "extension_ui_request", id: "ui-4", method: "confirm", title: "Allow?" });
  observe(bridge, { type: "extension_ui_request", id: "ui-5", method: "ask", questions: [] });
  bridge.abortSession("session-1");
  assert.deepEqual(
    decisions.map((decision) => [decision.requestId, decision.outcome]),
    [
      ["ui-4", "aborted"],
      ["ui-5", "aborted"],
    ],
  );
  assert.equal(bridge.pendingCount(), 0);
});
