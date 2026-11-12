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
import { RelayDiagLog } from "./diag-log.ts";
import { loadConfig, type RelayConfig } from "./config.ts";

interface EnvelopeLike {
  v?: unknown;
  traceId?: unknown;
  ts?: unknown;
  nonce?: unknown;
  role?: unknown;
  deviceId?: unknown;
  hostId?: unknown;
  e2eePub?: unknown;
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
  /** Host's base64url X25519 public key for E2EE key agreement. */
  e2eePub?: string;
}

/** Canonical base64url encoding of exactly 32 bytes (a raw X25519 public key). */
function isValidE2eePub(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return Buffer.from(value, "base64url").toString("base64url") === value;
  } catch {
    return false;
  }
}

export class RelayHub {
  readonly wss: WebSocketServer;
  readonly registry: ConnectionRegistry;
  readonly pairing: PairingService;
  readonly audit: AuditLog;
  /** Opt-in forensic log (RELAY_DEBUG_LOG). Disabled unless a path is configured. */
  readonly diag: RelayDiagLog;
  private readonly config: RelayConfig;
  /** Known hosts for the multi-PC device selector: label + last disconnect. */
  private readonly hostDirectory = new Map<string, { label?: string; lastSeenAt: number; e2eePub?: string }>();

  constructor(config: RelayConfig = loadConfig()) {
    this.config = config;
    this.audit = new AuditLog();
    this.pairing = new PairingService(config, this.audit);
    this.registry = new ConnectionRegistry(config, this.audit);
    this.wss = new WebSocketServer({ noServer: true });
    this.diag = new RelayDiagLog(config.debugLogPath);
    this.diag.record("relay.start", {
      port: config.port,
      cipherRequired: config.cipherRequired,
      pairingRequired: config.pairingRequired,
      statePath: config.statePath ?? null,
      pairingTtlMs: config.pairingTtlMs,
      bindingsLoaded: this.pairing.bindingCount,
    });
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
    let hostE2eePub: string | undefined;
    let helloDone = false;

    ws.on("message", (raw: Buffer) => {
      if (!helloDone) {
        const decision = this.handleHello(ws, role, raw);
        if (decision) {
          peer = decision.peer;
          hostE2eePub = decision.e2eePub;
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
        if (peer.role === "host") this.recordHostOffline(peer.id, peer.label, hostE2eePub);
        this.registry.unregister(peer);
      }
    });
    ws.on("error", () => {
      if (peer) {
        if (peer.role === "host") this.recordHostOffline(peer.id, peer.label, hostE2eePub);
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
    this.diag.record("hello.reject", { actor, code, reason, action });
    ws.close(code, reason);
  }

  private handleHello(
    ws: WebSocket,
    role: "host" | "device",
    raw: Buffer,
  ): { peer: PeerMeta; e2eePub?: string } | undefined {
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
          e2eePub?: unknown;
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
    // E2EE: hosts announce their static X25519 public key in hello; devices
    // announce an ephemeral one. The relay only relays it (hello_ack hosts
    // directory) — it never holds private keys or session keys.
    const e2eePub = isValidE2eePub(payload.e2eePub) ? payload.e2eePub : undefined;

    // Pairing gate (device role): a paired device presents the credential for
    // the host it is addressing; a first-time device presents the one-time
    // token from that PC's QR code. Bindings are per (device, host).
    let issuedDeviceSecret: string | undefined;
    /** Device peers: the host this connection addresses (drives online flags). */
    let deviceTargetHostId = "";
    if (role === "device") {
      const auth = payload.auth as { pairingToken?: unknown; deviceSecret?: unknown } | undefined;
      const deviceSecret = typeof auth?.deviceSecret === "string" ? auth.deviceSecret : "";
      const pairingToken = typeof auth?.pairingToken === "string" ? auth.pairingToken : "";
      const declaredHostId = typeof envelope.hostId === "string" ? envelope.hostId : "";
      // A hello may omit hostId; relay then routes to the first online host
      // (see ackHostId), so validate the credential against that same host.
      const targetHostId = declaredHostId || this.registry.onlineHosts()[0]?.id || "";
      deviceTargetHostId = targetHostId;
      let paired = false;
      /** Diagnostic verdicts: why the token / credential did or did not bind. */
      let tokenVerdict: string | undefined;
      let credentialVerdict: string | undefined;
      // A fresh scan token wins over a stale credential. Re-pairing only
      // replaces the binding for the scanned host, other PCs stay paired.
      if (pairingToken) {
        const submitted = this.pairing.submit(pairingToken, declaredHostId, id, e2eePub ?? "");
        tokenVerdict = submitted.ok ? "accepted" : submitted.reason;
        if (submitted.ok) {
          this.pairing.approve(pairingToken);
          this.pairing.consume(pairingToken);
          issuedDeviceSecret = this.pairing.pairDevice(declaredHostId, id, label, e2eePub).secret;
          tokenVerdict = "paired";
          paired = true;
        }
      }
      if (!paired && deviceSecret) {
        credentialVerdict = this.pairing.verifyReason(id, deviceSecret, targetHostId);
        paired = credentialVerdict === "ok";
      }
      // Forensics: the single most useful record in this file — what the phone
      // presented, what the relay holds, and how each check was decided.
      this.diag.record("device.hello", {
        deviceId: id,
        label: label ?? null,
        declaredHostId: declaredHostId || null,
        targetHostId: targetHostId || null,
        onlineHostIds: this.registry.onlineHosts().map((peer) => peer.id),
        knownHostIds: [...this.hostDirectory.keys()],
        pairingRequired: this.config.pairingRequired,
        hasPairingToken: Boolean(pairingToken),
        pairingTokenDigest: RelayDiagLog.digest(pairingToken),
        tokenVerdict: tokenVerdict ?? null,
        hasDeviceSecret: Boolean(deviceSecret),
        deviceSecretDigest: RelayDiagLog.digest(deviceSecret),
        credentialVerdict: credentialVerdict ?? null,
        // Hosts this deviceId is bound to — an empty array with a secret
        // present means the relay lost/moved its state file or the phone kept
        // a credential from another relay instance.
        bindingHostIds: this.pairing.bindingHostIds(id),
        bindingCount: this.pairing.bindingCount,
        paired,
      });
      if (!paired && pairingToken) {
        // The token was present but did not produce a binding: reject with the
        // submit reason instead of the generic "pairing required", so the
        // phone can surface it ("unknown pairing token" vs "pairing consumed").
        this.fail(ws, 4003, `pairing token rejected: ${tokenVerdict ?? "unknown"}`, id, "pair.reject", "pair");
        return undefined;
      }
      if (this.config.pairingRequired && !paired) {
        this.fail(ws, 4003, "pairing required", id, "pair.reject", "pair");
        return undefined;
      }
    }
    const peer: PeerMeta = {
      id,
      role,
      label,
      appVersion: typeof payload.appVersion === "string" ? payload.appVersion : undefined,
      protocolVersion: 1,
      connectedAt: Date.now(),
      ...(role === "device" && deviceTargetHostId ? { addressedHostId: deviceTargetHostId } : {}),
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
    };
    if (role === "host") {
      const previous = this.hostDirectory.get(id);
      this.hostDirectory.set(id, {
        label,
        lastSeenAt: previous?.lastSeenAt ?? Date.now(),
        e2eePub: e2eePub ?? previous?.e2eePub,
      });
      // A device rejection is usually "the PC I want is not here" or "the QR
      // advertised another hostId": record which id the PC actually took.
      this.diag.record("host.hello", {
        hostId: id,
        label: label ?? null,
        declaredHostId: declaredHostId || null,
        hasE2eePub: Boolean(e2eePub),
        appVersion: typeof payload.appVersion === "string" ? payload.appVersion : null,
      });
    } else {
      this.diag.record("device.accept", {
        deviceId: id,
        addressedHostId: deviceTargetHostId || null,
        issuedSecret: Boolean(issuedDeviceSecret),
      });
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
          ...(issuedDeviceSecret ? { deviceSecret: issuedDeviceSecret } : {}),
          cipherRequired: this.config.cipherRequired,
        },
      }),
    );
    return { peer, e2eePub };
  }

  /** Online hosts first, then known offline hosts with their last disconnect. */
  private hostDirectorySnapshot(): HostDirectoryEntry[] {
    const out: HostDirectoryEntry[] = [];
    const seen = new Set<string>();
    for (const host of this.registry.onlineHosts()) {
      seen.add(host.id);
      out.push({ id: host.id, label: host.label, online: true, e2eePub: this.hostDirectory.get(host.id)?.e2eePub });
    }
    for (const [id, info] of this.hostDirectory) {
      if (seen.has(id)) continue;
      out.push({ id, label: info.label, online: false, lastSeenAt: info.lastSeenAt, e2eePub: info.e2eePub });
    }
    return out;
  }

  private recordHostOffline(hostId: string, label?: string, e2eePub?: string): void {
    this.hostDirectory.set(hostId, { label, lastSeenAt: Date.now(), e2eePub });
    this.diag.record("host.offline", { hostId, label: label ?? null });
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
    // Header-level replay window: the relay cannot verify crypto, but a stale
    // or future timestamp is never legitimate — drop it without tearing down
    // the link (a skewed clock would otherwise break reconnect loops).
    const ts = typeof envelope.ts === "number" ? envelope.ts : NaN;
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > this.config.replayWindowMs) {
      this.audit.append({
        actor: from.id,
        action: "replay.drop",
        targetDigest: this.audit.digest(from.id),
        outcome: "denied",
        traceId: typeof envelope.traceId === "string" ? envelope.traceId : "route",
      });
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
    // Pairing control frames (host → relay): issue/revoke device credentials.
    // Header-only, handled before the cipher gate, payloads are metadata.
    if (envelope.control === "pair.create") {
      if (from.role !== "host") {
        from.close(4002, "only hosts may create pairing tokens");
        return;
      }
      const created = this.pairing.create(from.id);
      this.diag.record("pair.create", {
        hostId: from.id,
        tokenDigest: RelayDiagLog.digest(created.token),
        expiresAt: new Date(created.expiresAt).toISOString(),
      });
      from.send(
        JSON.stringify({
          v: 1,
          traceId: typeof envelope.traceId === "string" ? envelope.traceId : "pair.create",
          ts: Date.now(),
          nonce: randomUUID(),
          role: "relay",
          payload: { kind: "pair.create.result", token: created.token, expiresAt: created.expiresAt },
        }),
      );
      return;
    }
    if (envelope.control === "pair.revoke") {
      if (from.role !== "host") {
        from.close(4002, "only hosts may revoke devices");
        return;
      }
      const deviceId = typeof envelope.deviceId === "string" ? envelope.deviceId : "";
      const revoked = this.pairing.revokeDevice(from.id, deviceId);
      this.diag.record("pair.revoke", { hostId: from.id, deviceId, revoked });
      // Revocation is immediate: drop the live device connection if online.
      if (revoked) this.registry.get(deviceId)?.close(4003, "device revoked");
      from.send(
        JSON.stringify({
          v: 1,
          traceId: typeof envelope.traceId === "string" ? envelope.traceId : "pair.revoke",
          ts: Date.now(),
          nonce: randomUUID(),
          role: "relay",
          payload: { kind: "pair.revoke.result", deviceId, revoked },
        }),
      );
      return;
    }
    // Device-initiated unbind: a phone may drop only its own binding for the
    // host named in the control frame (never another device's binding).
    if (envelope.control === "pair.unbind") {
      if (from.role !== "device") {
        from.close(4002, "only devices may unbind themselves");
        return;
      }
      const controlPayload = envelope.payload as { hostId?: unknown } | undefined;
      const hostId =
        typeof controlPayload?.hostId === "string"
          ? controlPayload.hostId
          : typeof envelope.hostId === "string"
            ? envelope.hostId
            : "";
      const removed = hostId ? this.pairing.unbindDevice(from.id, hostId) : false;
      this.diag.record("pair.unbind", { deviceId: from.id, hostId: hostId || null, removed });
      from.send(
        JSON.stringify({
          v: 1,
          traceId: typeof envelope.traceId === "string" ? envelope.traceId : "pair.unbind",
          ts: Date.now(),
          nonce: randomUUID(),
          role: "relay",
          payload: { kind: "pair.unbind.result", hostId, removed },
        }),
      );
      // No forced close here: the phone decides whether to disconnect (when
      // it was addressing this host) or keep its link to another paired PC.
      return;
    }
    if (envelope.control === "pair.devices") {
      if (from.role !== "host") {
        from.close(4002, "only hosts may list paired devices");
        return;
      }
      // Per-device online flag: the device must have a live connection AND be
      // addressing this host (multi-PC — a phone talking to another PC shows
      // offline here).
      const devices = this.pairing.listDevices(from.id).map((binding) => {
        const peer = this.registry.get(binding.deviceId);
        const online = peer?.role === "device" && peer.addressedHostId === from.id;
        return { ...binding, online };
      });
      from.send(
        JSON.stringify({
          v: 1,
          traceId: typeof envelope.traceId === "string" ? envelope.traceId : "pair.devices",
          ts: Date.now(),
          nonce: randomUUID(),
          role: "relay",
          payload: { kind: "pair.devices.result", devices },
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
    // Keep the device's addressed host fresh so pair.devices reports accurate
    // online flags (a device re-handshakes to switch hosts; this is a safety net).
    if (from.role === "device" && typeof targetId === "string" && targetId !== from.addressedHostId) {
      from.addressedHostId = targetId;
    }
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
