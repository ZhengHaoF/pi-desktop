/**
 * Remote Gateway — the PC-side endpoint of the remote control plane.
 *
 * Contract access: an in-process worker_threads MessageChannel whose port1 is
 * attached to the Agent Host RpcServer (same pattern as handlers.test.mjs);
 * the Gateway speaks the standard WireMessage protocol over port2. Zero
 * changes to contract files, handlers or the main process.
 *
 * Transport: an outbound WebSocket to the user-configured Relay. The PC never
 * listens on any port. Spec: docs/remote-control-plan.md §3.1a, §7.2.
 */
import { MessageChannel } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import type { AnyMessagePort, RpcServer, WireMessage } from "../../contract/rpc.ts";
import { isAgentCommandPayloadAllowed, isMethodAllowed, isSubscriptionAllowed } from "./policy.ts";
import { ApprovalBridge, type ApprovalDecision } from "./approval-bridge.ts";
import {
  openContext,
  restoreKeyPair,
  sealContext,
  type CipherBlock,
  type OpenedContext,
  type SealedContext,
} from "./cipher.ts";

/** Topics the Gateway may mirror to the relay after a validated subscribe. */
const ALLOWED_EVENT_TOPICS: readonly string[] = [
  "agent.events",
  "agent.running",
  "sessions.changed",
  "files.changed",
  "remote.approval",
];

/** Topics mirrored regardless of per-session subscription (global state). */
const GLOBAL_MIRROR_TOPICS: readonly string[] = ["agent.running", "sessions.changed"];

export interface GatewayOptions {
  /** Outbound relay endpoint, e.g. wss://relay.example.com/ws?role=host */
  relayUrl: string;
  /** Stable host identity for the multi-PC device selector. */
  hostId?: string;
  /** Display name shown on device selectors. */
  hostLabel?: string;
  /**
   * Host's static X25519 key pair (E2EE). Announced in hello and used to
   * derive per-device session keys; required on relays with cipherRequired.
   */
  e2ee?: { publicKey: string; privateKey: string };
  /** Injected for tests; defaults to a lazy dynamic import of "ws". */
  connectWebSocket?: (url: string) => Promise<GatewaySocket>;
}

/** Minimal socket surface the Gateway needs (structurally compatible with ws). */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "pong", listener: () => void): void;
  /** WS-level heartbeat ping (ws provides it; minimal test fakes may omit). */
  ping?(data?: Buffer): void;
  /** Immediate teardown without a close frame (dead-link fast path). */
  terminate?(): void;
}

export type GatewayState = "stopped" | "connecting" | "ready";

