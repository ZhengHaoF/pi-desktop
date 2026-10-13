import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";
import { isEmptyAbortedAssistantTurn, omitEmptyAbortedAssistantTurn } from "./aborted-turn-omission.ts";

const { AgentSessionWrapper } = await importTestBundle("pi-aborted-turn-omission", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "rpc-manager.ts")],
});

function assistantTurn(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    stopReason: "error",
    errorMessage: "This operation was aborted",
    timestamp: Date.now(),
    ...overrides,
  };
}

test("only empty aborted assistant turns are omission candidates", () => {
  assert.equal(isEmptyAbortedAssistantTurn(assistantTurn()), true);
  assert.equal(isEmptyAbortedAssistantTurn(assistantTurn({ stopReason: "aborted" })), true);
  assert.equal(isEmptyAbortedAssistantTurn(assistantTurn({ errorMessage: "The operation was aborted" })), true);
  assert.equal(isEmptyAbortedAssistantTurn(assistantTurn({ errorMessage: "Request was aborted" })), true);

  // A partial answer keeps its content and must stay in the model context.
  assert.equal(
    isEmptyAbortedAssistantTurn(assistantTurn({ content: [{ type: "text", text: "half a thought" }] })),
    false,
  );
  // Ordinary failures are not aborts.
  assert.equal(isEmptyAbortedAssistantTurn(assistantTurn({ errorMessage: "rate limited" })), false);
  assert.equal(isEmptyAbortedAssistantTurn(assistantTurn({ stopReason: "stop" })), false);
  // Only assistant turns.
  assert.equal(isEmptyAbortedAssistantTurn({ role: "user", content: "" }), false);
  assert.equal(isEmptyAbortedAssistantTurn(assistantTurn({ role: "toolResult" })), false);
  assert.equal(isEmptyAbortedAssistantTurn(null), false);
  assert.equal(isEmptyAbortedAssistantTurn("aborted"), false);
});

test("omitting an aborted turn drops it from the projection but keeps it in the session file", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-aborted-turn-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, directory);
  manager.appendMessage({ role: "user", content: "first question", timestamp: Date.now() });
  const answered = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "first answer" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const aborted = manager.appendMessage(assistantTurn());

  const editId = omitEmptyAbortedAssistantTurn(manager, manager.getEntry(aborted).message);
  assert.equal(typeof editId, "string");

  // The model no longer sees the silent turn...
  const projected = manager.buildSessionProjection().messages;
  assert.equal(
    projected.some((message) => message.role === "assistant" && message.content.length === 0),
    false,
  );
  assert.equal(
    projected.some((message) => message.role === "assistant" && message.content.length > 0),
    true,
  );
  // ...while the session file keeps it, so the UI still renders the abort.
  const branch = manager.getBranch();
  assert.equal(
    branch.some((entry) => entry.id === aborted),
    true,
  );
  assert.equal(
    branch.some((entry) => entry.id === answered),
    true,
  );
  assert.equal(branch.filter((entry) => entry.type === "context_edit").length, 1);

  // Re-running the omission is a no-op instead of stacking edits.
  assert.equal(omitEmptyAbortedAssistantTurn(manager, manager.getEntry(aborted).message), null);
  assert.equal(manager.getBranch().filter((entry) => entry.type === "context_edit").length, 1);
});

test("omission leaves ordinary turns and unknown messages alone", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-aborted-turn-skip-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, directory);
  manager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
  const answered = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    stopReason: "stop",
    timestamp: Date.now(),
  });

  assert.equal(omitEmptyAbortedAssistantTurn(manager, manager.getEntry(answered).message), null);
  assert.equal(omitEmptyAbortedAssistantTurn(manager, { role: "assistant", content: [] }), null);
  assert.equal(
    manager.getBranch().some((entry) => entry.type === "context_edit"),
    false,
  );
  assert.equal(manager.buildSessionProjection().messages.length, 2);
});

test("the wrapper omits the silent aborted turn from the model projection", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-aborted-turn-live-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ defaultTools: [], cacheWarming: "off" }),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });
  await services.modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-key");
  const model = services.modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(directory, directory),
    model,
    tools: [],
  });
  await session.bindExtensions({ mode: "rpc" });

  const requests = [];
  session.agent.streamFunction = (requestModel, context) => {
    requests.push(context);
    const stream = createAssistantMessageEventStream();
    void Promise.resolve().then(() => {
      // The failure shape the SDK produces when a run is aborted: an assistant
      // turn that says nothing and carries only the abort reason.
      stream.push({
        type: "error",
        reason: "error",
        error: assistantTurn({
          api: requestModel.api,
          provider: requestModel.provider,
          model: requestModel.id,
        }),
      });
      stream.end();
    });
    return stream;
  };

  const wrapper = new AgentSessionWrapper(session, [], () => undefined);
  t.after(async () => {
    await wrapper.dispose({ abort: false });
  });
  wrapper.start();
  const waitForDone = (runId) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`prompt ${runId} did not finish`)), 5000);
      const unsubscribe = wrapper.onEvent((event) => {
        if (event.type !== "prompt_done" || event.clientRunId !== runId) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });
    });

  await wrapper.send({ type: "prompt", message: "start work", clientRunId: 80 });
  await waitForDone(80);
  // The omission runs after the SDK persists the aborted turn.
  await new Promise((resolve) => setImmediate(resolve));

  const branch = wrapper.inner.sessionManager.getBranch();
  const abortedEntries = branch.filter(
    (entry) => entry.type === "message" && isEmptyAbortedAssistantTurn(entry.message),
  );
  assert.equal(abortedEntries.length, 1, "the fixture did not produce the silent aborted turn");
  assert.equal(
    branch.some((entry) => entry.type === "context_edit" && entry.targetId === abortedEntries[0].id),
    true,
    "the aborted turn was not omitted",
  );
  // The session file keeps the turn, so the UI still renders the abort.
  assert.equal(branch.filter((entry) => entry.type === "message").length >= 2, true);

  const silentTurnsInContext = (context) =>
    (context?.messages ?? []).filter((message) => message.role === "assistant" && message.content.length === 0).length;
  await wrapper.send({ type: "prompt", message: "continue", clientRunId: 81 });
  await waitForDone(81);
  assert.equal(silentTurnsInContext(requests.at(-1)), 0, "the aborted turn survived into the model context");
});
