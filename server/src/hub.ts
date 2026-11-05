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
  payload?: unknown;
}

export class RelayHub {
  readonly wss: WebSocketServer;
  readonly registry: ConnectionRegistry;
  readonly pairing: PairingService;
  readonly audit: AuditLog;
  private readonly config: RelayConfig;

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
      if (peer) this.registry.unregister(peer);
    });
    ws.on("error", () => {
      if (peer) this.registry.unregister(peer);
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
      { kind?: unknown; protocolVersion?: unknown; appVersion?: unknown; label?: unknown; auth?: unknown } | undefined;
    if (!payload || payload.kind !== "hello" || payload.protocolVersion !== 1) {
      this.fail(ws, 4002, "first payload must be hello v1", role, "hello.reject", "hello");
      return undefined;
    }
    // NOTE: hello itself may be a plaintext object — it carries only auth
    // material (challenge signature), never session content. The cipher
    // requirement is enforced on every post-hello envelope (routeEnvelope).
    const id =
      role === "host"
        ? `host-${randomUUID().slice(0, 8)}`
        : typeof envelope.deviceId === "string" && envelope.deviceId.length > 0
          ? envelope.deviceId
          : "";
    if (!id) {
      this.fail(ws, 4001, "deviceId required", role, "hello.reject", "hello");
      return undefined;
    }
    const peer: PeerMeta = {
      id,
      role,
      label: typeof payload.label === "string" ? payload.label : undefined,
      appVersion: typeof payload.appVersion === "string" ? payload.appVersion : undefined,
      protocolVersion: 1,
      connectedAt: Date.now(),
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
    };
    this.registry.register(peer);
    this.audit.append({
      actor: id,
      action: "hello.accept",
      targetDigest: this.audit.digest(id),
      outcome: "ok",
      traceId: typeof envelope.traceId === "string" ? envelope.traceId : "hello",
    });
    peer.send(
      JSON.stringify({
        v: 1,
        traceId: typeof envelope.traceId === "string" ? envelope.traceId : "hello",
        ts: Date.now(),
        nonce: randomUUID(),
        role: "relay",
        payload: { kind: "hello_ack", protocolVersion: 1, cipherRequired: this.config.cipherRequired },
      }),
    );
    return peer;
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