interface PendingRequest {
  resolve: (response: WireMessage & { kind: "response" }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** In-flight pair.* control request awaiting the relay's *.result frame. */
interface PendingControl {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 5_000;
/** Liveness probe cadence; a missed pong kills the link on the next tick. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Per-device E2EE contexts; re-derived when the device rotates its key. */
interface DeviceCipher {
  pub: string;
  seal: SealedContext;
  open: OpenedContext;
}

export class RemoteGateway {
  private readonly channel = new MessageChannel();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingControls = new Map<string, PendingControl>();
  /** Remote-plane subscriptions: topic → Set<key> (keys are sessionIds). */
  private readonly remoteSubscriptions = new Map<string, Set<string>>();
  /** Devices seen on this relay session (envelope header), used for frame routing. */
  private readonly knownDevices = new Set<string>();
  private internalSubscriptionsReady: Promise<unknown> = Promise.resolve();
  private readonly approvalBridge: ApprovalBridge;
  private socket: GatewaySocket | undefined;
  private state: GatewayState = "stopped";
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly options: GatewayOptions;
  /** Restored key objects (null until start with an E2EE key pair). */
  private hostKeys:
    { publicKey: import("node:crypto").KeyObject; privateKey: import("node:crypto").KeyObject } | undefined;
  /** True once hello_ack reports cipherRequired and a key pair is configured. */
  private cipherMode = false;
  private readonly deviceCiphers = new Map<string, DeviceCipher>();

  constructor(
    private readonly server: Pick<RpcServer, "attachPort" | "detachPort">,
    options: GatewayOptions,
  ) {
    this.options = options;
    this.approvalBridge = new ApprovalBridge((envelope) => this.sendToRelay(envelope));
    // port1 joins the existing RpcServer as one more subscriber; the Gateway
    // itself speaks the regular wire protocol over port2.
    this.server.attachPort(this.channel.port1 as unknown as AnyMessagePort);
    this.channel.port2.on("message", (raw: unknown) => this.onPortMessage(raw));
    this.channel.port1.start?.();
    this.channel.port2.start();
    // Subscribe the gateway port to every allowlisted topic with a wildcard
    // key. This is a trusted in-process subscription (the remote-plane
    // wildcard ban in policy.ts applies to device subscriptions only); it is
    // what makes approval mirroring and subscription filtering possible.
    for (const topic of ALLOWED_EVENT_TOPICS) {
      this.channel.port2.postMessage({ kind: "subscribe", id: `gw:${topic}`, topic, key: "*" });
    }
    // MessagePort frames are delivered in order, so when the probe response
    // arrives every subscribe frame above has already been processed by the
    // RpcServer. The server does not ack subscriptions, hence the probe.
    this.internalSubscriptionsReady = this.callRpc("system.runningCount", null).then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Resolves once the in-process wildcard subscriptions are registered on
   * the RpcServer. Events emitted before this point cannot reach the gateway
   * (MessagePort delivery is asynchronous); callers that emit immediately
   * after construction should await this first.
   */
  whenReady(): Promise<void> {
    return this.internalSubscriptionsReady.then(() => undefined);
  }

  getState(): GatewayState {
    return this.state;
  }

  /** Outbound-only connection. Never binds a port. */
  async start(): Promise<void> {
    if (this.state !== "stopped") return;
    this.state = "connecting";
    this.cipherMode = false;
    this.deviceCiphers.clear();
    if (this.options.e2ee) {
      this.hostKeys = restoreKeyPair(this.options.e2ee.publicKey, this.options.e2ee.privateKey);
    }
    try {
      const connect = this.options.connectWebSocket ?? defaultConnect;
      const socket = await connect(this.options.relayUrl);
      this.socket = socket;
      socket.on("message", (data: unknown) => this.onRelayMessage(data));
      socket.on("close", () => {
        this.stopHeartbeat();
        this.socket = undefined;
        this.state = "stopped";
      });
      socket.on("error", () => {
        this.stopHeartbeat();
        this.socket = undefined;
        this.state = "stopped";
      });
      this.startHeartbeat(socket);
      socket.on("open", () => {
        this.state = "ready";
        // hello is consumed by the relay itself (no routing), so it is sent
        // raw — before any device is known on this session.
        this.sendRaw({
          v: 1,
          traceId: randomUUID(),
          ts: Date.now(),
          nonce: randomUUID(),
          role: "host",
          payload: {
            kind: "hello",
            protocolVersion: 1,
            appVersion: "gateway",
            ...(this.options.hostId ? { hostId: this.options.hostId } : {}),
            ...(this.options.hostLabel ? { label: this.options.hostLabel } : {}),
            ...(this.options.e2ee ? { e2eePub: this.options.e2ee.publicKey } : {}),
            auth: {},
          },
        });
      });
    } catch (err) {
      this.state = "stopped";
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  stop(): void {
    this.stopHeartbeat();
    this.approvalBridge.abortAll("gateway stopped");
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("gateway stopped"));
      this.pending.delete(id);
    }
    for (const [traceId, pending] of this.pendingControls) {
      clearTimeout(pending.timer);
      pending.reject(new Error("gateway stopped"));
      this.pendingControls.delete(traceId);
    }
    this.socket?.close(1000, "gateway stopped");
    this.socket = undefined;
    this.state = "stopped";
  }

  /** Graceful shutdown: detach the channel port before host teardown. */
  dispose(): void {
    this.stop();
    this.server.detachPort(this.channel.port1 as unknown as AnyMessagePort);
    this.channel.port1.close();
    this.channel.port2.close();
  }

  /**
   * Liveness heartbeat. On a silently dead link (NAT timeout, relay restart
   * whose FIN never arrives) the socket stays "open" forever and the gateway
   * sits "ready" on a zombie — no close event, no reconnect. Ping every
   * interval; a ping left unanswered by the next tick means the link is dead:
   * tear it down so the controller's reconnect loop takes over.
   */
  private startHeartbeat(socket: GatewaySocket): void {
    const ping = socket.ping?.bind(socket);
    if (!ping) return; // minimal test fakes
    let awaitingPong = false;
    socket.on("pong", () => {
      awaitingPong = false;
    });
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || this.state !== "ready") return;
      if (awaitingPong) {
        if (typeof socket.terminate === "function") socket.terminate();
        else socket.close(4000, "heartbeat timeout");
        return;
      }
      awaitingPong = true;
      ping();
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /** Test/diagnostic hook: subscribe to the approval mirror topic. */
  onApproval(listener: (decision: ApprovalDecision) => void): () => void {
    return this.approvalBridge.onDecision(listener);
  }

  /**
   * Host-side control frame with request/response correlation (pair.create,
   * pair.revoke, pair.devices). The relay answers with a payload whose kind is
   * `<control>.result` and whose traceId echoes the request.
   */
  sendControl(
    control: string,
    header: Record<string, unknown> = {},
    payload: object = { kind: control },
  ): Promise<Record<string, unknown>> {
    if (!this.socket || this.state !== "ready") {
      return Promise.reject(new Error("remote control relay is not connected"));
    }
    const traceId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(traceId);
        reject(new Error(`relay control timeout: ${control}`));
      }, CONTROL_TIMEOUT_MS);
      this.pendingControls.set(traceId, { resolve, reject, timer });
      this.sendRaw({
        v: 1,
        traceId,
        ts: Date.now(),
        nonce: randomUUID(),
        role: "host",
        control,
        ...header,
        payload,
      });
    });
  }

