/**
 * Gateway tests: policy enforcement + RPC bridging over an in-process
 * MessageChannel against a fake relay socket. No real network.
 *
 * The Gateway modules are TypeScript; they are loaded through the project's
 * esbuild test bundle (same mechanism as handlers.test.mjs).
 */
import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");

let modulePromise;
async function loadRemoteModule() {
  if (modulePromise) return modulePromise;
  modulePromise = importTestBundle(
    "src/agent-host/remote-gateway",
    {
      packages: "external",
      absWorkingDir: root,
      stdin: {
        contents:
          'export { RemoteGateway } from "./remote/gateway.ts";\n' +
          'export * from "./remote/policy.ts";\n' +
          'export { createRpcServer } from "../contract/rpc.ts";\n',
        resolveDir: import.meta.dirname,
        loader: "ts",
      },
    },
    { projectRoot: root },
  );
  return modulePromise;
}

function makeServer(mod) {
  const server = mod.createRpcServer();
  server.handle({
    "system.runningCount": () => ({ count: 1, sessionIds: ["s1"] }),
    "agent.command": (params) => {
      const body = params;
      return { echoed: body.command.type, sessionId: body.sessionId };
    },
    "sessions.list": () => ({ sessions: [], runningSessionIds: [] }),
  });
  return server;
}

class FakeRelaySocket {
  constructor() {
    this.sent = [];
    this.listeners = new Map();
  }

  on(event, listener) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.emit("close", 1000, Buffer.from("test"));
  }

  emit(event, ...args) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  deliver(payload) {
    // Frames forwarded by the relay carry the sending device's id in the
    // envelope header; the gateway uses it to route responses back (spec §2).
    this.emit(
      "message",
      JSON.stringify({ v: 1, traceId: "t", ts: Date.now(), nonce: "n", role: "relay", deviceId: "dev-1", payload }),
    );
  }

  helloSent() {
    for (const raw of this.sent) {
      const parsed = JSON.parse(raw);
      if (parsed.payload?.kind === "hello") return parsed;
    }
    return undefined;
  }

  responsesFor(id) {
    return this.sent
      .map((raw) => JSON.parse(raw))
      .filter((parsed) => parsed.payload?.kind === "response" && parsed.payload.id === id);
  }

  findEvent(topic) {
    return this.sent
      .map((raw) => JSON.parse(raw))
      .find((parsed) => parsed.payload?.kind === "event" && parsed.payload.topic === topic);
  }
}

async function makeGateway(mod) {
  const server = makeServer(mod);
  const socket = new FakeRelaySocket();
  const gateway = new mod.RemoteGateway(server, {
    relayUrl: "wss://relay.test/ws",
    connectWebSocket: async () => socket,
  });
  await gateway.start();
  await gateway.whenReady();
  socket.emit("open");
  return { server, socket, gateway };
}

test("policy: wildcard subscriptions and unknown methods are denied", async () => {
  const mod = await loadRemoteModule();
  assert.equal(mod.isSubscriptionAllowed("agent.events", "s1"), true);
  assert.equal(mod.isSubscriptionAllowed("agent.events", "*"), false);
  assert.equal(mod.isSubscriptionAllowed("herdr.fleet", "s1"), false);
  assert.equal(mod.isMethodAllowed("sessions.list"), true);
  assert.equal(mod.isMethodAllowed("agent.state"), true);
  assert.equal(mod.isMethodAllowed("sessions.export"), false);
  assert.equal(mod.isAgentCommandPayloadAllowed({ sessionId: "s", command: { type: "abort" } }), true);
  assert.equal(mod.isAgentCommandPayloadAllowed({ sessionId: "s", command: { type: "set_tools" } }), false);
});

test("policy: read-only model preferences are allowed; mutating models.* stay denied", async () => {
  const mod = await loadRemoteModule();
  assert.equal(mod.isMethodAllowed("models.preferences.get"), true);
  assert.equal(mod.isMethodAllowed("models.list"), false);
  assert.equal(mod.isMethodAllowed("models.refresh"), false);
  assert.equal(mod.isMethodAllowed("models.preferences.set"), false);
  assert.equal(mod.isMethodAllowed("models.default.set"), false);
  assert.equal(mod.isMethodAllowed("models.routing.set"), false);
});

test("policy: skill catalog is read-only; session rename/delete allowed", async () => {
  const mod = await loadRemoteModule();
  assert.equal(mod.isMethodAllowed("skills.list"), true);
  assert.equal(mod.isMethodAllowed("skills.search"), false);
  assert.equal(mod.isMethodAllowed("skills.install"), false);
  assert.equal(mod.isMethodAllowed("skills.set"), false);
  assert.equal(mod.isMethodAllowed("skills.getContent"), false);
  assert.equal(mod.isMethodAllowed("sessions.rename"), true);
  assert.equal(mod.isMethodAllowed("sessions.delete"), true);
});

