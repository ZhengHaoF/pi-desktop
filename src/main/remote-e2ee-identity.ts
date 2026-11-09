/**
 * Host E2EE identity for the remote control plane (Step 2).
 *
 * The PC holds a static X25519 key pair. The public key travels in uiState
 * (renderers draw the pairing QR with it); the private key lives in its own
 * file under userData and is handed only to the agent-host gateway — it is
 * deliberately excluded from uiState so renderer code can never read it.
 */
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateE2eeKeyPair, isE2eeKeyPair, type E2eeKeyPair } from "../shared/remote-e2ee-keys";

const IDENTITY_FILE = "remote-host-e2ee.json";

let cached: E2eeKeyPair | null = null;

function identityPath(): string {
  return path.join(app.getPath("userData"), IDENTITY_FILE);
}

/** Load (or lazily create on first use) the host's static key pair. */
export function loadHostE2eeIdentity(): E2eeKeyPair {
  if (cached) return cached;
  const file = identityPath();
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (isE2eeKeyPair(parsed)) {
        cached = parsed;
        return cached;
      }
    } catch {
      // fall through and regenerate
    }
  }
  const pair = generateE2eeKeyPair();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(pair), "utf8");
  } catch {
    // Unwritable userData: the pair stays in memory (regenerated next start).
  }
  cached = pair;
  return cached;
}

/** Test seam: forget the cached identity. */
export function resetHostE2eeIdentityCache(): void {
  cached = null;
}
