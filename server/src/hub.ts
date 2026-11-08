/**
 * Relay WS hub: accepts host/device connections, validates hello, enforces
 * cipher requirements, allowlists, rate limits and routes envelopes.
 * Zero-knowledge: payloads are never parsed beyond the envelope header.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { ConnectionRegistry, type PeerMeta } from "./registry.ts";
import { PairingService } from "./pairing.ts";
import { AuditLog } from "./audit.ts";
import { loadConfig, type RelayConfig } from "./config.ts";

interface EnvelopeLike {
  v?: unknown;
  traceId?: unknown;
  ts?: unknown;
  nonce?: unknown;
  role?: unknown;
  deviceId?: unknown;
  hostId?: unknown;
  cipher?: unknown;
  /** Envelope-level control kind (relay-local, payload stays untouched). */
  control?: unknown;
  payload?: unknown;
}

export interface HostDirectoryEntry {
  id: string;
  label?: string;
  online: boolean;
  lastSeenAt?: number;
}

export class RelayHub {
  readonly wss: WebSocketServer;
  readonly registry: ConnectionRegistry;
  readonly pairing: PairingService;
  readonly audit: AuditLog;
  private readonly config: RelayConfig;
  /** Known hosts for the multi-PC device selector: label + last disconnect time. */
  private readonly hostDirectory = new Map<string, { label?: string; lastSeenAt: number }>();

  constructor(config: RelayConfig = loadConfig()) {
    this.config = config;
    this.audit = new AuditLog();
    this.pairing = new PairingService(config, this.audit);
    this.registry = new ConnectionRegistry(config, this.audit);
    this.wss = new WebSocketServer({ noServer: true });
  }
  /** HTTP upgrade entry. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    const role = url.searchParams.get("role");
    if (role !== "host" && role !== "device") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.attach(ws, role);
    });
  }

  /** Wire a newly connected socket through hello validation. */
  attach(ws: WebSocket, role: "host" | "device"): void {
    let peer: PeerMeta | undefined;
    let helloDone = false;

    ws.on("message", (raw: Buffer) => {
      if (!helloDone) {
        const decision = this.handleHello(ws, role, raw);
        if (decision) {
          peer = decision;
          helloDone = true;
        }
        return;
      }
      if (!peer) return;
      if (!this.registry.checkRateLimit(peer.id)) {
        ws.close(1008, "rate limited");
        return;
      }
      this.routeEnvelope(peer, raw);
    });

    ws.on("close", () => {
      if (peer) {
        if (peer.role === "host") this.recordHostOffline(peer.id, peer.label);
        this.registry.unregister(peer);
      }
    });
    ws.on("error", () => {
      if (peer) {
        if (peer.role === "host") this.recordHostOffline(peer.id, peer.label);
        this.registry.unregister(peer);
      }
    });
  }

  private fail(
    ws: WebSocket,
    code: number,
    reason: string,
    actor: string,
    action: Parameters<AuditLog["append"]>[0]["action"],
    traceId: string,
  ): void {
    this.audit.append({
      actor,
      action,
      targetDigest: this.audit.digest(actor),
      outcome: "denied",
      traceId,
    });
    ws.close(code, reason);
  }

  private handleHello(ws: WebSocket, role: "host" | "device", raw: Buffer): PeerMeta | undefined {
    let envelope: EnvelopeLike;
    try {
      envelope = JSON.parse(raw.toString("utf8")) as EnvelopeLike;
    } catch {
      this.fail(ws, 4002, "malformed hello", role, "hello.reject", "hello");
      return undefined;
    }
    if (envelope.v !== 1) {
      this.fail(ws, 4000, "protocol version mismatch", role, "hello.reject", "hello");
      return undefined;
    }
    const payload = envelope.payload as
      | {
          kind?: unknown;
          protocolVersion?: unknown;
          appVersion?: unknown;
          label?: unknown;
          hostId?: unknown;
          auth?: unknown;
        }
      | undefined;
    if (!payload || payload.kind !== "hello" || payload.protocolVersion !== 1) {
      this.fail(ws, 4002, "first payload must be hello v1", role, "hello.reject", "hello");
      return undefined;
    }
    // NOTE: hello itself may be a plaintext object — it carries only auth
    // material (challenge signature), never session content. The cipher
    // requirement is enforced on every post-hello envelope (routeEnvelope).
    // Hosts may declare a stable hostId so devices can remember/switch them
    // across reconnects (multi-PC); unauthenticated reuse of another online
    // host's id is accepted in diagnostic mode and gated by pairing later.
    const declaredHostId =
      typeof payload.hostId === "string" && payload.hostId.length > 0 && payload.hostId.length <= 64
        ? payload.hostId
        : "";
    const id =
      role === "host"
        ? declaredHostId || `host-${randomUUID().slice(0, 8)}`
        : typeof envelope.deviceId === "string" && envelope.deviceId.length > 0
          ? envelope.deviceId
          : "";
    if (!id) {
      this.fail(ws, 4001, "deviceId required", role, "hello.reject", "hello");
      return undefined;
    }
    const label = typeof payload.label === "string" && payload.label.length > 0 ? payload.label : undefined;
    const peer: PeerMeta = {
      id,
      role,
      label,
      appVersion: typeof payload.appVersion === "string" ? payload.appVersion : undefined,
      protocolVersion: 1,
      connectedAt: Date.now(),
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
    };
    if (role === "host") {
      const previous = this.hostDirectory.get(id);
      this.hostDirectory.set(id, { label, lastSeenAt: previous?.lastSeenAt ?? Date.now() });
    }
    this.registry.register(peer);
    this.audit.append({
      actor: id,
      action: "hello.accept",
      targetDigest: this.audit.digest(id),
      outcome: "ok",
      traceId: typeof envelope.traceId === "string" ? envelope.traceId : "hello",
    });
    // Spec §4: hello_ack carries hostId — the host learns its assigned id and
    // a device learns which host to address. Multi-PC: devices also receive
    // the full known-host directory so they can pick/switch.
    const onlineHosts = this.registry.onlineHosts();
    const ackHostId = role === "host" ? id : onlineHosts[0]?.id;
    const hosts = role === "device" ? this.hostDirectorySnapshot() : undefined;
    peer.send(
      JSON.stringify({
        v: 1,
        traceId: typeof envelope.traceId === "string" ? envelope.traceId : "hello",
        ts: Date.now(),
        nonce: randomUUID(),
        role: "relay",
        payload: {
          kind: "hello_ack",
          protocolVersion: 1,
          ...(ackHostId ? { hostId: ackHostId } : {}),
          ...(hosts && hosts.length > 0 ? { hosts } : {}),
          cipherRequired: this.config.cipherRequired,
        },
      }),
    );
    return peer;
  }

