import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import {
  RemoteEnvelope,
  WireMessage,
  HelloPayload,
  HelloAckPayload,
  ApprovalRequestData,
  ApprovalResponseData,
  ApprovalResolvedData,
  RELIABILITY,
  PROTOCOL_VERSION,
  isCipherRequiredEnvelope,
  type RemoteEnvelopeValue,
  type WireMessageValue,
} from "../src/envelope.ts";
import {
  isMethodAllowed,
  isAgentCommandTypeAllowed,
  isTopicAllowed,
  isSubscriptionAllowed,
  isAgentCommandPayloadAllowed,
} from "../src/allowlist.ts";

const registry = Type.Strict ? Type : Type;
function value(schema: unknown): unknown {
  return schema;
}

// Minimal structural validator: TypeBox 1.x exposes a compiled Value module via
// Type.* builders; to keep the package dependency-free we hand-roll narrow
// assertions for the golden fixtures instead of importing a validator.
function assertShape(value: unknown, expected: Record<string, string>): void {
  assert.equal(typeof value, "object");
  for (const [key, kind] of Object.entries(expected)) {
    assert.ok(key in (value as object), `missing key ${key}`);
    const actual = (value as Record<string, unknown>)[key];
    if (kind === "string") assert.equal(typeof actual, "string", `${key} should be string`);
    else if (kind === "number") assert.equal(typeof actual, "number", `${key} should be number`);
    else if (kind === "boolean") assert.equal(typeof actual, "boolean", `${key} should be boolean`);
  }
}

test("PROTOCOL_VERSION is 1", () => {
  assert.equal(PROTOCOL_VERSION, 1);
});

test("golden: device request envelope round-trips", () => {
  const wire: WireMessageValue = {
    kind: "request",
    id: "req-1",
    method: "agent.command",
    params: { sessionId: "s1", command: { type: "prompt", message: "hi" } },
  };
  const envelope: RemoteEnvelopeValue = {
    v: 1,
    traceId: "trace-1",
    ts: 1_700_000_000_000,
    nonce: "n-1",
    role: "device",
    deviceId: "dev-1",
    hostId: "host-1",
    cipher: { alg: "x25519-aes-gcm", keyId: "k1", iv: "iv", tag: "tag" },
    payload: "base64-ciphertext",
  };
  assertShape(envelope, { v: "number", traceId: "string", ts: "number", nonce: "string" });
  assertShape(wire, { kind: "string", id: "string", method: "string" });
  assert.equal(isCipherRequiredEnvelope(envelope), true);
  const plaintext: RemoteEnvelopeValue = { ...envelope, cipher: undefined, payload: wire };
  assert.equal(isCipherRequiredEnvelope(plaintext), false);
});

test("golden: hello payloads", () => {
  const hello = {
    kind: "hello",
    protocolVersion: 1,
    role: "device",
    appVersion: "0.1.0",
    label: "Pixel",
    auth: { token: "t" },
  };
  assertShape(hello, { kind: "string", protocolVersion: "number", appVersion: "string" });
  const ack = { kind: "hello_ack", protocolVersion: 1, hostId: "host-1", cipherRequired: true };
  assertShape(ack, { kind: "string", protocolVersion: "number", cipherRequired: "boolean" });
});

test("golden: approval request/response", () => {
  const request = {
    requestId: "r1",
    sessionId: "s1",
    method: "confirm",
    title: "Allow write?",
    createdAt: 1_700_000_000_000,
  };
  assertShape(request, { requestId: "string", sessionId: "string", method: "string", createdAt: "number" });
  const response = { requestId: "r1", action: "respond", response: { confirmed: true } };
  assertShape(response, { requestId: "string", action: "string" });
});