  private onPortMessage(raw: unknown): void {
    const message = raw as WireMessage;
    if (!message || typeof message !== "object") return;
    if (message.kind === "event") {
      this.approvalBridge.observeEvent(message);
      // Mirror to the relay only when a remote device subscribed this topic
      // (exact key or the global topics). Wildcard remote subscriptions are
      // forbidden; filtering happens here so devices receive only what they
      // explicitly subscribed to.
      if (!this.shouldMirror(message.topic, message.key)) return;
      this.sendToRelay({
        v: 1,
        traceId: randomUUID(),
        ts: Date.now(),
        nonce: randomUUID(),
        role: "host",
        payload: message,
      });
      return;
    }
    if (message.kind === "response") {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.resolve(message);
      }
    }
  }

  private shouldMirror(topic: string, key: string): boolean {
    const keys = this.remoteSubscriptions.get(topic);
    if (!keys) return false;
    if (GLOBAL_MIRROR_TOPICS.includes(topic)) return true;
    return keys.has(key);
  }

  private onRelayMessage(data: unknown): void {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
    let envelope: { deviceId?: unknown; traceId?: unknown; payload?: unknown; cipher?: unknown; e2eePub?: unknown };
    try {
      envelope = JSON.parse(text) as {
        deviceId?: unknown;
        traceId?: unknown;
        payload?: unknown;
        cipher?: unknown;
        e2eePub?: unknown;
      };
    } catch {
      return;
    }
    // Relay replies to host control frames (pair.*.result) carry a traceId and
    // no routed payload semantics — resolve the pending control request.
    const controlPayload = envelope.payload as { kind?: unknown } | undefined;
    if (
      typeof controlPayload?.kind === "string" &&
      controlPayload.kind.startsWith("pair.") &&
      controlPayload.kind.endsWith(".result")
    ) {
      const traceId = typeof envelope.traceId === "string" ? envelope.traceId : "";
      const pending = this.pendingControls.get(traceId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingControls.delete(traceId);
        pending.resolve(controlPayload as Record<string, unknown>);
      }
      return;
    }
    // hello_ack: relay-side cipher policy for this session (Step 2 E2EE).
    if (typeof controlPayload?.kind === "string" && controlPayload.kind === "hello_ack") {
      const ack = controlPayload as { kind: string; cipherRequired?: unknown };
      this.cipherMode = ack.cipherRequired === true && this.hostKeys !== undefined;
      return;
    }
    // The relay routes host→device frames by the envelope's deviceId; remember
    // which device(s) this session serves so responses and mirrored events can
    // be addressed back. Frames without a target are closed by the relay.
    const fromDevice =
      typeof envelope.deviceId === "string" && envelope.deviceId.length > 0 ? envelope.deviceId : undefined;
    if (fromDevice) this.knownDevices.add(fromDevice);
    let payload = envelope.payload as WireMessage | undefined;
    if (typeof envelope.payload === "string") {
      // Ciphertext routed frame: decrypt under the device's session key.
      const decrypted = fromDevice ? this.decryptRoutedFrame(envelope, fromDevice) : undefined;
      if (!decrypted) return;
      payload = decrypted;
    }
    if (!payload || typeof payload !== "object") return;

    if (payload.kind === "request") {
      void this.handleRemoteRequest(payload, fromDevice);
      return;
    }
    if (payload.kind === "subscribe") {
      if (!isSubscriptionAllowed(payload.topic, payload.key)) {
        this.sendResponse(
          payload.id,
          false,
          undefined,
          {
            code: "FORBIDDEN",
            message: "subscription denied (topic not allowlisted or wildcard key)",
          },
          fromDevice,
        );
        return;
      }
      const keys = this.remoteSubscriptions.get(payload.topic) ?? new Set<string>();
      keys.add(payload.key);
      this.remoteSubscriptions.set(payload.topic, keys);
      this.sendResponse(payload.id, true, { subscribed: true }, undefined, fromDevice);
      return;
    }
    if (payload.kind === "unsubscribe") {
      const keys = this.remoteSubscriptions.get(payload.topic);
      keys?.delete(payload.key);
      this.sendResponse(payload.id, true, { unsubscribed: true }, undefined, fromDevice);
      return;
    }
    if (payload.kind === "response") {
      this.approvalBridge.observeResponse(payload);
    }
  }

  private async handleRemoteRequest(request: WireMessage & { kind: "request" }, fromDevice?: string): Promise<void> {
    if (!isMethodAllowed(request.method)) {
      this.sendResponse(request.id, false, undefined, {
        code: "FORBIDDEN",
        message: `method not allowed on remote plane: ${request.method}`,
      });
      return;
    }
    if (request.method === "agent.command" && !isAgentCommandPayloadAllowed(request.params)) {
      this.sendResponse(request.id, false, undefined, {
        code: "FORBIDDEN",
        message: "agent.command type not allowed on remote plane",
      });
      return;
    }
    const response = await this.callRpc(request.method, request.params);
    this.sendResponse(request.id, response.ok, response.result, response.error, fromDevice);
  }

  private callRpc(
    method: string,
    params: unknown,
  ): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
    const id = randomUUID();
    const request: WireMessage & { kind: "request" } = { kind: "request", id, method, params };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { code: "GATEWAY_TIMEOUT", message: `rpc timeout: ${method}` } });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (response) =>
          resolve({
            ok: response.ok,
            ...(response.result !== undefined ? { result: response.result } : {}),
            ...(response.error ? { error: response.error } : {}),
          }),
        reject: () => resolve({ ok: false, error: { code: "GATEWAY_STOPPED", message: "gateway stopped" } }),
        timer,
      });
      this.channel.port2.postMessage(request);
    });
  }

  private sendResponse(
    id: string,
    ok: boolean,
    result: unknown,
    error?: { code: string; message: string },
    targetDeviceId?: string,
  ): void {
    this.sendToRelay(
      {
        v: 1,
        traceId: randomUUID(),
        ts: Date.now(),
        nonce: randomUUID(),
        role: "host",
        payload: { kind: "response", id, ok, ...(ok ? { result } : { error }) },
      },
      targetDeviceId,
    );
  }

  /** Unrouted frame (hello) — consumed by the relay itself, no deviceId needed. */
  private sendRaw(envelope: Record<string, unknown>): void {
    if (this.socket && this.state === "ready") {
      this.socket.send(JSON.stringify(envelope));
    }
  }

  /**
   * Routed frame. With an explicit target the envelope carries that deviceId;
   * without one (mirrored events / approval mirrors) it fans out to every
   * device seen on this relay session — the relay routes host frames by
   * deviceId and closes the connection on frames without a target.
   *
   * In cipherMode every frame is E2EE-sealed per device (each device has its
   * own session key), so the fan-out encrypts once per target.
   */
  private sendToRelay(envelope: Record<string, unknown>, targetDeviceId?: string): void {
    if (!this.socket || this.state !== "ready") return;
    if (!this.cipherMode) {
      if (targetDeviceId) {
        this.sendRaw({ ...envelope, deviceId: targetDeviceId });
        return;
      }
      for (const deviceId of this.knownDevices) {
        this.sendRaw({ ...envelope, deviceId });
      }
      return;
    }
    const targets = targetDeviceId ? [targetDeviceId] : [...this.knownDevices];
    const payload = envelope.payload;
    if (payload === undefined) return;
    for (const deviceId of targets) {
      const sealed = this.sealForDevice(deviceId, envelope);
      if (sealed) this.sendRaw(sealed);
    }
  }

  /** E2EE-seal a routed envelope for one device; null when no key is known yet. */
  private sealForDevice(deviceId: string, envelope: Record<string, unknown>): Record<string, unknown> | null {
    if (!this.hostKeys || !this.options.e2ee) return null;
    const known = this.deviceCiphers.get(deviceId);
    if (!known) return null;
    const header: Record<string, unknown> = {
      v: envelope.v,
      traceId: envelope.traceId,
      ts: envelope.ts,
      nonce: envelope.nonce,
      role: envelope.role,
      deviceId,
    };
    if (envelope.hostId !== undefined) header.hostId = envelope.hostId;
    const parts = known.seal.encrypt(JSON.stringify(envelope.payload ?? null), header);
    return { ...header, e2eePub: parts.e2eePub, cipher: parts.cipher, payload: parts.payload };
  }

  /** Decrypt + parse one ciphertext routed frame; drops silently on any failure. */
  private decryptRoutedFrame(
    envelope: {
      v?: unknown;
      traceId?: unknown;
      ts?: unknown;
      nonce?: unknown;
      role?: unknown;
      hostId?: unknown;
      e2eePub?: unknown;
      cipher?: unknown;
      payload?: unknown;
    },
    deviceId: string,
  ): WireMessage | undefined {
    if (!this.hostKeys || !this.options.e2ee) return undefined;
    const peerPub = typeof envelope.e2eePub === "string" && envelope.e2eePub.length > 0 ? envelope.e2eePub : undefined;
    const cipher = envelope.cipher as CipherBlock | undefined;
    if (!peerPub || !cipher || typeof cipher.alg !== "string" || typeof cipher.iv !== "string") return undefined;
    const device = this.ensureDeviceCipher(deviceId, peerPub);
    if (!device) return undefined;
    const header: Record<string, unknown> = {
      v: envelope.v,
      traceId: envelope.traceId,
      ts: envelope.ts,
      nonce: envelope.nonce,
      role: envelope.role,
      deviceId,
    };
    if (envelope.hostId !== undefined) header.hostId = envelope.hostId;
    const payload = typeof envelope.payload === "string" ? envelope.payload : undefined;
    if (payload === undefined) return undefined;
    try {
      return JSON.parse(device.open.decrypt(cipher, payload, header)) as WireMessage;
    } catch {
      // Tamper, replay, or a stale clock: the frame is dropped, the link stays.
      return undefined;
    }
  }

  /** Session contexts per device; rotates when a device re-presents its hello. */
  private ensureDeviceCipher(deviceId: string, peerPub: string): DeviceCipher | undefined {
    if (!this.hostKeys || !this.options.e2ee) return undefined;
    const existing = this.deviceCiphers.get(deviceId);
    if (existing && existing.pub === peerPub) return existing;
    const seal = sealContext(this.hostKeys.privateKey, this.options.e2ee.publicKey, peerPub, false);
    const open = openContext(this.hostKeys.privateKey, this.options.e2ee.publicKey, peerPub, false);
    const device: DeviceCipher = { pub: peerPub, seal, open };
    this.deviceCiphers.set(deviceId, device);
    return device;
  }
}

async function defaultConnect(url: string): Promise<GatewaySocket> {
  // The desktop package does not declare @types/ws; the dynamic import keeps
  // the dependency optional at build time (M1a local relay may also be fed a
  // custom socket via GatewayOptions.connectWebSocket).
  const wsModule = (await import("ws" as string)) as unknown as {
    default: new (url: string) => GatewaySocket;
  };
  return new wsModule.default(url);
}
