/**
 * E2EE identity helpers shared between the main process (persistence) and
 * the agent-host gateway (cipher). Raw X25519 public keys are base64url on
 * the wire; private keys persist as PKCS8 DER base64.
 */
import { generateKeyPairSync } from "node:crypto";

export interface E2eeKeyPair {
  /** base64url raw 32-byte X25519 public key (goes on the wire). */
  publicKey: string;
  /** PKCS8 DER base64 — persisted at rest, never on the wire. */
  privateKey: string;
}

export function generateE2eeKeyPair(): E2eeKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  return { publicKey: jwk.x, privateKey: pkcs8.toString("base64") };
}

export function isE2eeKeyPair(value: unknown): value is E2eeKeyPair {
  if (!value || typeof value !== "object") return false;
  const pair = value as Partial<E2eeKeyPair>;
  return (
    typeof pair.publicKey === "string" &&
    pair.publicKey.length >= 40 &&
    typeof pair.privateKey === "string" &&
    pair.privateKey.length >= 40
  );
}
