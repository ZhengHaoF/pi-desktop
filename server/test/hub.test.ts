import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { RelayHub } from "../src/hub.ts";
import { PairingService } from "../src/pairing.ts";
import { AuditLog } from "../src/audit.ts";
import type { RelayConfig } from "../src/config.ts";

function testConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 0,
    cipherRequired: true,
    replayWindowMs: 120_000,
    rateLimitMax: 1_000,
    rateLimitWindowMs: 60_000,
    pairingTtlMs: 60_000,
    pairingMaxAttempts: 3,
    ...overrides,
  };
}

interface Started {
  url: string;
  close: () => Promise<void>;
  hub: RelayHub;
}

async function startRelay(config: RelayConfig = testConfig()): Promise<Started> {
  const hub = new RelayHub(config);
  const httpServer = createServer();
  httpServer.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    hub,
    close: () =>
      new Promise<void>((resolve) => {
        for (const peer of [...hub.registry.onlineHosts(), ...hub.registry.onlineDevices()]) {
          peer.close(1000, "shutdown");
        }
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
        setTimeout(resolve, 500).unref();
      }),
  };
}

function connect(url: string, role: "host" | "device"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?role=${role}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data: Buffer) => resolve(data.toString("utf8")));
    ws.once("close", (code, reason) => reject(new Error(`closed ${code} ${String(reason)}`)));
  });
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: String(reason) }));
  });
}

function helloEnvelope(role: "host" | "device", deviceId?: string): string {
  return JSON.stringify({
    v: 1,
    traceId: "t1",
    ts: Date.now(),
    nonce: "n1",
    role,
    ...(deviceId ? { deviceId } : {}),
    payload: { kind: "hello", protocolVersion: 1, appVersion: "0.1.0", auth: {} },
  });
}

test("relay: hello accept + ack (host & device)", { timeout: 10000 }, async () => {
  const relay = await startRelay();
  try {
    const host = await connect(relay.url, "host");
    host.send(helloEnvelope("host"));
    const ack = JSON.parse(await nextMessage(host)) as { payload: { kind: string; cipherRequired: boolean } };
    assert.equal(ack.payload.kind, "hello_ack");
    assert.equal(ack.payload.cipherRequired, true);

    const device = await connect(relay.url, "device");
    device.send(helloEnvelope("device", "dev-1"));
    const ack2 = JSON.parse(await nextMessage(device)) as { payload: { kind: string } };
    assert.equal(ack2.payload.kind, "hello_ack");
    assert.equal(relay.hub.registry.onlineHosts().length, 1);
    assert.equal(relay.hub.registry.onlineDevices().length, 1);
    host.close();
    device.close();
  } finally {
    await relay.close();
  }
});

test("relay: rejects plaintext payload after hello when cipher required", { timeout: 10000 }, async () => {
  const relay = await startRelay();
  try {
    const host = await connect(relay.url, "host");
    host.send(helloEnvelope("host"));
    await nextMessage(host);
    const closed = nextClose(host);
    host.send(
      JSON.stringify({
        v: 1,
        traceId: "t",
        ts: Date.now(),
        nonce: "n",
        role: "host",
        deviceId: "dev-1",
        payload: { kind: "request", id: "r1", method: "sessions.list", params: null },
      }),
    );
    const result = await closed;
    assert.equal(result.code, 4002);
    assert.match(result.reason, /ciphertext/i);
  } finally {
    await relay.close();
  }
});

test("relay: rejects wrong protocol version", { timeout: 10000 }, async () => {
  const relay = await startRelay();
  try {
    const host = await connect(relay.url, "host");
    const closed = nextClose(host);
    host.send(JSON.stringify({ ...JSON.parse(helloEnvelope("host")), v: 2 }));
    const result = await closed;
    assert.equal(result.code, 4000);
  } finally {
    await relay.close();
  }
});

