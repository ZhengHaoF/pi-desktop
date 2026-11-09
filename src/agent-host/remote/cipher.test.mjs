/**
 * E2EE cipher tests: X25519 ECDH + HKDF + AES-256-GCM round-trips, AAD
 * tamper binding, replay/window rejection, and cross-language golden
 * vectors (the Dart client test mirrors these exact fixtures).
 *
 * The cipher module is TypeScript; it is loaded through the project's
 * esbuild test bundle (same mechanism as gateway.test.mjs).
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
    "src/agent-host/remote-cipher",
    {
      packages: "external",
      absWorkingDir: root,
      stdin: {
        contents: 'export * from "./remote/cipher.ts";\n',
        resolveDir: path.join(import.meta.dirname, ".."),
        loader: "ts",
      },
    },
    { projectRoot: root },
  );
  return modulePromise;
}

// Deterministic keys (raw 32-byte scalars) shared with mobile/test/e2ee_test.dart.
const DEV_PRIV_PKCS8_B64 = "MC4CAQAwBQYDK2VuBCIEIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g";
const HOST_PRIV_PKCS8_B64 = "MC4CAQAwBQYDK2VuBCIEIKChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/";
const DEV_PUB = "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw";
const HOST_PUB = "YFpyXSpK3-6xop4X7dYhwbdZPujNvESsbEq24vgF0jw";
const FIXED_IV = Buffer.from("00112233445566778899aabb", "hex");
const FIXED_TS = 1_762_656_000_000;

const GOLDEN_C2H = {
  cipher: {
    alg: "x25519-aes-gcm",
    keyId: "VSr9Bdp8PA7hhIDN",
    iv: "ABEiM0RVZneImaq7",
    tag: "51mwZsz9PSqxG3cMkcaGtA==",
  },
  payload: "tj/Axjpv9MGFSw1nvJ73do2KVQg4z7Wce7iZqzEebG0oC/tbg68GXalX2pWyTOYmQS8g88/JX40NpZ1GNhri/zHv8cw=",
  e2eePub: DEV_PUB,
};
const GOLDEN_H2C = {
  cipher: {
    alg: "x25519-aes-gcm",
    keyId: "GOj1R9-MjdbSWLaw",
    iv: "ABEiM0RVZneImaq7",
    tag: "5yKUEScaAg3009Yi+JXBKA==",
  },
  payload: "eytog4Bdme1xdJyIab3t58mpD0LMgUPNvIt2hVUR7JkQd/V4ypScxA==",
  e2eePub: HOST_PUB,
};
const GOLDEN_AAD =
  '{"v":1,"traceId":"trace-golden","ts":1762656000000,"nonce":"nonce-golden","role":"device","deviceId":"device-golden","hostId":"host-golden","e2eePub":"B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw"}';

test("generate/restore key pair round-trip and shared secret agreement", async () => {
  const mod = await loadRemoteModule();
  const host = mod.generateKeyPair();
  const dev = mod.generateKeyPair();
  const hostKeys = mod.restoreKeyPair(host.publicKey, host.privateKey);
  const devKeys = mod.restoreKeyPair(dev.publicKey, dev.privateKey);
  const sealD = mod.sealContext(devKeys.privateKey, dev.publicKey, host.publicKey, true);
  const openH = mod.openContext(hostKeys.privateKey, host.publicKey, dev.publicKey, false);
  const ts = Date.now();
  const header = { v: 1, traceId: "t1", ts, nonce: "n1", role: "device", deviceId: "dev-1", hostId: "host-1" };
  const parts = sealD.encrypt(JSON.stringify({ kind: "request", method: "sessions.list" }), header);
  assert.equal(
    JSON.parse(openH.decrypt(parts.cipher, parts.payload, { ...header, e2eePub: parts.e2eePub })).method,
    "sessions.list",
  );
  // host -> device direction uses the derived h2c key
  const sealH = mod.sealContext(hostKeys.privateKey, host.publicKey, dev.publicKey, false);
  const openD = mod.openContext(devKeys.privateKey, dev.publicKey, host.publicKey, true);
  const headerH = { v: 1, traceId: "t2", ts, nonce: "n2", role: "host", deviceId: "dev-1" };
  const partsH = sealH.encrypt("hello-device", headerH);
  assert.equal(openD.decrypt(partsH.cipher, partsH.payload, { ...headerH, e2eePub: partsH.e2eePub }), "hello-device");
});

test("golden vectors: fixed keys + fixed IV produce byte-identical output", async () => {
  const mod = await loadRemoteModule();
  const hostKeys = mod.restoreKeyPair(HOST_PUB, HOST_PRIV_PKCS8_B64);
  const devKeys = mod.restoreKeyPair(DEV_PUB, DEV_PRIV_PKCS8_B64);
  const sealD = mod.sealContext(devKeys.privateKey, DEV_PUB, HOST_PUB, true);
  const sealH = mod.sealContext(hostKeys.privateKey, HOST_PUB, DEV_PUB, false);
  const header = {
    v: 1,
    traceId: "trace-golden",
    ts: FIXED_TS,
    nonce: "nonce-golden",
    role: "device",
    deviceId: "device-golden",
    hostId: "host-golden",
  };
  const c2h = sealD.encrypt('{"kind":"request","id":"g-1","method":"sessions.list","params":null}', header, FIXED_IV);
  assert.deepEqual(c2h, GOLDEN_C2H);
  const headerH = {
    v: 1,
    traceId: "trace-golden-h",
    ts: FIXED_TS,
    nonce: "nonce-golden-h",
    role: "host",
    deviceId: "device-golden",
  };
  const h2c = sealH.encrypt('{"kind":"response","id":"g-1","ok":true}', headerH, FIXED_IV);
  assert.deepEqual(h2c, GOLDEN_H2C);
  assert.equal(mod.canonicalAad({ ...header, e2eePub: DEV_PUB }).toString(), GOLDEN_AAD);
  // Receiving side recovers the plaintext from the golden vectors (fixed clock:
  // the vector's ts is frozen in the past).
  const openH = mod.openContext(hostKeys.privateKey, HOST_PUB, DEV_PUB, false, { now: () => FIXED_TS });
  assert.equal(
    openH.decrypt(GOLDEN_C2H.cipher, GOLDEN_C2H.payload, { ...header, e2eePub: DEV_PUB }),
    '{"kind":"request","id":"g-1","method":"sessions.list","params":null}',
  );
});

test("header tamper breaks authentication (AAD binding)", async () => {
  const mod = await loadRemoteModule();
  const hostKeys = mod.restoreKeyPair(HOST_PUB, HOST_PRIV_PKCS8_B64);
  const devKeys = mod.restoreKeyPair(DEV_PUB, DEV_PRIV_PKCS8_B64);
  const sealD = mod.sealContext(devKeys.privateKey, DEV_PUB, HOST_PUB, true);
  const openH = mod.openContext(hostKeys.privateKey, HOST_PUB, DEV_PUB, false);
  const header = {
    v: 1,
    traceId: "t3",
    ts: Date.now(),
    nonce: "n3",
    role: "device",
    deviceId: "dev-1",
    hostId: "host-1",
  };
  const parts = sealD.encrypt("secret-content", header);
  assert.throws(
    () => openH.decrypt(parts.cipher, parts.payload, { ...header, deviceId: "dev-OTHER", e2eePub: parts.e2eePub }),
    /authenticate|replay/,
  );
});

test("ciphertext tamper breaks authentication", async () => {
  const mod = await loadRemoteModule();
  const hostKeys = mod.restoreKeyPair(HOST_PUB, HOST_PRIV_PKCS8_B64);
  const devKeys = mod.restoreKeyPair(DEV_PUB, DEV_PRIV_PKCS8_B64);
  const sealD = mod.sealContext(devKeys.privateKey, DEV_PUB, HOST_PUB, true);
  const openH = mod.openContext(hostKeys.privateKey, HOST_PUB, DEV_PUB, false);
  const header = {
    v: 1,
    traceId: "t4",
    ts: Date.now(),
    nonce: "n4",
    role: "device",
    deviceId: "dev-1",
    hostId: "host-1",
  };
  const parts = sealD.encrypt("secret-content", header);
  assert.throws(
    () => openH.decrypt(parts.cipher, parts.payload.slice(0, -4) + "AAAA", { ...header, e2eePub: parts.e2eePub }),
    /authenticate/,
  );
});

test("replay: duplicate nonce and stale timestamp rejected", async () => {
  const mod = await loadRemoteModule();
  const hostKeys = mod.restoreKeyPair(HOST_PUB, HOST_PRIV_PKCS8_B64);
  const devKeys = mod.restoreKeyPair(DEV_PUB, DEV_PRIV_PKCS8_B64);
  const sealD = mod.sealContext(devKeys.privateKey, DEV_PUB, HOST_PUB, true);
  const openH = mod.openContext(hostKeys.privateKey, HOST_PUB, DEV_PUB, false);
  const ts = Date.now();
  const header = { v: 1, traceId: "t5", ts, nonce: "n5", role: "device", deviceId: "dev-1", hostId: "host-1" };
  const parts = sealD.encrypt("once", header);
  const recvHeader = { ...header, e2eePub: parts.e2eePub };
  openH.decrypt(parts.cipher, parts.payload, recvHeader);
  assert.throws(() => openH.decrypt(parts.cipher, parts.payload, recvHeader), /replay/);
  const staleHeader = { ...header, nonce: "n5b", ts: ts - 300_000 };
  const stale = sealD.encrypt("old", staleHeader);
  assert.throws(
    () => openH.decrypt(stale.cipher, stale.payload, { ...staleHeader, e2eePub: stale.e2eePub }),
    /replay|window/,
  );
});
