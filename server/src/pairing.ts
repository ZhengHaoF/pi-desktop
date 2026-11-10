/**
 * Pairing: one-time high-entropy tokens approved on the PC side.
 * Tokens are stored hashed; failed attempts are capped and lock the token.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

/** One host binding for a device; the secret never leaves the relay hashed. */
export interface DeviceBinding {
  deviceId: string;
  hostId: string;
  secretHash: string;
  label?: string;
  /** Device's X25519 public key captured at pairing time (metadata only). */
  publicKey?: string;
  pairedAt: number;
}

export class PairingService {
  private readonly config: RelayConfig;
  private readonly audit: AuditLog;
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly unknownAttempts = new Map<string, { count: number; windowStart: number }>();
  /** One binding per (deviceId, hostId): a phone may pair with several PCs. */
  private readonly devices = new Map<string, DeviceBinding>();

  /** Composite key keeps per-host bindings independent for the same device. */
  private bindingKey(deviceId: string, hostId: string): string {
    return `${deviceId}\u0000${hostId}`;
  }

  constructor(config: RelayConfig, audit: AuditLog) {
    this.config = config;
    this.audit = audit;
    this.loadPersisted();
  }

  /**
   * Device bindings survive relay restarts (the desktop-hosted LAN relay
   * restarts with every app launch; with pairingRequired on, an in-memory
   * table would force a re-scan on every start).
   */
  private loadPersisted(): void {
    if (!this.config.statePath || !existsSync(this.config.statePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.config.statePath, "utf8")) as { devices?: unknown };
      if (!Array.isArray(parsed.devices)) return;
      for (const item of parsed.devices) {
        if (!item || typeof item !== "object") continue;
        const record = item as Partial<DeviceBinding>;
        if (
          typeof record.deviceId !== "string" ||
          typeof record.hostId !== "string" ||
          typeof record.secretHash !== "string"
        )
          continue;
        this.devices.set(this.bindingKey(record.deviceId, record.hostId), {
          deviceId: record.deviceId,
          hostId: record.hostId,
          secretHash: record.secretHash,
          ...(record.label ? { label: record.label } : {}),
          ...(record.publicKey ? { publicKey: record.publicKey } : {}),
          pairedAt: typeof record.pairedAt === "number" ? record.pairedAt : Date.now(),
        });
      }
    } catch {
      // Corrupt state file: start empty (devices re-pair by scanning again).
    }
  }

  private persist(): void {
    if (!this.config.statePath) return;
    try {
      const payload = JSON.stringify({ v: 1, devices: [...this.devices.values()] });
      mkdirSync(dirname(this.config.statePath), { recursive: true });
      writeFileSync(this.config.statePath, payload, "utf8");
    } catch {
      // Best-effort persistence; the in-memory table stays authoritative.
    }
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

  /**
   * Bind a device to one host and issue its credential. Called after a
   * successful token submit + approve. Other host bindings for the same
   * device are kept; re-pairing only replaces this (device, host) pair.
   */
  pairDevice(
    hostId: string,
    deviceId: string,
    label?: string,
    publicKey?: string,
  ): { secret: string; binding: DeviceBinding } {
    const secret = randomBytes(24).toString("base64url");
    const binding: DeviceBinding = {
      deviceId,
      hostId,
      secretHash: PairingService.hashToken(secret),
      ...(label ? { label } : {}),
      ...(publicKey ? { publicKey } : {}),
      pairedAt: Date.now(),
    };
    this.devices.set(this.bindingKey(deviceId, hostId), binding);
    this.persist();
    this.audit.append({
      actor: hostId,
      action: "pair.approve",
      targetDigest: this.audit.digest(hostId, deviceId),
      outcome: "ok",
      traceId: "pair",
    });
    return { secret, binding };
  }

  /** Reconnect credential check: the secret must belong to this exact host. */
  verifyDevice(deviceId: string, secret: string, hostId: string): DeviceBinding | undefined {
    const binding = this.devices.get(this.bindingKey(deviceId, hostId));
    if (!binding) return undefined;
    if (!PairingService.verifyToken(secret, binding.secretHash)) return undefined;
    return binding;
  }

  /** Host-initiated revocation of one (device, host) binding. */
  revokeDevice(hostId: string, deviceId: string): boolean {
    const key = this.bindingKey(deviceId, hostId);
    if (!this.devices.has(key)) return false;
    this.devices.delete(key);
    this.persist();
    this.audit.append({
      actor: hostId,
      action: "device.revoke",
      targetDigest: this.audit.digest(hostId, deviceId),
      outcome: "ok",
      traceId: "pair",
    });
    return true;
  }

  /** Device-initiated unbind: a device may only drop its own binding for one host. */
  unbindDevice(deviceId: string, hostId: string): boolean {
    const key = this.bindingKey(deviceId, hostId);
    if (!this.devices.has(key)) return false;
    this.devices.delete(key);
    this.persist();
    this.audit.append({
      actor: deviceId,
      action: "device.unbind",
      targetDigest: this.audit.digest(hostId, deviceId),
      outcome: "ok",
      traceId: "pair",
    });
    return true;
  }

  /** Host-scoped device list (secrets excluded). */
  listDevices(hostId: string): Array<Omit<DeviceBinding, "secretHash">> {
    return [...this.devices.values()]
      .filter((binding) => binding.hostId === hostId)
      .map((binding) => {
        const { secretHash, ...rest } = binding;
        void secretHash;
        return rest;
      });
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
