import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const { AgentSessionWrapper } = await importTestBundle("pi-steer-idle-fallback", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: 'export {AgentSessionWrapper} from "./rpc-manager.ts";',
  },
});

/**
 * Bypass the constructor (it wires real SDK services). `send()` only needs
 * these fields; TS `private` members are plain properties after bundling.
 * The fake inner records which command actually reached the agent.
 */
function makeWrapper({ streaming = false } = {}) {
  const calls = [];
  const inner = {
    sessionId: "fixture-session",
    isStreaming: streaming,
    isCompacting: false,
    async prompt(message, options) {
      calls.push({ kind: "prompt", message, options });
    },
    async steer(message) {
      calls.push({ kind: "steer", message });
    },
    async followUp(message) {
      calls.push({ kind: "followUp", message });
    },
  };
  const wrapper = Object.create(AgentSessionWrapper.prototype);
  Object.assign(wrapper, {
    inner,
    listeners: [],
    _alive: true,
    promptRunning: false,
    queuedTurnCount: 0,
    turnTail: Promise.resolve(),
    forceEmptySystemPrompt: false,
    modelSelection: { assertReady: () => {} },
    modelConfig: { sync: async () => {} },
  });
  wrapper.resetIdleTimer = () => {};
  wrapper.shouldWaitForExtensions = () => false;
  return { wrapper, calls };
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("an idle steer starts a prompt instead of stranding the message in the queue", async () => {
  const { wrapper, calls } = makeWrapper();
  await wrapper.send({ type: "steer", message: "hello" });
  await settle();
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["prompt"],
    "idle steer must not call inner.steer (nothing would consume the queue entry)",
  );
  assert.equal(calls[0].message, "hello");
  assert.deepEqual(calls[0].options, { source: "rpc" });
});

test("an idle follow_up starts a prompt too", async () => {
  const { wrapper, calls } = makeWrapper();
  await wrapper.send({ type: "follow_up", message: "next" });
  await settle();
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["prompt"],
  );
  assert.equal(calls[0].message, "next");
});

test("a mid-turn steer still queues into the running turn", async () => {
  const { wrapper, calls } = makeWrapper({ streaming: true });
  await wrapper.send({ type: "steer", message: "mid-turn" });
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["steer"],
  );
  assert.equal(calls[0].message, "mid-turn");
});

test("normalized commands do not inherit streamingBehavior", async () => {
  const { wrapper, calls } = makeWrapper();
  await wrapper.send({ type: "steer", message: "x", streamingBehavior: "followUp" });
  await settle();
  assert.equal(calls[0].kind, "prompt");
  assert.deepEqual(calls[0].options, { source: "rpc" }, "stale streamingBehavior must be dropped");
});