  /** Online hosts first, then known offline hosts with their last disconnect. */
  private hostDirectorySnapshot(): HostDirectoryEntry[] {
    const out: HostDirectoryEntry[] = [];
    const seen = new Set<string>();
    for (const host of this.registry.onlineHosts()) {
      seen.add(host.id);
      out.push({ id: host.id, label: host.label, online: true });
    }
    for (const [id, info] of this.hostDirectory) {
      if (seen.has(id)) continue;
      out.push({ id, label: info.label, online: false, lastSeenAt: info.lastSeenAt });
    }
    return out;
  }

  private recordHostOffline(hostId: string, label?: string): void {
    this.hostDirectory.set(hostId, { label, lastSeenAt: Date.now() });
  }

  private routeEnvelope(from: PeerMeta, raw: Buffer): void {
    let envelope: EnvelopeLike;
    try {
      envelope = JSON.parse(raw.toString("utf8")) as EnvelopeLike;
    } catch {
      from.close(4002, "malformed envelope");
      return;
    }
    if (envelope.v !== 1) {
      from.close(4000, "protocol version mismatch");
      return;
    }
    // Envelope-level control: device asks for the host directory (multi-PC
    // selector). Handled relay-locally BEFORE the cipher gate — the kind
    // lives on the envelope header and carries no payload, so zero-knowledge
    // is preserved (formal mode: gated by pairing later).
    if (envelope.control === "hosts.list") {
      from.send(
        JSON.stringify({
          v: 1,
          traceId: typeof envelope.traceId === "string" ? envelope.traceId : "hosts.list",
          ts: Date.now(),
          nonce: randomUUID(),
          role: "relay",
          payload: { kind: "hosts.list.result", hosts: this.hostDirectorySnapshot() },
        }),
      );
      return;
    }
    if (this.config.cipherRequired && (typeof envelope.payload !== "string" || !envelope.cipher)) {
      this.audit.append({
        actor: from.id,
        action: "cipher.violation",
        targetDigest: this.audit.digest(from.id),
        outcome: "denied",
        traceId: typeof envelope.traceId === "string" ? envelope.traceId : "route",
      });
      from.close(4002, "ciphertext payload required");
      return;
    }
    const targetId =
      from.role === "device" ? (envelope.hostId as string | undefined) : (envelope.deviceId as string | undefined);
    const decision = this.registry.route(from, targetId);
    if (!decision.ok || !decision.target) {
      // A momentarily-absent peer (device reconnect window, stale deviceId)
      // must not tear down the sender's long-lived connection: drop the
      // frame and audit it. Real protocol violations still close the link.
      if (decision.reason === "peer not connected") {
        this.audit.append({
          actor: from.id,
          action: "route.drop",
          targetDigest: this.audit.digest(targetId),
          outcome: "error",
          traceId: typeof envelope.traceId === "string" ? envelope.traceId : "route",
        });
        return;
      }
      from.close((decision.code ?? 4002) as 4002, decision.reason ?? "routing denied");
      return;
    }
    this.audit.append({
      actor: from.id,
      action: "route.forward",
      targetDigest: this.audit.digest(decision.target.id),
      outcome: "ok",
      traceId: typeof envelope.traceId === "string" ? envelope.traceId : "route",
    });
    decision.target.send(raw.toString("utf8"));
  }
}
