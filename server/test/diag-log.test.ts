import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { RelayHub } from "../src/hub.ts";
import { RelayDiagLog } from "../src/diag-log.ts";
import type { RelayConfig } from "../src/config.ts";

function testConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 0,
    cipherRequired: true,
    pairingRequired: true,
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
  hub: RelayHub;
  close: () => Promise<void>;
}

async function startRelay(config: RelayConfig): Promise<Started> {
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

function helloEnvelope(
  role: "host" | "device",
  options: { deviceId?: string; hostId?: string; auth?: Record<string, string>; e2eePub?: string } = {},
): string {
  return JSON.stringify({
    v: 1,
    traceId: "t1",
    ts: Date.now(),
    nonce: "n1",
    role,
    ...(options.deviceId ? { deviceId: options.deviceId } : {}),
    ...(options.hostId ? { hostId: options.hostId } : {}),
    ...(options.e2eePub ? { e2eePub: options.e2eePub } : {}),
    payload: {
      kind: "hello",
      protocolVersion: 1,
      appVersion: "test",
      ...(options.hostId ? { hostId: options.hostId } : {}),
      auth: options.auth ?? {},
      ...(options.e2eePub ? { e2eePub: options.e2eePub } : {}),
    },
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => ws.once("message", (data: Buffer) => resolve(data.toString("utf8"))));
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: String(reason) })));
}

function makeTempLog(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "relay-diag-"));
  return { dir, path: join(dir, "relay-debug.log") };
}

function readEvents(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Indexed access with the assertion TS needs (noUncheckedIndexedAccess). */
function eventAt(events: Array<Record<string, unknown>>, index: number): Record<string, unknown> {
  const found = events[index];
  assert.ok(found, `diag event #${index} present`);
  return found;
}

test("diag log: disabled without a path, and digests are stable", () => {
  const off = new RelayDiagLog();
  assert.equal(off.enabled, false);
  off.record("noop"); // must not throw
  assert.equal(off.filePath, undefined);

  assert.equal(RelayDiagLog.digest(undefined), undefined);
  assert.equal(RelayDiagLog.digest("token-1"), RelayDiagLog.digest("token-1"));
  assert.notEqual(RelayDiagLog.digest("token-1"), RelayDiagLog.digest("token-2"));
});

test("diag log: writes JSONL, never stores the plaintext secret", () => {
  const { dir, path } = makeTempLog();
  try {
    const log = new RelayDiagLog(path);
    log.record("pair.create", { hostId: "host-1", tokenDigest: RelayDiagLog.digest("super-secret-token") });
    const raw = readFileSync(path, "utf8");
    assert.equal(raw.includes("super-secret-token"), false);
    const events = readEvents(path);
    assert.equal(events.length, 1);
    const first = eventAt(events, 0);
    assert.equal(first.event, "pair.create");
    assert.equal(first.hostId, "host-1");
    assert.equal(first.tokenDigest, RelayDiagLog.digest("super-secret-token"));
    assert.ok(typeof first.ts === "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "diag log: rejected device hello records the token verdict and binding inventory",
  { timeout: 10_000 },
  async () => {
    const { dir, path } = makeTempLog();
    const relay = await startRelay(testConfig({ debugLogPath: path }));
    try {
      const device = await connect(relay.url, "device");
      device.send(
        helloEnvelope("device", { deviceId: "dev-1", hostId: "host-1", auth: { pairingToken: "guess-token" } }),
      );
      const closed = await nextClose(device);
      assert.equal(closed.code, 4003);
      // The phone can now surface *why* instead of a bare "pairing token rejected".
      assert.match(closed.reason, /unknown pairing token/);

      const events = readEvents(path);
      assert.equal(eventAt(events, 0).event, "relay.start");
      assert.equal(eventAt(events, 0).pairingRequired, true);
      const hello = events.find((event) => event.event === "device.hello");
      assert.ok(hello, "device.hello logged");
      assert.equal(hello.deviceId, "dev-1");
      assert.equal(hello.declaredHostId, "host-1");
      assert.equal(hello.hasPairingToken, true);
      assert.equal(hello.tokenVerdict, "unknown pairing token");
      assert.equal(hello.hasDeviceSecret, false);
      assert.equal(hello.credentialVerdict, null);
      assert.deepEqual(hello.bindingHostIds, []);
      assert.deepEqual(hello.onlineHostIds, []);
      assert.equal(hello.paired, false);
      assert.ok(events.some((event) => event.event === "hello.reject" && event.code === 4003));
    } finally {
      await relay.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "diag log: a replayed one-time token is traceable across pair.create → device.hello",
  { timeout: 10_000 },
  async () => {
    const { dir, path } = makeTempLog();
    const relay = await startRelay(testConfig({ debugLogPath: path }));
    try {
      const host = await connect(relay.url, "host");
      host.send(helloEnvelope("host", { hostId: "host-1" }));
      await nextMessage(host);

      host.send(
        JSON.stringify({
          v: 1,
          traceId: "c1",
          ts: Date.now(),
          nonce: "n1",
          role: "host",
          control: "pair.create",
          payload: { kind: "pair.create" },
        }),
      );
      const created = JSON.parse(await nextMessage(host)) as { payload: { token: string } };
      const token = created.payload.token;
      assert.ok(token.length > 0);

      // First scan pairs and consumes the token.
      const first = await connect(relay.url, "device");
      first.send(helloEnvelope("device", { deviceId: "dev-1", hostId: "host-1", auth: { pairingToken: token } }));
      const ack = JSON.parse(await nextMessage(first)) as { payload: { deviceSecret?: string } };
      assert.ok(ack.payload.deviceSecret, "pairing issued a device secret");
      first.close();

      // Reconnect that keeps replaying the same (already consumed) token.
      const second = await connect(relay.url, "device");
      second.send(helloEnvelope("device", { deviceId: "dev-2", hostId: "host-1", auth: { pairingToken: token } }));
      const closed = await nextClose(second);
      assert.equal(closed.code, 4003);
      assert.match(closed.reason, /pairing consumed/);

      const events = readEvents(path);
      const create = events.find((event) => event.event === "pair.create");
      const hellos = events.filter((event) => event.event === "device.hello");
      assert.ok(create, "pair.create logged");
      assert.equal(create.tokenDigest, RelayDiagLog.digest(token));
      const paired = hellos.find((event) => event.deviceId === "dev-1");
      const replayed = hellos.find((event) => event.deviceId === "dev-2");
      assert.equal(paired?.tokenVerdict, "paired");
      assert.equal(paired?.paired, true);
      assert.deepEqual(paired?.bindingHostIds, ["host-1"]);
      // Same digest as pair.create → you can correlate the QR with the replay.
      assert.equal(replayed?.pairingTokenDigest, create.tokenDigest);
      assert.equal(replayed?.tokenVerdict, "pairing consumed");
      assert.deepEqual(replayed?.bindingHostIds, []);
      assert.equal(replayed?.paired, false);
    } finally {
      await relay.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
