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
    // 既有用例走诊断路径（无配对凭证）；配对专项测试显式开启。
    pairingRequired: false,
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

function helloEnvelopeWithHost(hostId: string, label?: string): string {
  return JSON.stringify({
    v: 1,
    traceId: "t1",
    ts: Date.now(),
    nonce: "n1",
    role: "host",
    payload: {
      kind: "hello",
      protocolVersion: 1,
      appVersion: "0.1.0",
      ...(label ? { label } : {}),
      hostId,
      auth: {},
    },
  });
}

test("relay: multi-PC — host declares stable hostId + label; device sees directory", { timeout: 10000 }, async () => {
  const relay = await startRelay();
  try {
    const hostA = await connect(relay.url, "host");
    hostA.send(helloEnvelopeWithHost("host-stable-a", "ZHF-WORK"));
    const ackA = JSON.parse(await nextMessage(hostA)) as { payload: { hostId?: string } };
    assert.equal(ackA.payload.hostId, "host-stable-a", "host keeps its declared stable hostId");

    const device = await connect(relay.url, "device");
    device.send(helloEnvelope("device", "dev-1"));
    const ack2 = JSON.parse(await nextMessage(device)) as {
      payload: { hostId?: string; hosts?: Array<{ id: string; label?: string; online: boolean }> };
    };
    assert.equal(ack2.payload.hostId, "host-stable-a");
    const entry = ack2.payload.hosts?.find((h) => h.id === "host-stable-a");
    assert.ok(entry, "device hello_ack carries the host directory");
    assert.equal(entry?.online, true);
    assert.equal(entry?.label, "ZHF-WORK");

    // Envelope-level control: hosts.list answered relay-locally.
    device.send(
      JSON.stringify({
        v: 1,
        traceId: "tl",
        ts: Date.now(),
        nonce: "n2",
        role: "device",
        deviceId: "dev-1",
        control: "hosts.list",
        payload: { kind: "ping" },
      }),
    );
    const listing = JSON.parse(await nextMessage(device)) as {
      payload: { kind: string; hosts: Array<{ id: string; online: boolean }> };
    };
    assert.equal(listing.payload.kind, "hosts.list.result");
    assert.equal(listing.payload.hosts.length, 1);
    assert.equal(listing.payload.hosts[0]!.id, "host-stable-a");
    hostA.close();
    device.close();
  } finally {
    await relay.close();
  }
});