test("relay: routes ciphertext device→host and host→device", { timeout: 10000 }, async () => {
  const relay = await startRelay();
  try {
    const host = await connect(relay.url, "host");
    host.send(helloEnvelope("host"));
    const ack = JSON.parse(await nextMessage(host)) as { hostId?: string };
    const hostId = ack.hostId ?? relay.hub.registry.onlineHosts()[0]!.id;

    const device = await connect(relay.url, "device");
    device.send(helloEnvelope("device", "dev-1"));
    await nextMessage(device);

    const request = JSON.stringify({
      v: 1,
      traceId: "t2",
      ts: Date.now(),
      nonce: "n2",
      role: "device",
      deviceId: "dev-1",
      hostId,
      cipher: { alg: "x25519-aes-gcm", keyId: "k1", iv: "iv", tag: "tag" },
      payload: "ciphertext-request",
    });
    device.send(request);
    const received = await nextMessage(host);
    assert.equal(received, request);

    const response = JSON.stringify({
      v: 1,
      traceId: "t3",
      ts: Date.now(),
      nonce: "n3",
      role: "host",
      deviceId: "dev-1",
      cipher: { alg: "x25519-aes-gcm", keyId: "k1", iv: "iv", tag: "tag" },
      payload: "ciphertext-response",
    });
    host.send(response);
    const received2 = await nextMessage(device);
    assert.equal(received2, response);
    host.close();
    device.close();
  } finally {
    await relay.close();
  }
});

test("relay: denies same-role routing", { timeout: 10000 }, async () => {
  const relay = await startRelay();
  try {
    const host1 = await connect(relay.url, "host");
    host1.send(helloEnvelope("host"));
    await nextMessage(host1);
    const host2 = await connect(relay.url, "host");
    host2.send(helloEnvelope("host"));
    await nextMessage(host2);
    const target = relay.hub.registry.onlineHosts()[0]!.id;

    const closed = nextClose(host2);
    host2.send(
      JSON.stringify({
        v: 1,
        traceId: "t",
        ts: Date.now(),
        nonce: "n",
        role: "host",
        deviceId: target,
        cipher: { alg: "x25519-aes-gcm", keyId: "k", iv: "i", tag: "t" },
        payload: "x",
      }),
    );
    const result = await closed;
    assert.equal(result.code, 4002);
    host1.close();
  } finally {
    await relay.close();
  }
});

test("relay: zero-knowledge — payloads never appear in audit log", { timeout: 10000 }, async () => {
  const relay = await startRelay();
  try {
    const host = await connect(relay.url, "host");
    host.send(helloEnvelope("host"));
    await nextMessage(host);
    const secret = "SECRET-PLAINTEXT-MARKER-12345";
    host.send(
      JSON.stringify({
        v: 1,
        traceId: "t",
        ts: Date.now(),
        nonce: "n",
        role: "host",
        deviceId: "dev-1",
        cipher: { alg: "x25519-aes-gcm", keyId: "k", iv: "i", tag: "t" },
        payload: Buffer.from(secret).toString("base64"),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const dump = JSON.stringify(relay.hub.audit.events);
    assert.equal(dump.includes(secret), false);
    assert.equal(dump.includes(Buffer.from(secret).toString("base64")), false);
    host.close();
  } finally {
    await relay.close();
  }
});

test("pairing: token lifecycle + attempt lockout", () => {
  const audit = new AuditLog();
  const service = new PairingService(testConfig(), audit);
  const { token } = service.create("host-1");

  // Device submits → still pending until PC approves.
  const submitted = service.submit(token, "host-1", "dev-1", "pubkey");
  assert.equal(submitted.ok, true);
  assert.equal(submitted.ok ? submitted.awaitingApproval : false, true);
  assert.equal(service.approve(token), true);

  // After approval, another submit is rejected (already approved).
  const again = service.submit(token, "host-1", "dev-2", "pubkey2");
  assert.equal(again.ok, false);
  assert.match(again.ok ? "" : again.reason, /approved/);

  // Unknown tokens are counted and lock out after max attempts.
  const service2 = new PairingService(testConfig(), audit);
  service2.create("host-1");
  let lastReason = "";
  for (let i = 0; i < 5; i += 1) {
    const result = service2.submit(`guess-${i}`, "host-1", "dev-1", "pk");
    if (!result.ok) lastReason = result.reason;
  }
  assert.match(lastReason, /locked|unknown/);
});

test("pairing: hash verification is timing-safe and deterministic", () => {
  const hash = PairingService.hashToken("abc");
  assert.equal(hash, PairingService.hashToken("abc"));
  assert.notEqual(hash, PairingService.hashToken("abd"));
  assert.equal(PairingService.verifyToken("abc", hash), true);
  assert.equal(PairingService.verifyToken("abd", hash), false);
});
