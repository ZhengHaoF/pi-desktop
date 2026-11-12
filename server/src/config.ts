/**
 * Relay configuration — validated at startup, fail-closed.
 */
export interface RelayConfig {
  /** Listen port for HTTP + WS. */
  port: number;
  /** Reject plaintext payloads unconditionally. */
  cipherRequired: boolean;
  /** Reject devices that never completed pairing (token → device credential). */
  pairingRequired: boolean;
  /** Maximum envelope timestamp drift accepted. */
  replayWindowMs: number;
  /** Per-device token bucket: requests per window. */
  rateLimitMax: number;
  rateLimitWindowMs: number;
  /** Pairing token TTL and max failed attempts. */
  pairingTtlMs: number;
  pairingMaxAttempts: number;
  /** JSON file for device-binding persistence (unset: in-memory only). */
  statePath?: string;
  /** JSONL diagnostic log for hello/pairing forensics (unset: disabled). */
  debugLogPath?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const port = Number(env.RELAY_PORT ?? 8788);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`RELAY_PORT invalid: ${env.RELAY_PORT ?? "(unset)"}`);
  }
  const cipherRequired = (env.RELAY_CIPHER_REQUIRED ?? "true") !== "false";
  const pairingRequired = (env.RELAY_PAIRING_REQUIRED ?? "true") !== "false";
  if ((!cipherRequired || !pairingRequired) && (env.RELAY_ALLOW_PLAINTEXT_PUBLIC ?? "") !== "diagnostic") {
    throw new Error(
      "RELAY_CIPHER_REQUIRED=false / RELAY_PAIRING_REQUIRED=false require RELAY_ALLOW_PLAINTEXT_PUBLIC=diagnostic (loopback testing only)",
    );
  }
  const num = (name: string, fallback: number, min: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${name} invalid: ${raw}`);
    return parsed;
  };
  return {
    port,
    cipherRequired,
    pairingRequired,
    replayWindowMs: num("RELAY_REPLAY_WINDOW_MS", 120_000, 1_000),
    rateLimitMax: num("RELAY_RATE_LIMIT_MAX", 240, 1),
    rateLimitWindowMs: num("RELAY_RATE_LIMIT_WINDOW_MS", 60_000, 1_000),
    pairingTtlMs: num("RELAY_PAIRING_TTL_MS", 10 * 60_000, 10_000),
    pairingMaxAttempts: num("RELAY_PAIRING_MAX_ATTEMPTS", 5, 1),
    ...(env.RELAY_STATE_PATH ? { statePath: env.RELAY_STATE_PATH } : {}),
    ...(env.RELAY_DEBUG_LOG ? { debugLogPath: env.RELAY_DEBUG_LOG } : {}),
  };
}