test("relay: multi-PC — offline hosts keep label + lastSeenAt; reconnect replaces", { timeout: 10000 }, async () => {
  const relay = await startRelay();
  try {
    const host = await connect(relay.url, "host");
    host.send(helloEnvelopeWithHost("host-stable-b", "ZHF-Home-PC"));
    await nextMessage(host);
    host.close();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const device = await connect(relay.url, "device");
    device.send(helloEnvelope("device", "dev-1"));
    const ack = JSON.parse(await nextMessage(device)) as {
      payload: { hosts?: Array<{ id: string; online: boolean; lastSeenAt?: number; label?: string }> };
    };
    const offline = ack.payload.hosts?.find((h) => h.id === "host-stable-b");
    assert.ok(offline, "offline host still listed");
    assert.equal(offline?.online, false);
    assert.equal(offline?.label, "ZHF-Home-PC");
    assert.ok(typeof offline?.lastSeenAt === "number", "lastSeenAt recorded on disconnect");

    // Reconnect with the same stable hostId replaces the registry entry.
    const hostAgain = await connect(relay.url, "host");
    hostAgain.send(helloEnvelopeWithHost("host-stable-b", "ZHF-Home-PC"));
    const ackAgain = JSON.parse(await nextMessage(hostAgain)) as { payload: { hostId?: string } };
    assert.equal(ackAgain.payload.hostId, "host-stable-b");
    assert.equal(relay.hub.registry.onlineHosts().filter((h) => h.id === "host-stable-b").length, 1);
    hostAgain.close();
    device.close();
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

// ---------------------------------------------------------------------------
// Pairing (token → credential → revoke)
// ---------------------------------------------------------------------------

function pairingHello(
  role: "host" | "device",
  opts: { deviceId?: string; hostId?: string; auth?: Record<string, unknown> } = {},
): string {
  return JSON.stringify({
    v: 1,
    traceId: "hello-pair",
    ts: Date.now(),
    nonce: "n-pair",
    role,
    ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
    ...(opts.hostId ? { hostId: opts.hostId } : {}),
    payload: {
      kind: "hello",
      protocolVersion: 1,
      appVersion: "0.1.0",
      ...(opts.hostId ? { hostId: opts.hostId } : {}),
      auth: opts.auth ?? {},
    },
  });
}

async function helloHostWithId(url: string, hostId: string): Promise<{ ws: WebSocket; ack: Record<string, unknown> }> {
  const ws = await connect(url, "host");
  ws.send(pairingHello("host", { hostId }));
  const ack = JSON.parse(await nextMessage(ws));
  return { ws, ack };
}

test("relay: pairing issues a credential, re-connect works, revoke cuts access", { timeout: 15000 }, async () => {
  const relay = await startRelay(testConfig({ pairingRequired: true }));
  try {
    const { ws: host } = await helloHostWithId(relay.url, "host-pair-1");

    // 1. Host requests a one-time token.
    host.send(
      JSON.stringify({
        v: 1,
        traceId: "pc-1",
        ts: Date.now(),
        nonce: "n-c",
        role: "host",
        control: "pair.create",
        payload: { kind: "pair.create" },
      }),
    );
    const created = JSON.parse(await nextMessage(host)) as {
      traceId: string;
      payload: { kind: string; token: string; expiresAt: number };
    };
    assert.equal(created.traceId, "pc-1");
    assert.equal(created.payload.kind, "pair.create.result");
    assert.ok(created.payload.token.length > 20);

    // 2. Device pairs with the token and receives its credential.
    const device = await connect(relay.url, "device");
    device.send(
      pairingHello("device", {
        deviceId: "dev-pair-1",
        hostId: "host-pair-1",
        auth: { pairingToken: created.payload.token },
      }),
    );
    const ack = JSON.parse(await nextMessage(device)) as { payload: { kind: string; deviceSecret?: string } };
    assert.equal(ack.payload.kind, "hello_ack");
    const secret = ack.payload.deviceSecret;
    assert.ok(secret && secret.length > 20);
    device.close();

    // 3. Reconnect with the stored credential (no token).
    const again = await connect(relay.url, "device");
    again.send(
      pairingHello("device", { deviceId: "dev-pair-1", hostId: "host-pair-1", auth: { deviceSecret: secret } }),
    );
    const ack2 = JSON.parse(await nextMessage(again)) as { payload: { kind: string } };
    assert.equal(ack2.payload.kind, "hello_ack");

    // 4. Device list shows the binding.
    host.send(
      JSON.stringify({
        v: 1,
        traceId: "pd-1",
        ts: Date.now(),
        nonce: "n-d",
        role: "host",
        control: "pair.devices",
        payload: { kind: "pair.devices" },
      }),
    );
    const listed = JSON.parse(await nextMessage(host)) as {
      payload: { kind: string; devices: Array<{ deviceId: string }> };
    };
    assert.equal(listed.payload.kind, "pair.devices.result");
    assert.deepEqual(
      listed.payload.devices.map((d) => d.deviceId),
      ["dev-pair-1"],
    );

    // 5. Revoke → live connection is closed and the credential stops working.
    const closed = nextClose(again);
    host.send(
      JSON.stringify({
        v: 1,
        traceId: "pr-1",
        ts: Date.now(),
        nonce: "n-r",
        role: "host",
        control: "pair.revoke",
        deviceId: "dev-pair-1",
        payload: { kind: "pair.revoke" },
      }),
    );
    const revoked = JSON.parse(await nextMessage(host)) as { payload: { kind: string; revoked: boolean } };
    assert.equal(revoked.payload.kind, "pair.revoke.result");
    assert.equal(revoked.payload.revoked, true);
    const closedResult = await closed;
    assert.equal(closedResult.code, 4003);

    const afterRevoke = await connect(relay.url, "device");
    const rejected = nextClose(afterRevoke);
    afterRevoke.send(
      pairingHello("device", { deviceId: "dev-pair-1", hostId: "host-pair-1", auth: { deviceSecret: secret } }),
    );
    assert.equal((await rejected).code, 4003);
    host.close();
  } finally {
    await relay.close();
  }
});

test("relay: unpaired device is rejected when pairing is required", { timeout: 10000 }, async () => {
  const relay = await startRelay(testConfig({ pairingRequired: true }));
  try {
    const { ws: host } = await helloHostWithId(relay.url, "host-pair-2");
    const device = await connect(relay.url, "device");
    const closed = nextClose(device);
    device.send(pairingHello("device", { deviceId: "dev-unpaired", hostId: "host-pair-2" }));
    assert.equal((await closed).code, 4003);
    host.close();
  } finally {
    await relay.close();
  }
});

test("relay: invalid and reused pairing tokens are rejected", { timeout: 10000 }, async () => {
  const relay = await startRelay(testConfig({ pairingRequired: true }));
  try {
    const { ws: host } = await helloHostWithId(relay.url, "host-pair-3");

    const bogus = await connect(relay.url, "device");
    const bogusClosed = nextClose(bogus);
    bogus.send(pairingHello("device", { deviceId: "dev-b", hostId: "host-pair-3", auth: { pairingToken: "nope" } }));
    assert.equal((await bogusClosed).code, 4003);

    host.send(
      JSON.stringify({
        v: 1,
        traceId: "pc-3",
        ts: Date.now(),
        nonce: "n-c3",
        role: "host",
        control: "pair.create",
        payload: { kind: "pair.create" },
      }),
    );
    const created = JSON.parse(await nextMessage(host)) as { payload: { token: string } };

    const first = await connect(relay.url, "device");
    first.send(
      pairingHello("device", {
        deviceId: "dev-first",
        hostId: "host-pair-3",
        auth: { pairingToken: created.payload.token },
      }),
    );
    await nextMessage(first);
    first.close();

    // Token is single-use: a second device presenting it is rejected.
    const second = await connect(relay.url, "device");
    const secondClosed = nextClose(second);
    second.send(
      pairingHello("device", {
        deviceId: "dev-second",
        hostId: "host-pair-3",
        auth: { pairingToken: created.payload.token },
      }),
    );
    assert.equal((await secondClosed).code, 4003);
    host.close();
  } finally {
    await relay.close();
  }
});

test("relay: host e2eePub flows into host directory + pairing binding", { timeout: 10000 }, async () => {
  const relay = await startRelay();
  try {
    const hostPub = "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw";
    const host = await connect(relay.url, "host");
    host.send(
      JSON.stringify({
        v: 1,
        traceId: "t-e2ee",
        ts: Date.now(),
        nonce: "n-e2ee",
        role: "host",
        payload: {
          kind: "hello",
          protocolVersion: 1,
          appVersion: "0.1.0",
          label: "PC-e2ee",
          e2eePub: hostPub,
          auth: {},
        },
      }),
    );
    await nextMessage(host);

    const device = await connect(relay.url, "device");
    device.send(helloEnvelope("device", "dev-e2ee"));
    const ack = JSON.parse(await nextMessage(device)) as {
      payload: { hosts?: Array<{ id: string; online?: boolean; e2eePub?: string }> };
    };
    const online = (ack.payload.hosts ?? []).find((h) => h.online);
    assert.ok(online, "online host present in directory");
    assert.equal(online.e2eePub, hostPub);

    // hosts.list control frame: same directory, same key.
    device.send(
      JSON.stringify({
        v: 1,
        traceId: "t-hl",
        ts: Date.now(),
        nonce: "n-hl",
        role: "device",
        deviceId: "dev-e2ee",
        control: "hosts.list",
        payload: { kind: "hosts.list" },
      }),
    );
    const listing = JSON.parse(await nextMessage(device)) as {
      payload: { hosts: Array<{ online?: boolean; e2eePub?: string }> };
    };
    assert.equal(listing.payload.hosts.find((h) => h.online)?.e2eePub, hostPub);

    // Invalid e2eePub (not canonical base64url of 32 bytes) is ignored.
    const host2 = await connect(relay.url, "host");
    host2.send(
      JSON.stringify({
        v: 1,
        traceId: "t-bad",
        ts: Date.now(),
        nonce: "n-bad",
        role: "host",
        payload: {
          kind: "hello",
          protocolVersion: 1,
          appVersion: "0.1.0",
          hostId: "host-bad",
          e2eePub: "not-a-key!!",
          auth: {},
        },
      }),
    );
    await nextMessage(host2);
    device.send(
      JSON.stringify({
        v: 1,
        traceId: "t-hl2",
        ts: Date.now(),
        nonce: "n-hl2",
        role: "device",
        deviceId: "dev-e2ee",
        control: "hosts.list",
        payload: { kind: "hosts.list" },
      }),
    );
    const listing2 = JSON.parse(await nextMessage(device)) as {
      payload: { hosts: Array<{ id: string; e2eePub?: string }> };
    };
    assert.equal(listing2.payload.hosts.find((h) => h.id === "host-bad")?.e2eePub, undefined);
    host.close();
    host2.close();
    device.close();
  } finally {
    await relay.close();
  }
});

test("relay: stale-timestamp envelope dropped without closing the link", { timeout: 10000 }, async () => {
  const relay = await startRelay();
  try {
    const host = await connect(relay.url, "host");
    host.send(helloEnvelope("host"));
    await nextMessage(host);
    host.send(
      JSON.stringify({
        v: 1,
        traceId: "t-stale",
        ts: Date.now() - 600_000,
        nonce: "n-stale",
        role: "host",
        deviceId: "dev-1",
        cipher: { alg: "x25519-aes-gcm", keyId: "k", iv: "i", tag: "t" },
        payload: "x",
      }),
    );
    // Link must stay alive: a subsequent fresh control frame is answered.
    host.send(
      JSON.stringify({
        v: 1,
        traceId: "t-fresh",
        ts: Date.now(),
        nonce: "n-fresh",
        role: "host",
        control: "hosts.list",
        payload: { kind: "hosts.list" },
      }),
    );
    const listing = JSON.parse(await nextMessage(host)) as { payload: { kind: string } };
    assert.equal(listing.payload.kind, "hosts.list.result");
    host.close();
  } finally {
    await relay.close();
  }
});

// ---------------------------------------------------------------------------
// Multi-PC pairing: one device keeps an independent binding per host.
// ---------------------------------------------------------------------------

async function requestPairToken(host: WebSocket, traceId: string): Promise<string> {
  host.send(
    JSON.stringify({
      v: 1,
      traceId,
      ts: Date.now(),
      nonce: traceId,
      role: "host",
      control: "pair.create",
      payload: { kind: "pair.create" },
    }),
  );
  const created = JSON.parse(await nextMessage(host)) as { payload: { token: string } };
  assert.ok(created.payload.token.length > 20);
  return created.payload.token;
}

async function pairDeviceWithToken(url: string, deviceId: string, hostId: string, token: string): Promise<string> {
  const device = await connect(url, "device");
  device.send(pairingHello("device", { deviceId, hostId, auth: { pairingToken: token } }));
  const ack = JSON.parse(await nextMessage(device)) as { payload: { deviceSecret?: string } };
  assert.ok(ack.payload.deviceSecret, "pairing must issue a credential");
  device.close();
  return ack.payload.deviceSecret as string;
}

async function reconnectWithSecret(
  url: string,
  deviceId: string,
  hostId: string,
  secret: string,
): Promise<"ok" | "rejected"> {
  const ws = await connect(url, "device");
  const outcome = await new Promise<"ok" | "rejected">((resolve) => {
    ws.once("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString("utf8")) as { payload?: { kind?: string } };
      resolve(frame.payload?.kind === "hello_ack" ? "ok" : "rejected");
    });
    ws.once("close", () => resolve("rejected"));
    ws.send(pairingHello("device", { deviceId, hostId, auth: { deviceSecret: secret } }));
  });
  if (outcome === "ok") ws.close();
  return outcome;
}

interface ListedDevice {
  deviceId: string;
  label?: string;
  pairedAt: number;
  online?: boolean;
}

async function listPairedDevices(host: WebSocket, traceId: string): Promise<ListedDevice[]> {
  host.send(
    JSON.stringify({
      v: 1,
      traceId,
      ts: Date.now(),
      nonce: traceId,
      role: "host",
      control: "pair.devices",
      payload: { kind: "pair.devices" },
    }),
  );
  const listed = JSON.parse(await nextMessage(host)) as {
    payload: { kind: string; devices: ListedDevice[] };
  };
  assert.equal(listed.payload.kind, "pair.devices.result");
  return listed.payload.devices;
}

/** Device close is asynchronous on the relay side; wait for the registry to settle. */
async function waitForOnlineFlag(
  host: WebSocket,
  deviceId: string,
  expected: boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const devices = await listPairedDevices(host, `poll-${Date.now()}`);
    const entry = devices.find((device) => device.deviceId === deviceId);
    if (entry && entry.online === expected) return;
    if (Date.now() > deadline) {
      assert.equal(entry?.online, expected, `device ${deviceId} online flag did not settle to ${expected}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("relay: one device pairs with two hosts; credentials are host-scoped", { timeout: 20000 }, async () => {
  const relay = await startRelay(testConfig({ pairingRequired: true }));
  try {
    const { ws: hostA } = await helloHostWithId(relay.url, "host-multi-a");
    const { ws: hostB } = await helloHostWithId(relay.url, "host-multi-b");
    const secretA = await pairDeviceWithToken(
      relay.url,
      "dev-multi",
      "host-multi-a",
      await requestPairToken(hostA, "pc-multi-a"),
    );
    const secretB = await pairDeviceWithToken(
      relay.url,
      "dev-multi",
      "host-multi-b",
      await requestPairToken(hostB, "pc-multi-b"),
    );
    assert.notEqual(secretA, secretB, "each host must issue its own credential");

    assert.equal(await reconnectWithSecret(relay.url, "dev-multi", "host-multi-a", secretA), "ok");
    assert.equal(await reconnectWithSecret(relay.url, "dev-multi", "host-multi-b", secretB), "ok");
    assert.equal(
      await reconnectWithSecret(relay.url, "dev-multi", "host-multi-b", secretA),
      "rejected",
      "a credential for host A must not authenticate against host B",
    );

    // Revoking one host leaves the other binding untouched.
    hostA.send(
      JSON.stringify({
        v: 1,
        traceId: "pr-multi",
        ts: Date.now(),
        nonce: "n-pr-multi",
        role: "host",
        control: "pair.revoke",
        deviceId: "dev-multi",
        payload: { kind: "pair.revoke" },
      }),
    );
    const revoked = JSON.parse(await nextMessage(hostA)) as { payload: { revoked: boolean } };
    assert.equal(revoked.payload.revoked, true);
    assert.equal(await reconnectWithSecret(relay.url, "dev-multi", "host-multi-a", secretA), "rejected");
    assert.equal(
      await reconnectWithSecret(relay.url, "dev-multi", "host-multi-b", secretB),
      "ok",
      "revoking one host must not unbind the other",
    );
    hostA.close();
    hostB.close();
  } finally {
    await relay.close();
  }
});

test("relay: pair.unbind lets a device drop only its own host binding", { timeout: 20000 }, async () => {
  const relay = await startRelay(testConfig({ pairingRequired: true }));
  try {
    const { ws: hostB } = await helloHostWithId(relay.url, "host-unbind-b");
    const { ws: hostA } = await helloHostWithId(relay.url, "host-unbind-a");
    const secretA = await pairDeviceWithToken(
      relay.url,
      "dev-unbind",
      "host-unbind-a",
      await requestPairToken(hostA, "pc-unbind-a"),
    );
    const secretB = await pairDeviceWithToken(
      relay.url,
      "dev-unbind",
      "host-unbind-b",
      await requestPairToken(hostB, "pc-unbind-b"),
    );

    // A host cannot unbind on a device's behalf.
    const hostClosed = nextClose(hostA);
    hostA.send(
      JSON.stringify({
        v: 1,
        traceId: "hu-host",
        ts: Date.now(),
        nonce: "n-hu-host",
        role: "host",
        control: "pair.unbind",
        hostId: "host-unbind-a",
        payload: { kind: "pair.unbind", hostId: "host-unbind-a" },
      }),
    );
    assert.equal((await hostClosed).code, 4002);

    // The device unbinds host A. The relay answers and drops the link.
    const device = await connect(relay.url, "device");
    device.send(
      pairingHello("device", {
        deviceId: "dev-unbind",
        hostId: "host-unbind-a",
        auth: { deviceSecret: secretA },
      }),
    );
    await nextMessage(device);
    const settled = new Promise<void>((resolve) => {
      device.once("message", () => resolve());
      device.once("close", () => resolve());
    });
    device.send(
      JSON.stringify({
        v: 1,
        traceId: "hu-device",
        ts: Date.now(),
        nonce: "n-hu-device",
        role: "device",
        deviceId: "dev-unbind",
        hostId: "host-unbind-a",
        control: "pair.unbind",
        payload: { kind: "pair.unbind", hostId: "host-unbind-a" },
      }),
    );
    await settled;

    assert.equal(await reconnectWithSecret(relay.url, "dev-unbind", "host-unbind-a", secretA), "rejected");
    assert.equal(
      await reconnectWithSecret(relay.url, "dev-unbind", "host-unbind-b", secretB),
      "ok",
      "unbinding one host must leave the other usable",
    );
    hostB.close();
  } finally {
    await relay.close();
  }
});

// ---------------------------------------------------------------------------
// pair.devices online flags: the count a PC shows must match its own rows.
// ---------------------------------------------------------------------------

test("relay: pair.devices marks a live device online and offline after disconnect", { timeout: 20000 }, async () => {
  const relay = await startRelay(testConfig({ pairingRequired: true }));
  try {
    const { ws: host } = await helloHostWithId(relay.url, "host-online-1");
    const secret = await pairDeviceWithToken(
      relay.url,
      "dev-online",
      "host-online-1",
      await requestPairToken(host, "pc-online-1"),
    );

    // Pairing binds the device while its connection closes right after; the
    // flag must be false until it reconnects under the stored credential.
    await waitForOnlineFlag(host, "dev-online", false);
    const listed = await listPairedDevices(host, "pd-online-1");
    assert.deepEqual(
      listed.map((device) => device.deviceId),
      ["dev-online"],
    );
    assert.equal(listed[0].online, false);

    // Live connection addressing this host → online.
    const device = await connect(relay.url, "device");
    device.send(
      pairingHello("device", { deviceId: "dev-online", hostId: "host-online-1", auth: { deviceSecret: secret } }),
    );
    const ack = JSON.parse(await nextMessage(device)) as { payload: { kind: string } };
    assert.equal(ack.payload.kind, "hello_ack");
    await waitForOnlineFlag(host, "dev-online", true);

    // Disconnect → the same row flips back to offline (no ghost entries).
    const closed = nextClose(device);
    device.close();
    await closed;
    await waitForOnlineFlag(host, "dev-online", false);
    assert.equal((await listPairedDevices(host, "pd-online-2")).length, 1);
    host.close();
  } finally {
    await relay.close();
  }
});

test("relay: pair.devices reports offline when the device addresses another PC", { timeout: 20000 }, async () => {
  const relay = await startRelay(testConfig({ pairingRequired: true }));
  try {
    const { ws: hostA } = await helloHostWithId(relay.url, "host-switch-a");
    const { ws: hostB } = await helloHostWithId(relay.url, "host-switch-b");
    await pairDeviceWithToken(relay.url, "dev-switch", "host-switch-a", await requestPairToken(hostA, "pc-switch-a"));
    const secretB = await pairDeviceWithToken(
      relay.url,
      "dev-switch",
      "host-switch-b",
      await requestPairToken(hostB, "pc-switch-b"),
    );

    // The phone is online, but it is talking to PC B.
    const device = await connect(relay.url, "device");
    device.send(
      pairingHello("device", { deviceId: "dev-switch", hostId: "host-switch-b", auth: { deviceSecret: secretB } }),
    );
    const ack = JSON.parse(await nextMessage(device)) as { payload: { kind: string } };
    assert.equal(ack.payload.kind, "hello_ack");

    await waitForOnlineFlag(hostB, "dev-switch", true);
    // PC A still lists the binding (paired once) but must not claim it online.
    await waitForOnlineFlag(hostA, "dev-switch", false);
    const listedA = await listPairedDevices(hostA, "pd-switch-a");
    assert.deepEqual(
      listedA.map((entry) => [entry.deviceId, entry.online]),
      [["dev-switch", false]],
    );

    device.close();
    hostA.close();
    hostB.close();
  } finally {
    await relay.close();
  }
});
