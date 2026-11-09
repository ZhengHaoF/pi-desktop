/* global fetch: readonly, AbortSignal: readonly */
/**
 * Step 2 E2EE end-to-end: real bundled relay (formal mode: cipherRequired +
 * pairingRequired defaults), real RemoteGateway as the host, and a Node
 * stand-in for the phone device (same cipher module the Dart client mirrors).
 *
 * Proves: pairing → credential → key agreement → encrypted RPC round-trip,
 * plus the cipher/pairing gates (plaintext and unpaired devices refused).
 *
 * Run: node scratch/e2ee-e2e.mjs   (exits non-zero on any failure)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { importTestBundle } from "../scripts/test-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18_931;
const RELAY_URL = `ws://127.0.0.1:${PORT}/ws`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// Load gateway + cipher through the project's esbuild test bundle
// ---------------------------------------------------------------------------
const mod = await importTestBundle(
  "scratch-e2ee-e2e",
  {
    packages: "external",
    absWorkingDir: root,
    stdin: {
      contents:
        'export { RemoteGateway } from "../src/agent-host/remote/gateway.ts";\n' +
        'export * as cipher from "../src/agent-host/remote/cipher.ts";\n' +
        'export { createRpcServer } from "../src/contract/rpc.ts";\n',
      resolveDir: path.join(root, "scratch"),
      loader: "ts",
    },
  },
  { projectRoot: root },
);

// ---------------------------------------------------------------------------
// Start the bundled relay in FORMAL mode (no diagnostic env at all)
// ---------------------------------------------------------------------------
const stateDir = mkdtempSync(path.join(tmpdir(), "pi-e2ee-relay-"));
const relay = spawn(process.execPath, [path.join(root, "out", "relay", "relay.mjs")], {
  env: { ...process.env, RELAY_PORT: String(PORT), RELAY_STATE_PATH: path.join(stateDir, "pairings.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
let relayStdout = "";
relay.stdout.on("data", (chunk) => (relayStdout += String(chunk)));
relay.stderr.on("data", (chunk) => (relayStdout += String(chunk)));

// Wait for /healthz.
let healthy = false;
for (let i = 0; i < 40 && !healthy; i++) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(500) });
    healthy = response.ok;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
if (!healthy) {
  console.error("relay failed to start:", relayStdout);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Host: RemoteGateway with a static E2EE identity
// ---------------------------------------------------------------------------
const server = mod.createRpcServer();
server.handle({
  "system.runningCount": () => ({ count: 0, sessionIds: [] }),
  "sessions.list": () => ({ sessions: [{ id: "s-encrypted", title: "秘密会话" }], runningSessionIds: [] }),
});
const hostKeys = mod.cipher.generateKeyPair();
const gateway = new mod.RemoteGateway(server, {
  relayUrl: `${RELAY_URL}?role=host`,
  hostId: "host-e2e",
  hostLabel: "E2E PC",
  e2ee: hostKeys,
  connectWebSocket: (url) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on("open", () => resolve(adapt(ws)));
      ws.on("error", reject);
    }),
});
function adapt(ws) {
  // The gateway attaches its listeners after `connect()` resolves — the ws
  // may already be open by then, so buffer the open edge.
  let isOpen = ws.readyState === WebSocket.OPEN;
  const openListeners = [];
  ws.on("open", () => {
    isOpen = true;
    for (const listener of openListeners) listener();
  });
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    on: (event, listener) => {
      if (event === "open") {
        if (isOpen) listener();
        else openListeners.push(listener);
        return;
      }
      ws.on(event, listener);
    },
  };
}
await gateway.start();
await gateway.whenReady();
// The adapter buffers the open edge, but the ws open event still lands on a
// later tick — wait for the gateway to report a live link before control RPCs.
for (let i = 0; i < 100 && gateway.getState() !== "ready"; i++) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (gateway.getState() !== "ready") {
  console.error("gateway never became ready");
  process.exit(1);
}

// Pairing token straight from the relay (pair.create control frame).
const created = await gateway.sendControl("pair.create");
const token = created.token;
check("host: pair.create returns a token", typeof token === "string" && token.length > 10);

// ---------------------------------------------------------------------------
// Device: ephemeral key pair + pairing (mirrors the Dart client flow)
// ---------------------------------------------------------------------------
const deviceKeys = mod.cipher.generateKeyPair();
const deviceWs = new WebSocket(`${RELAY_URL}?role=device`);
await new Promise((resolve, reject) => {
  deviceWs.on("open", resolve);
  deviceWs.on("error", reject);
});
const deviceInbox = [];
const deviceWaiters = [];
deviceWs.on("message", (data) => {
  const frame = JSON.parse(String(data));
  const waiter = deviceWaiters.shift();
  if (waiter) waiter(frame);
  else deviceInbox.push(frame);
});
function nextFrame(timeoutMs = 4000) {
  const queued = deviceInbox.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("device frame timeout")), timeoutMs);
    deviceWaiters.push((frame) => {
      clearTimeout(timer);
      resolve(frame);
    });
  });
}

deviceWs.send(
  JSON.stringify({
    v: 1,
    traceId: randomUUID(),
    ts: Date.now(),
    nonce: randomUUID(),
    role: "device",
    deviceId: "dev-e2e-1",
    hostId: "host-e2e",
    payload: {
      kind: "hello",
      protocolVersion: 1,
      appVersion: "e2e",
      label: "E2E Phone",
      e2eePub: deviceKeys.publicKey,
      auth: { pairingToken: token },
    },
  }),
);
const ack = await nextFrame();
check("device: hello_ack after pairing", ack.payload?.kind === "hello_ack");
const deviceSecret = ack.payload?.deviceSecret;
check("device: credential issued", typeof deviceSecret === "string" && deviceSecret.length > 10);
const hostEntry = (ack.payload?.hosts ?? []).find((h) => h.id === "host-e2e");
const announcedPub = hostEntry?.e2eePub;
check(
  "device: host directory carries e2eePub",
  announcedPub === hostKeys.publicKey,
  `got ${announcedPub?.slice(0, 10)}…`,
);

// Derive session keys and seal the first request.
const restoredDevice = mod.cipher.restoreKeyPair(deviceKeys.publicKey, deviceKeys.privateKey);
const seal = mod.cipher.sealContext(restoredDevice.privateKey, deviceKeys.publicKey, announcedPub, true);
const open = mod.cipher.openContext(restoredDevice.privateKey, deviceKeys.publicKey, announcedPub, true);

function sendEncrypted(method, params) {
  const id = `req-${randomUUID().slice(0, 8)}`;
  const header = {
    v: 1,
    traceId: randomUUID(),
    ts: Date.now(),
    nonce: randomUUID(),
    role: "device",
    deviceId: "dev-e2e-1",
    hostId: "host-e2e",
  };
  const parts = seal.encrypt(JSON.stringify({ kind: "request", id, method, params }), header);
  deviceWs.send(JSON.stringify({ ...header, e2eePub: parts.e2eePub, cipher: parts.cipher, payload: parts.payload }));
  return id;
}

sendEncrypted("sessions.list", { projectRoot: null });
const responseFrame = await nextFrame();
check("device: response frame is ciphertext", typeof responseFrame.payload === "string" && responseFrame.cipher);
const header = {
  v: responseFrame.v,
  traceId: responseFrame.traceId,
  ts: responseFrame.ts,
  nonce: responseFrame.nonce,
  role: responseFrame.role,
  deviceId: responseFrame.deviceId,
};
const clear = JSON.parse(open.decrypt(responseFrame.cipher, responseFrame.payload, header));
check("device: decrypted RPC response ok", clear.ok === true && Array.isArray(clear.result?.sessions));
check("device: host responded with its static key", responseFrame.e2eePub === hostKeys.publicKey);

// ---------------------------------------------------------------------------
// Gates: unpaired device refused; plaintext routed frame refused
// ---------------------------------------------------------------------------
const stranger = new WebSocket(`${RELAY_URL}?role=device`);
await new Promise((resolve, reject) => {
  stranger.on("open", resolve);
  stranger.on("error", reject);
});
const strangerClosed = new Promise((resolve) => stranger.on("close", (code) => resolve(code)));
stranger.send(
  JSON.stringify({
    v: 1,
    traceId: randomUUID(),
    ts: Date.now(),
    nonce: randomUUID(),
    role: "device",
    deviceId: "dev-stranger",
    payload: { kind: "hello", protocolVersion: 1, appVersion: "e2e", auth: {} },
  }),
);
check("gate: unpaired device refused (4003)", (await strangerClosed) === 4003);

const rogue = new WebSocket(`${RELAY_URL}?role=device`);
await new Promise((resolve, reject) => {
  rogue.on("open", resolve);
  rogue.on("error", reject);
});
// Paired device reconnects with its credential — must be accepted…
rogue.send(
  JSON.stringify({
    v: 1,
    traceId: randomUUID(),
    ts: Date.now(),
    nonce: randomUUID(),
    role: "device",
    deviceId: "dev-e2e-1",
    hostId: "host-e2e",
    payload: {
      kind: "hello",
      protocolVersion: 1,
      appVersion: "e2e",
      label: "E2E Phone",
      e2eePub: deviceKeys.publicKey,
      auth: { deviceSecret },
    },
  }),
);
const reconnectAck = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("reconnect timeout")), 4000);
  rogue.on("message", (data) => {
    clearTimeout(timer);
    resolve(JSON.parse(String(data)));
  });
  rogue.on("close", (code) => {
    clearTimeout(timer);
    reject(new Error(`reconnect closed ${code}`));
  });
});
check("device: reconnect via credential accepted", reconnectAck.payload?.kind === "hello_ack");
// …then a plaintext routed frame must be refused by the relay.
const plaintextClosed = new Promise((resolve) => rogue.on("close", (code) => resolve(code)));
rogue.send(
  JSON.stringify({
    v: 1,
    traceId: randomUUID(),
    ts: Date.now(),
    nonce: randomUUID(),
    role: "device",
    deviceId: "dev-e2e-1",
    hostId: "host-e2e",
    payload: { kind: "request", id: "plain-1", method: "sessions.list", params: null },
  }),
);
check("gate: plaintext routed frame refused (4002)", (await plaintextClosed) === 4002);

// ---------------------------------------------------------------------------
// Zero-knowledge: the relay's stdout (audit + logs) never saw session content
// ---------------------------------------------------------------------------
await new Promise((resolve) => setTimeout(resolve, 200));
check(
  "relay: plaintext markers absent from relay output",
  !relayStdout.includes("秘密会话") && !relayStdout.includes("sessions.list"),
);

// Relay restart → bindings survive (persistence file).
relay.kill();
await new Promise((resolve) => relay.on("exit", resolve));
const relay2 = spawn(process.execPath, [path.join(root, "out", "relay", "relay.mjs")], {
  env: { ...process.env, RELAY_PORT: String(PORT), RELAY_STATE_PATH: path.join(stateDir, "pairings.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
let healthy2 = false;
for (let i = 0; i < 40 && !healthy2; i++) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(500) });
    healthy2 = response.ok;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
check("relay: restarted healthy", healthy2);
const afterRestart = new WebSocket(`${RELAY_URL}?role=device`);
await new Promise((resolve, reject) => {
  afterRestart.on("open", resolve);
  afterRestart.on("error", reject);
});
const afterAck = new Promise((resolve) => afterRestart.once("message", (data) => resolve(JSON.parse(String(data)))));
afterRestart.send(
  JSON.stringify({
    v: 1,
    traceId: randomUUID(),
    ts: Date.now(),
    nonce: randomUUID(),
    role: "device",
    deviceId: "dev-e2e-1",
    hostId: "host-e2e",
    payload: {
      kind: "hello",
      protocolVersion: 1,
      appVersion: "e2e",
      e2eePub: deviceKeys.publicKey,
      auth: { deviceSecret },
    },
  }),
);
const reack = await afterAck;
check("pairing: credential survives relay restart", reack.payload?.kind === "hello_ack");

// cleanup
afterRestart.close();
deviceWs.close();
gateway.dispose();
relay2.kill();
await new Promise((resolve) => setTimeout(resolve, 150));
try {
  rmSync(stateDir, { recursive: true, force: true });
} catch {
  /* best-effort cleanup */
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  writeFileSync(path.join(root, "scratch", "e2ee-e2e-last.log"), relayStdout, "utf8");
  process.exit(1);
}