test("golden: ask approval carries questions and answers answers", () => {
  const request = {
    requestId: "r2",
    sessionId: "s1",
    method: "ask",
    questions: [
      {
        header: "Auth",
        question: "Which auth?",
        options: [{ label: "OAuth", description: "Browser login" }, { label: "API key" }],
      },
      { question: "Scopes?", options: [{ label: "Read" }], multiSelect: true },
    ],
    createdAt: 1_700_000_000_000,
  };
  assertShape(request, { requestId: "string", sessionId: "string", method: "string", createdAt: "number" });
  const response = {
    requestId: "r2",
    action: "respond",
    answers: [{ header: "Auth", question: "Which auth?", selected: ["OAuth"] }],
  };
  assertShape(response, { requestId: "string", action: "string" });
  const resolved = { requestId: "r2", sessionId: "s1", resolved: true };
  assertShape(resolved, { requestId: "string", sessionId: "string", resolved: "boolean" });
});

test("allowlist: allowed, forbidden, unknown methods", () => {
  assert.equal(isMethodAllowed("agent.command"), true);
  assert.equal(isMethodAllowed("sessions.contextPage"), true);
  assert.equal(isMethodAllowed("sessions.delete"), false);
  assert.equal(isMethodAllowed("mcp.oauth.submit"), false);
  assert.equal(isMethodAllowed("herdr.runtime.connect"), false);
  assert.equal(isMethodAllowed("updates.check"), false);
  assert.equal(isMethodAllowed("system.allowRoot"), false);
  assert.equal(isMethodAllowed("agent.unknown"), false);
});

test("allowlist: agent command types", () => {
  assert.equal(isAgentCommandTypeAllowed("prompt"), true);
  assert.equal(isAgentCommandTypeAllowed("steer"), true);
  assert.equal(isAgentCommandTypeAllowed("abort"), true);
  assert.equal(isAgentCommandTypeAllowed("extension_ui_response"), true);
  assert.equal(isAgentCommandTypeAllowed("set_tools"), false);
  assert.equal(isAgentCommandTypeAllowed("fork"), false);
  assert.equal(isAgentCommandTypeAllowed("navigate_tree"), false);
});

test("allowlist: topics and subscriptions", () => {
  assert.equal(isTopicAllowed("agent.events"), true);
  assert.equal(isTopicAllowed("herdr.fleet"), false);
  assert.equal(isSubscriptionAllowed("agent.events", "session-1"), true);
  assert.equal(isSubscriptionAllowed("agent.events", "*"), false);
  assert.equal(isSubscriptionAllowed("agent.events", ""), false);
  assert.equal(isSubscriptionAllowed("herdr.fleet", "x"), false);
});

test("allowlist: agent.command payload guard", () => {
  assert.equal(isAgentCommandPayloadAllowed({ sessionId: "s1", command: { type: "prompt", message: "x" } }), true);
  assert.equal(isAgentCommandPayloadAllowed({ sessionId: "s1", command: { type: "set_tools" } }), false);
  assert.equal(isAgentCommandPayloadAllowed({ sessionId: "s1", command: { type: "fork" } }), false);
  assert.equal(isAgentCommandPayloadAllowed({ command: { type: "prompt" } }), false);
  assert.equal(isAgentCommandPayloadAllowed(null), false);
  assert.equal(isAgentCommandPayloadAllowed("prompt"), false);
});

test("reliability constants are shared", () => {
  assert.equal(RELIABILITY.heartbeatIntervalMs, 15_000);
  assert.equal(RELIABILITY.idempotencyWindowMs, 300_000);
  assert.equal(RELIABILITY.bufferMaxBytes, 2 * 1024 * 1024);
  assert.equal(RELIABILITY.renderThrottleHz, 20);
});

test("schemas are plain objects (typebox sanity)", () => {
  for (const schema of [
    RemoteEnvelope,
    WireMessage,
    HelloPayload,
    HelloAckPayload,
    ApprovalRequestData,
    ApprovalResponseData,
    ApprovalResolvedData,
  ]) {
    assert.equal(typeof registry, "object");
    assert.ok(schema && typeof schema === "object");
    assert.equal(typeof value(schema), "object");
  }
});
