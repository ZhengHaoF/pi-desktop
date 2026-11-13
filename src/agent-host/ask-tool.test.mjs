import assert from "node:assert/strict";
import test from "node:test";
import { ASK_QUESTION_TOOL_NAME, MAX_ASK_QUESTIONS, createAskQuestionTool } from "./ask-tool.ts";

const questions = [
  {
    header: "Auth method",
    question: "Which authentication should the client use?",
    options: [{ label: "OAuth" }, { label: "API key" }],
  },
  {
    header: "Scopes",
    question: "Which scopes are needed?",
    options: [{ label: "Read" }, { label: "Write" }],
    multiSelect: true,
  },
];

function execute(ui, signal) {
  return createAskQuestionTool().execute("call-1", { questions }, signal, undefined, { hasUI: true, ui });
}

test("declares a sequential model-facing tool that asks with options", () => {
  const tool = createAskQuestionTool();
  assert.equal(tool.name, ASK_QUESTION_TOOL_NAME);
  assert.equal(tool.executionMode, "sequential");
  assert.match(tool.description, /multiple-choice questions/);
});

test("returns the dialog answers in request order", async () => {
  const answers = [
    { header: "Auth method", question: questions[0].question, selected: ["OAuth"] },
    { header: "Scopes", question: questions[1].question, selected: ["Read", "Write"], other: "Admin" },
  ];
  let received;
  const result = await execute({
    askQuestions: async (asked, options) => {
      received = { asked, options };
      return answers;
    },
  });
  assert.deepEqual(received.asked, questions);
  assert.equal(received.options.signal, undefined);
  assert.deepEqual(result.details.answered, answers);
  assert.match(result.content[0].text, /Auth method: Which authentication.*→ OAuth/);
  assert.match(result.content[0].text, /Read, Write \| Other: Admin/);
});

test("reports a dismissed dialog without failing the tool", async () => {
  const result = await execute({ askQuestions: async () => undefined });
  assert.equal(result.details.cancelled, true);
  assert.equal(result.details.answered, null);
  assert.match(result.content[0].text, /dismissed the questions/);
});

test("falls back to select and input when the host has no ask dialog", async () => {
  const calls = [];
  let step = 0;
  const result = await execute({
    select: async (title, options) => {
      calls.push(["select", title, options]);
      step += 1;
      if (step === 1) return "API key";
      if (step === 2) return "Read";
      return "Done";
    },
    input: async (title) => {
      calls.push(["input", title]);
      return "typed key";
    },
  });
  assert.equal(result.details.answered[0].selected[0], "API key");
  assert.deepEqual(result.details.answered[1].selected, ["Read"]);
  assert.match(calls[0][2].join(","), /API key,Other \(type my own answer\)/);
  assert.equal(
    calls.some(([kind]) => kind === "input"),
    false,
  );
});

test("fails with guidance when the session has no interactive UI", async () => {
  await assert.rejects(
    createAskQuestionTool().execute("call-1", { questions }, undefined, undefined, { hasUI: false, ui: {} }),
    /ASK_QUESTION_UNAVAILABLE: no interactive UI/,
  );
});

test("treats an aborted turn as an unanswered question", async () => {
  const controller = new globalThis.AbortController();
  controller.abort();
  const result = await execute({ askQuestions: async () => undefined }, controller.signal);
  assert.equal(result.details.cancelled, true);
  assert.match(result.content[0].text, /turn stopped/);
});

test("allows five questions, one per dialog row", () => {
  const tool = createAskQuestionTool();
  const schema = tool.parameters.properties.questions;
  assert.equal(schema.minItems, 1);
  assert.equal(schema.maxItems, MAX_ASK_QUESTIONS);
  assert.equal(MAX_ASK_QUESTIONS, 5);
});