test("gateway: sends hello on open and bridges allowlisted RPC", async () => {
  const mod = await loadRemoteModule();
  const { socket, gateway } = await makeGateway(mod);
  assert.ok(socket.helloSent(), "gateway must send a hello envelope on open");

  socket.deliver({ kind: "request", id: "r1", method: "system.runningCount", params: null });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const responses = socket.responsesFor("r1");
  assert.equal(responses.length, 1);
  assert.equal(responses[0].payload.ok, true);
  assert.equal(responses[0].payload.result.count, 1);
  gateway.dispose();
});

test("gateway: denies non-allowlisted method without touching RPC", async () => {
  const mod = await loadRemoteModule();
  const { socket, gateway } = await makeGateway(mod);
  socket.deliver({ kind: "request", id: "r2", method: "sessions.export", params: { id: "s1" } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const denied = socket.responsesFor("r2")[0];
  assert.ok(denied, "sessions.export must be answered with a denial");
  assert.equal(denied.payload.ok, false);
  assert.equal(denied.payload.error.code, "FORBIDDEN");
  gateway.dispose();
});

test("gateway: denies forbidden agent.command types", async () => {
  const mod = await loadRemoteModule();
  const { socket, gateway } = await makeGateway(mod);
  socket.deliver({
    kind: "request",
    id: "r3",
    method: "agent.command",
    params: { sessionId: "s1", command: { type: "set_tools", toolNames: ["bash"] } },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const denied = socket.responsesFor("r3")[0];
  assert.ok(denied);
  assert.equal(denied.payload.ok, false);
  assert.equal(denied.payload.error.code, "FORBIDDEN");
  gateway.dispose();
});

test("gateway: allowed agent.command reaches the session handler", async () => {
  const mod = await loadRemoteModule();
  const { socket, gateway } = await makeGateway(mod);
  socket.deliver({
    kind: "request",
    id: "r4",
    method: "agent.command",
    params: { sessionId: "s1", command: { type: "abort" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const ok = socket.responsesFor("r4")[0];
  assert.ok(ok);
  assert.equal(ok.payload.ok, true);
  assert.deepEqual(ok.payload.result, { echoed: "abort", sessionId: "s1" });
  gateway.dispose();
});

test("gateway: wildcard subscribe rejected; explicit subscribe enables mirroring", async () => {
  const mod = await loadRemoteModule();
  const { server, socket, gateway } = await makeGateway(mod);

  socket.deliver({ kind: "subscribe", id: "sub1", topic: "agent.events", key: "*" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const denied = socket.responsesFor("sub1")[0];
  assert.ok(denied, "wildcard subscribe must be denied");
  assert.equal(denied.payload.ok, false);

  // Before subscribing, events for s9 must NOT be mirrored.
  server.emit("agent.events", "s9", { type: "message_update", message: { role: "assistant" } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(socket.findEvent("agent.events"), undefined, "no mirror without subscription");

  // After an explicit subscribe, events for that session are mirrored.
  socket.deliver({ kind: "subscribe", id: "sub2", topic: "agent.events", key: "s9" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const ack = socket.responsesFor("sub2")[0];
  assert.ok(ack);
  assert.equal(ack.payload.ok, true);

  server.emit("agent.events", "s9", { type: "message_update", message: { role: "assistant" } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const forwarded = socket.findEvent("agent.events");
  assert.ok(forwarded, "agent.events must be mirrored after subscription");
  assert.equal(forwarded.payload.key, "s9");

  // Events for other sessions stay unmirrored.
  server.emit("agent.events", "s-other", { type: "message_update", message: { role: "assistant" } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const others = socket.sent
    .map((raw) => JSON.parse(raw))
    .filter((parsed) => parsed.payload?.kind === "event" && parsed.payload.topic === "agent.events");
  assert.equal(others.length, 1, "only the subscribed session is mirrored");
  gateway.dispose();
});

test("gateway: extension_ui_request mirrored to remote.approval; stop aborts", async () => {
  const mod = await loadRemoteModule();
  const { server, socket, gateway } = await makeGateway(mod);
  const decisions = [];
  gateway.onApproval((decision) => decisions.push(decision.outcome));

  // The approval mirror is routed to devices seen on this relay session (the
  // relay requires an envelope deviceId); deliver one device frame first.
  socket.deliver({ kind: "subscribe", id: "sub-0", topic: "agent.events", key: "s1" });
  await new Promise((resolve) => setTimeout(resolve, 30));

  server.emit("agent.events", "s1", {
    type: "extension_ui_request",
    id: "ui-1",
    method: "confirm",
    title: "Allow?",
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const approval = socket.findEvent("remote.approval");
  assert.ok(approval, "extension_ui_request must be mirrored to remote.approval");
  assert.equal(approval.payload.data.requestId, "ui-1");

  gateway.stop();
  assert.deepEqual(decisions, ["aborted"]);
  assert.equal(gateway.getState(), "stopped");
  gateway.dispose();
});
