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
          'export * as e2eeCipher from "./remote/cipher.ts";\n' +
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

async function makeGateway(mod, extraOptions = {}) {
  const server = makeServer(mod);
  const socket = new FakeRelaySocket();
  const gateway = new mod.RemoteGateway(server, {
    relayUrl: "wss://relay.test/ws",
    connectWebSocket: async () => socket,
    ...extraOptions,
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

test("gateway: ask dialogs mirror with questions and replay to a late subscriber", async () => {
  const mod = await loadRemoteModule();
  const { server, socket, gateway } = await makeGateway(mod);

  socket.deliver({ kind: "subscribe", id: "sub-0", topic: "agent.events", key: "s1" });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const questions = [{ question: "Which auth?", options: [{ label: "OAuth" }, { label: "Key" }] }];
  server.emit("agent.events", "s1", { type: "extension_ui_request", id: "ask-1", method: "ask", questions });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const mirrored = socket.sent
    .map((raw) => JSON.parse(raw))
    .find((parsed) => parsed.payload?.data?.requestId === "ask-1");
  assert.ok(mirrored, "ask must be mirrored");
  assert.equal(mirrored.payload.topic, "remote.approval");
  assert.deepEqual(mirrored.payload.data.questions, questions);

  // A phone that subscribes after the question was asked still receives it.
  const before = socket.sent.length;
  socket.deliver({ kind: "subscribe", id: "sub-ask", topic: "remote.approval", key: "s1" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const replayed = socket.sent
    .slice(before)
    .map((raw) => JSON.parse(raw))
    .find((parsed) => parsed.payload?.data?.requestId === "ask-1");
  assert.ok(replayed, "pending ask must replay to a late subscriber");

  // Once the desktop answers, the closure is mirrored so the phone card clears.
  server.emit("agent.events", "s1", {
    type: "extension_ui_request",
    id: "resolved-1",
    method: "resolved",
    requestId: "ask-1",
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const closed = socket.sent
    .map((raw) => JSON.parse(raw))
    .find((parsed) => parsed.payload?.data?.resolved === true && parsed.payload.data.requestId === "ask-1");
  assert.ok(closed, "resolving elsewhere must mirror a closure");
  gateway.dispose();
});

test("@ pair.create control frame round-trips through the relay reply", async () => {
  const mod = await loadRemoteModule();
  const { socket, gateway } = await makeGateway(mod);
  try {
    const pending = gateway.sendControl("pair.create");
    const frame = socket.sent.map((raw) => JSON.parse(raw)).find((parsed) => parsed.control === "pair.create");
    assert.ok(frame, "control frame sent");
    assert.equal(frame.role, "host");
    assert.equal(typeof frame.traceId, "string");

    socket.emit(
      "message",
      JSON.stringify({
        v: 1,
        traceId: frame.traceId,
        ts: Date.now(),
        nonce: "n",
        role: "relay",
        payload: { kind: "pair.create.result", token: "tok-1", expiresAt: 123 },
      }),
    );
    const result = await pending;
    assert.equal(result.token, "tok-1");
    assert.equal(result.expiresAt, 123);
  } finally {
    gateway.dispose();
  }
});

test("@ pair.revoke control frame carries the deviceId header", async () => {
  const mod = await loadRemoteModule();
  const { socket, gateway } = await makeGateway(mod);
  try {
    const pending = gateway.sendControl("pair.revoke", { deviceId: "dev-9" });
    const frame = socket.sent.map((raw) => JSON.parse(raw)).find((parsed) => parsed.control === "pair.revoke");
    assert.ok(frame, "revoke frame sent");
    assert.equal(frame.deviceId, "dev-9");

    socket.emit(
      "message",
      JSON.stringify({
        v: 1,
        traceId: frame.traceId,
        ts: Date.now(),
        nonce: "n",
        role: "relay",
        payload: { kind: "pair.revoke.result", deviceId: "dev-9", revoked: true },
      }),
    );
    const result = await pending;
    assert.equal(result.revoked, true);
  } finally {
    gateway.dispose();
  }
});

test("@ sendControl rejects while the relay link is down", async () => {
  const mod = await loadRemoteModule();
  const server = makeServer(mod);
  const gateway = new mod.RemoteGateway(server, {
    relayUrl: "wss://relay.test/ws",
    connectWebSocket: async () => new FakeRelaySocket(),
  });
  await assert.rejects(gateway.sendControl("pair.create"), /not connected/);
  gateway.dispose();
});

// ---------------------------------------------------------------------------
// E2EE (Step 2): cipherMode from hello_ack, per-device sealing
// ---------------------------------------------------------------------------

async function makeE2eeGateway(mod) {
  const hostPair = mod.e2eeCipher.generateKeyPair();
  const devicePair = mod.e2eeCipher.generateKeyPair();
  const deviceKeys = mod.e2eeCipher.restoreKeyPair(devicePair.publicKey, devicePair.privateKey);
  const server = makeServer(mod);
  const socket = new FakeRelaySocket();
  const gateway = new mod.RemoteGateway(server, {
    relayUrl: "wss://relay.test/ws",
    connectWebSocket: async () => socket,
    e2ee: hostPair,
  });
  await gateway.start();
  await gateway.whenReady();
  socket.emit("open");
  // hello is plaintext and announces the host's static public key.
  const hello = socket.helloSent();
  assert.ok(hello, "hello sent");
  assert.equal(hello.payload.e2eePub, hostPair.publicKey);
  // Relay confirms the cipher requirement.
  socket.emit(
    "message",
    JSON.stringify({
      v: 1,
      traceId: "t-ack",
      ts: Date.now(),
      nonce: "n-ack",
      role: "relay",
      payload: { kind: "hello_ack", protocolVersion: 1, hostId: "host-1", cipherRequired: true },
    }),
  );
  const seal = mod.e2eeCipher.sealContext(deviceKeys.privateKey, devicePair.publicKey, hostPair.publicKey, true);
  const open = mod.e2eeCipher.openContext(deviceKeys.privateKey, devicePair.publicKey, hostPair.publicKey, true);
  return { server, socket, gateway, hostPair, devicePair, seal, open };
}

function encryptedRequest(mod, seal, deviceId, hostId, wireMessage) {
  const header = {
    v: 1,
    traceId: `t-${wireMessage.id}`,
    ts: Date.now(),
    nonce: `n-${wireMessage.id}`,
    role: "device",
    deviceId,
    hostId,
  };
  const parts = seal.encrypt(JSON.stringify(wireMessage), header);
  return { ...header, e2eePub: parts.e2eePub, cipher: parts.cipher, payload: parts.payload };
}

test("@ e2ee: hello_ack cipherRequired enables per-device sealing end to end", async () => {
  const mod = await loadRemoteModule();
  const { socket, gateway, hostPair, seal, open } = await makeE2eeGateway(mod);
  try {
    const envelope = encryptedRequest(mod, seal, "dev-1", "host-1", {
      kind: "request",
      id: "r-e1",
      method: "system.runningCount",
      params: null,
    });
    socket.emit("message", JSON.stringify(envelope));
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Outgoing response must be ciphertext bound to the device session.
    const frames = socket.sent.map((raw) => JSON.parse(raw));
    const responseFrame = frames.find(
      (parsed) => typeof parsed.payload === "string" && parsed.cipher && parsed.deviceId === "dev-1",
    );
    assert.ok(responseFrame, "encrypted response frame sent");
    assert.equal(responseFrame.e2eePub, hostPair.publicKey, "host announces its static key on responses");
    const header = {
      v: responseFrame.v,
      traceId: responseFrame.traceId,
      ts: responseFrame.ts,
      nonce: responseFrame.nonce,
      role: responseFrame.role,
      deviceId: responseFrame.deviceId,
    };
    const clear = JSON.parse(open.decrypt(responseFrame.cipher, responseFrame.payload, header));
    assert.equal(clear.kind, "response");
    assert.equal(clear.id, "r-e1");
    assert.equal(clear.ok, true);
    assert.equal(clear.result.count, 1);
  } finally {
    gateway.dispose();
  }
});

test("@ e2ee: tampered ciphertext is dropped without a response", async () => {
  const mod = await loadRemoteModule();
  const { socket, gateway, seal } = await makeE2eeGateway(mod);
  try {
    const envelope = encryptedRequest(mod, seal, "dev-1", "host-1", {
      kind: "request",
      id: "r-e2",
      method: "system.runningCount",
      params: null,
    });
    envelope.payload = envelope.payload.slice(0, -6) + "AAAAAA";
    socket.emit("message", JSON.stringify(envelope));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const responses = socket.sent.map((raw) => JSON.parse(raw)).filter((p) => p.deviceId === "dev-1");
    assert.equal(responses.length, 0, "no reply to a forged frame");
  } finally {
    gateway.dispose();
  }
});

test("@ e2ee: replayed envelope (same nonce) is dropped", async () => {
  const mod = await loadRemoteModule();
  const { socket, gateway, seal } = await makeE2eeGateway(mod);
  try {
    const envelope = encryptedRequest(mod, seal, "dev-1", "host-1", {
      kind: "request",
      id: "r-e3",
      method: "system.runningCount",
      params: null,
    });
    socket.emit("message", JSON.stringify(envelope));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const first = socket.sent.map((raw) => JSON.parse(raw)).filter((p) => p.deviceId === "dev-1").length;
    assert.equal(first, 1, "first frame answered");
    socket.emit("message", JSON.stringify(envelope));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const second = socket.sent.map((raw) => JSON.parse(raw)).filter((p) => p.deviceId === "dev-1").length;
    assert.equal(second, 1, "replay produced no second answer");
  } finally {
    gateway.dispose();
  }
});

test("@ e2ee: mirrored events are sealed per known device", async () => {
  const mod = await loadRemoteModule();
  const { server, socket, gateway, seal, open } = await makeE2eeGateway(mod);
  try {
    // Subscribe first so mirroring is enabled for this session.
    const sub = encryptedRequest(mod, seal, "dev-1", "host-1", {
      kind: "subscribe",
      id: "s-e1",
      topic: "sessions.changed",
      key: "anything",
    });
    socket.emit("message", JSON.stringify(sub));
    await new Promise((resolve) => setTimeout(resolve, 120));

    server.emit("sessions.changed", "s1", { changed: true });
    await new Promise((resolve) => setTimeout(resolve, 120));

    const decrypted = socket.sent
      .map((raw) => JSON.parse(raw))
      .filter((p) => p.deviceId === "dev-1" && typeof p.payload === "string" && p.cipher)
      .map((frame) => {
        const header = {
          v: frame.v,
          traceId: frame.traceId,
          ts: frame.ts,
          nonce: frame.nonce,
          role: frame.role,
          deviceId: frame.deviceId,
        };
        return JSON.parse(open.decrypt(frame.cipher, frame.payload, header));
      });
    const mirrored = decrypted.find((m) => m.kind === "event" && m.topic === "sessions.changed");
    assert.ok(mirrored, "sessions.changed mirrored encrypted");
    assert.equal(mirrored.key, "s1");
  } finally {
    gateway.dispose();
  }
});
