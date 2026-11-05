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
}

export type GatewayState = "stopped" | "connecting" | "ready";

interface PendingRequest {
  resolve: (response: WireMessage & { kind: "response" }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class RemoteGateway {
  private readonly channel = new MessageChannel();
  private readonly pending = new Map<string, PendingRequest>();
  /** Remote-plane subscriptions: topic → Set<key> (keys are sessionIds). */
  private readonly remoteSubscriptions = new Map<string, Set<string>>();
  /** Devices seen on this relay session (envelope header), used for frame routing. */
  private readonly knownDevices = new Set<string>();
  private internalSubscriptionsReady: Promise<unknown> = Promise.resolve();
  private readonly approvalBridge: ApprovalBridge;
  private socket: GatewaySocket | undefined;
  private state: GatewayState = "stopped";
  private readonly options: GatewayOptions;

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
    try {
      const connect = this.options.connectWebSocket ?? defaultConnect;
      const socket = await connect(this.options.relayUrl);
      this.socket = socket;
      socket.on("message", (data: unknown) => this.onRelayMessage(data));
      socket.on("close", () => {
        this.socket = undefined;
        this.state = "stopped";
      });
      socket.on("error", () => {
        this.socket = undefined;
        this.state = "stopped";
      });
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
          payload: { kind: "hello", protocolVersion: 1, appVersion: "gateway", auth: {} },
        });
      });
    } catch (err) {
      this.state = "stopped";
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  stop(): void {
    this.approvalBridge.abortAll("gateway stopped");
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("gateway stopped"));
      this.pending.delete(id);
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

  /** Test/diagnostic hook: subscribe to the approval mirror topic. */
  onApproval(listener: (decision: ApprovalDecision) => void): () => void {
    return this.approvalBridge.onDecision(listener);
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
    let envelope: { deviceId?: unknown; payload?: unknown };
    try {
      envelope = JSON.parse(text) as { deviceId?: unknown; payload?: unknown };
    } catch {
      return;
    }
    // The relay routes host→device frames by the envelope's deviceId; remember
    // which device(s) this session serves so responses and mirrored events can
    // be addressed back. Frames without a target are closed by the relay.
    const fromDevice =
      typeof envelope.deviceId === "string" && envelope.deviceId.length > 0 ? envelope.deviceId : undefined;
    if (fromDevice) this.knownDevices.add(fromDevice);
    const payload = envelope.payload as WireMessage | undefined;
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
   */
  private sendToRelay(envelope: Record<string, unknown>, targetDeviceId?: string): void {
    if (!this.socket || this.state !== "ready") return;
    if (targetDeviceId) {
      this.sendRaw({ ...envelope, deviceId: targetDeviceId });
      return;
    }
    for (const deviceId of this.knownDevices) {
      this.sendRaw({ ...envelope, deviceId });
    }
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
