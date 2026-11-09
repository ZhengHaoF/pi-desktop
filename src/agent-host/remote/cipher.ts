/**
 * E2EE cipher layer for the remote control plane (Step 2).
 *
 * Design: X25519 ECDH between the host's static key and the device's
 * ephemeral key per connection → HKDF-SHA256 → AES-256-GCM. The relay is
 * zero-knowledge: envelopes carry a base64 ciphertext payload plus a cipher
 * block; the envelope header (both e2eePub keys + cipher metadata) is bound
 * as AAD so the relay cannot reroute or re-target frames unnoticed.
 *
 * Replay defense is end-to-end (the relay's ts window only sees plaintext
 * headers): each direction keeps a sliding nonce cache; duplicates and stale
 * timestamps are rejected on decrypt.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

export const CIPHER_ALG = "x25519-aes-gcm";
const HKDF_SALT_PREFIX = "pi-remote-e2ee-v1";
const INFO_C2H = "device-to-host";
const INFO_H2C = "host-to-device";
/** Fixed AAD field order — the Dart client must mirror it byte for byte. */
const AAD_HEADER_KEYS = ["v", "traceId", "ts", "nonce", "role", "deviceId", "hostId", "e2eePub"] as const;

export interface E2eeKeyPair {
  /** base64url raw 32-byte X25519 public key (goes on the wire). */
  publicKey: string;
  /** PKCS8 DER base64 — persisted at rest, never on the wire. */
  privateKey: string;
}

export interface CipherBlock {
  alg: string;
  /** Fingerprint of the sending key pair (sha256 of the public key). */
  keyId: string;
  /** base64 12-byte GCM IV. */
  iv: string;
  /** base64 16-byte GCM auth tag (kept out of the ciphertext body). */
  tag: string;
}

export interface EncryptedEnvelopeParts {
  cipher: CipherBlock;
  /** base64 ciphertext (tag travels in the cipher block). */
  payload: string;
  /** Sender's base64url public key. */
  e2eePub: string;
}

export interface SealedContext {
  /** Peer's public key this context is bound to (base64url). */
  peerPub: string;
  keyId: string;
  /**
   * Encrypt a cleartext under the final envelope header. `header` must
   * contain every field the receiver will see except `payload` and `cipher`
   * (e2eePub is filled in here). Changing any header byte breaks the tag.
   * `ivOverride` is for golden tests only.
   */
  encrypt(cleartext: string, header: Record<string, unknown>, ivOverride?: Buffer): EncryptedEnvelopeParts;
}

export interface OpenedContext {
  peerPub: string;
  keyId: string;
  /** Throws on tamper, replay or clock drift outside the window. */
  decrypt(cipher: CipherBlock, payload: string, header: Record<string, unknown>): string;
}

function b64urlToBuf(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function keyIdOf(publicKeyB64url: string): string {
  return createHash("sha256").update(publicKeyB64url, "utf8").digest("base64url").slice(0, 16);
}

export function generateKeyPair(): E2eeKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  return { publicKey: jwk.x, privateKey: pkcs8.toString("base64") };
}

/** Restore key objects from a persisted pair (raw pub + PKCS8 DER base64). */
export function restoreKeyPair(publicKey: string, privateKey: string): { publicKey: KeyObject; privateKey: KeyObject } {
  return {
    publicKey: createPublicFromRaw(publicKey),
    privateKey: createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" }),
  };
}

export function createPublicFromRaw(publicKeyB64url: string): KeyObject {
  const raw = b64urlToBuf(publicKeyB64url);
  if (raw.length !== 32) throw new Error("x25519 public key must be 32 raw bytes");
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: publicKeyB64url }, format: "jwk" });
}

/** HKDF shared secrets, one per direction, from raw peer + own public keys. */
function deriveKeys(
  ownPrivate: KeyObject,
  peerPublicRaw: string,
  ownPublicRaw: string,
  isDevice: boolean,
): { c2h: Buffer; h2c: Buffer } {
  const shared = diffieHellman({ privateKey: ownPrivate, publicKey: createPublicFromRaw(peerPublicRaw) });
  const devicePub = isDevice ? ownPublicRaw : peerPublicRaw;
  const hostPub = isDevice ? peerPublicRaw : ownPublicRaw;
  const salt = createHash("sha256").update(`${HKDF_SALT_PREFIX}|${devicePub}|${hostPub}`).digest();
  const c2h = Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(INFO_C2H), 32));
  const h2c = Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(INFO_H2C), 32));
  return { c2h, h2c };
}

