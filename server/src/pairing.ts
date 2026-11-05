/**
 * Pairing: one-time high-entropy tokens approved on the PC side.
 * Tokens are stored hashed; failed attempts are capped and lock the token.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RelayConfig } from "./config.ts";
import type { AuditLog } from "./audit.ts";

export interface PairingRecord {
  tokenHash: string;
  hostId: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  status: "pending" | "approved" | "consumed" | "expired" | "locked";
  deviceId?: string;
  devicePublicKey?: string;
}

export class PairingService {
  private readonly config: RelayConfig;
  private readonly audit: AuditLog;
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly unknownAttempts = new Map<string, { count: number; windowStart: number }>();

  constructor(config: RelayConfig, audit: AuditLog) {
    this.config = config;
    this.audit = audit;
  }

  static hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  static verifyToken(token: string, hash: string): boolean {
    const computed = Buffer.from(PairingService.hashToken(token), "hex");
    const expected = Buffer.from(hash, "hex");
    return computed.length === expected.length && timingSafeEqual(computed, expected);
  }

  /** PC requests a fresh pairing token; returns the plaintext token once. */
  create(hostId: string): { token: string; expiresAt: number } {
    const token = randomBytes(24).toString("base64url");
    const now = Date.now();
    const record: PairingRecord = {
      tokenHash: PairingService.hashToken(token),
      hostId,
      createdAt: now,
      expiresAt: now + this.config.pairingTtlMs,
      attempts: 0,
      status: "pending",
    };
    this.pairings.set(record.tokenHash, record);
    this.audit.append({
      actor: hostId,
      action: "pair.request",
      targetDigest: this.audit.digest(hostId),
      outcome: "ok",
      traceId: "pair",
    });
    return { token, expiresAt: record.expiresAt };
  }

  /**
   * Device submits a token + public key. The record stays "pending" until
   * the PC-side approve() flips it — matching the protocol flow in
   * docs/remote-control-plan.md §8.2. Failed attempts (wrong hostId) count
   * toward a per-token lockout keyed by the presented token hash.
   */
  submit(
    token: string,
    hostId: string,
    deviceId: string,
    publicKey: string,
  ): { ok: true; record: PairingRecord; awaitingApproval: boolean } | { ok: false; reason: string } {
    const hash = PairingService.hashToken(token);
    const record = this.pairings.get(hash);
    if (record) {
      if (record.status === "locked") return { ok: false, reason: "pairing locked" };
      if (record.status !== "pending") return { ok: false, reason: `pairing ${record.status}` };
      if (Date.now() > record.expiresAt) {
        record.status = "expired";
        return { ok: false, reason: "pairing expired" };
      }
      if (record.hostId !== hostId) {
        record.attempts += 1;
        if (record.attempts > this.config.pairingMaxAttempts) {
          record.status = "locked";
          this.audit.append({
            actor: deviceId,
            action: "pair.reject",
            targetDigest: this.audit.digest(hostId, deviceId),
            outcome: "denied",
            traceId: "pair",
          });
          return { ok: false, reason: "pairing locked" };
        }
        return { ok: false, reason: "pairing token bound to another host" };
      }
    } else {
      // Unknown token: track attempts under its own hash to enable lockout.
      const existing = this.unknownAttempts.get(hash);
      const now = Date.now();
      const count = existing && now - existing.windowStart < this.config.pairingTtlMs ? existing.count + 1 : 1;
      this.unknownAttempts.set(hash, { count, windowStart: existing?.windowStart ?? now });
      if (count > this.config.pairingMaxAttempts) {
        this.audit.append({
          actor: deviceId,
          action: "pair.reject",
          targetDigest: this.audit.digest(hostId, deviceId),
          outcome: "denied",
          traceId: "pair",
        });
        return { ok: false, reason: "pairing locked" };
      }
      return { ok: false, reason: "unknown pairing token" };
    }
    record.deviceId = deviceId;
    record.devicePublicKey = publicKey;
    this.audit.append({
      actor: deviceId,
      action: "pair.request",
      targetDigest: this.audit.digest(hostId, deviceId),
      outcome: "ok",
      traceId: "pair",
    });
    return { ok: true, record, awaitingApproval: true };
  }

  /** PC-side approval flips a submitted pairing into consumable state. */
  approve(token: string): boolean {
    const record = this.pairings.get(PairingService.hashToken(token));
    if (!record || record.status !== "pending") return false;
    record.status = "approved";
    return true;
  }

  consume(token: string): void {
    const record = this.pairings.get(PairingService.hashToken(token));
    if (record) record.status = "consumed";
  }

  prune(now = Date.now()): void {
    for (const [hash, record] of this.pairings) {
      if (record.status !== "pending") continue;
      if (now > record.expiresAt) {
        record.status = "expired";
        this.pairings.delete(hash);
      }
    }
  }

  get size(): number {
    return this.pairings.size;
  }
}
