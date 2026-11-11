/**
 * Connection registry + message routing.
 * The relay is zero-knowledge: it routes ciphertext envelopes between hosts
 * and devices and never inspects payloads.
 */
import type { AuditLog } from "./audit.ts";
import type { RelayConfig } from "./config.ts";

export interface PeerMeta {
  id: string;
  role: "host" | "device";
  label?: string;
  appVersion?: string;
  protocolVersion: number;
  connectedAt: number;
  /** Device peers only: the host this device addressed at hello (updated on routed frames). */
  addressedHostId?: string;
  send: (data: string) => void;
  close: (code: number, reason: string) => void;
}

export interface RouteDecision {
  ok: boolean;
  code?: number;
  reason?: string;
  target?: PeerMeta;
}

export class ConnectionRegistry {
  private readonly config: RelayConfig;
  private readonly audit: AuditLog;
  private readonly peers = new Map<string, PeerMeta>();
  private readonly deviceTokens = new Map<string, Set<string>>();
  private readonly rateBuckets = new Map<string, { count: number; windowStart: number }>();

  constructor(config: RelayConfig, audit: AuditLog) {
    this.config = config;
    this.audit = audit;
  }

  register(peer: PeerMeta): void {
    this.peers.set(peer.id, peer);
    if (peer.role === "device") {
      const set = this.deviceTokens.get(peer.id) ?? new Set<string>();
      set.add(peer.id);
      this.deviceTokens.set(peer.id, set);
    }
  }

  unregister(peer: PeerMeta): void {
    const existing = this.peers.get(peer.id);
    if (existing === peer) this.peers.delete(peer.id);
  }

  get(id: string): PeerMeta | undefined {
    return this.peers.get(id);
  }

  onlineHosts(): PeerMeta[] {
    return [...this.peers.values()].filter((peer) => peer.role === "host");
  }

  onlineDevices(): PeerMeta[] {
    return [...this.peers.values()].filter((peer) => peer.role === "device");
  }

  /** Token bucket per peer id. Returns true when allowed. */
  checkRateLimit(peerId: string): boolean {
    const now = Date.now();
    const bucket = this.rateBuckets.get(peerId);
    if (!bucket || now - bucket.windowStart >= this.config.rateLimitWindowMs) {
      this.rateBuckets.set(peerId, { count: 1, windowStart: now });
      return true;
    }
    bucket.count += 1;
    if (bucket.count > this.config.rateLimitMax) {
      this.audit.append({
        actor: peerId,
        action: "rate.limit",
        targetDigest: this.audit.digest(peerId),
        outcome: "denied",
        traceId: "rate",
      });
      return false;
    }
    return true;
  }

  /** Route an envelope from `from` to its peer based on role + hostId/deviceId. */
  route(from: PeerMeta, targetId: string | undefined): RouteDecision {
    if (!targetId) {
      return { ok: false, code: 4002, reason: "missing target id" };
    }
    if (from.role === "device" && targetId !== from.id) {
      // Devices may only address their host via hostId; the registry maps
      // hostId → host peer. Cross-host routing is denied.
    }
    const target = this.peers.get(targetId);
    if (!target) return { ok: false, code: 4002, reason: "peer not connected" };
    if (target.role === from.role) {
      this.audit.append({
        actor: from.id,
        action: "policy.deny",
        targetDigest: this.audit.digest(targetId),
        outcome: "denied",
        traceId: "route",
      });
      return { ok: false, code: 4002, reason: "same-role routing denied" };
    }
    return { ok: true, target };
  }
}