/**
 * Canonical JSON of exactly the fields that participate in authentication.
 * Both sides must produce byte-identical strings for the same envelope —
 * field order is fixed (AAD_HEADER_KEYS), unknown header fields are
 * excluded. Exported for the cross-language golden tests (the Dart client
 * reimplements it).
 */
export function canonicalAad(header: Record<string, unknown>): Buffer {
  const picked: Record<string, unknown> = {};
  for (const key of AAD_HEADER_KEYS) {
    if (header[key] !== undefined) picked[key] = header[key];
  }
  return Buffer.from(JSON.stringify(picked), "utf8");
}

/** Canonical JSON of the cipher block (alg/keyId/iv) for the receiving AAD. */
export function canonicalCipher(cipher: CipherBlock): Buffer {
  return Buffer.from(JSON.stringify({ alg: cipher.alg, keyId: cipher.keyId, iv: cipher.iv }), "utf8");
}

const REPLAY_CACHE_MAX = 4096;
export const REPLAY_WINDOW_MS = 120_000;

/** Sliding-window nonce cache: rejects duplicates + stale timestamps. */
class ReplayCache {
  private readonly seen = new Map<string, number>();

  checkAndRecord(nonce: string, ts: number, now: number, windowMs: number): boolean {
    if (!Number.isFinite(ts) || Math.abs(now - ts) > windowMs) return false;
    if (nonce && this.seen.has(nonce)) return false;
    if (this.seen.size >= REPLAY_CACHE_MAX) this.seen.delete(this.seen.keys().next().value as string);
    if (nonce) this.seen.set(nonce, ts);
    return true;
  }
}

export interface ContextOptions {
  replayWindowMs?: number;
  now?: () => number;
}

export function sealContext(
  ownPrivate: KeyObject,
  ownPublicRaw: string,
  peerPublicRaw: string,
  isDevice: boolean,
  _options: ContextOptions = {},
): SealedContext {
  const { c2h, h2c } = deriveKeys(ownPrivate, peerPublicRaw, ownPublicRaw, isDevice);
  const key = isDevice ? c2h : h2c;
  const keyId = keyIdOf(ownPublicRaw);
  return {
    peerPub: peerPublicRaw,
    keyId,
    encrypt(cleartext: string, header: Record<string, unknown>, ivOverride?: Buffer): EncryptedEnvelopeParts {
      const iv = ivOverride ?? randomBytes(12);
      const cipher: CipherBlock = { alg: CIPHER_ALG, keyId, iv: iv.toString("base64"), tag: "" };
      const aead = createCipheriv("aes-256-gcm", key, iv);
      aead.setAAD(Buffer.concat([canonicalAad({ ...header, e2eePub: ownPublicRaw }), canonicalCipher(cipher)]));
      const encrypted = Buffer.concat([aead.update(cleartext, "utf8"), aead.final()]);
      cipher.tag = aead.getAuthTag().toString("base64");
      return { cipher, payload: encrypted.toString("base64"), e2eePub: ownPublicRaw };
    },
  };
}

export function openContext(
  ownPrivate: KeyObject,
  ownPublicRaw: string,
  peerPublicRaw: string,
  isDevice: boolean,
  options: ContextOptions = {},
): OpenedContext {
  const { c2h, h2c } = deriveKeys(ownPrivate, peerPublicRaw, ownPublicRaw, isDevice);
  const key = isDevice ? h2c : c2h;
  const replay = new ReplayCache();
  const windowMs = options.replayWindowMs ?? REPLAY_WINDOW_MS;
  const now = options.now ?? Date.now;
  return {
    peerPub: peerPublicRaw,
    keyId: keyIdOf(peerPublicRaw),
    decrypt(cipher: CipherBlock, payload: string, header: Record<string, unknown>): string {
      if (cipher.alg !== CIPHER_ALG) throw new Error(`cipher alg mismatch: ${cipher.alg}`);
      if (!replay.checkAndRecord(String(header.nonce ?? ""), header.ts as number, now(), windowMs)) {
        throw new Error("replay detected or timestamp outside window");
      }
      const iv = Buffer.from(cipher.iv, "base64");
      const tag = Buffer.from(cipher.tag ?? "", "base64");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("invalid IV or tag length");
      const body = Buffer.from(payload, "base64");
      const aead = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      aead.setAAD(Buffer.concat([canonicalAad({ ...header, e2eePub: peerPublicRaw }), canonicalCipher(cipher)]));
      aead.setAuthTag(tag);
      return Buffer.concat([aead.update(body), aead.final()]).toString("utf8");
    },
  };
}
