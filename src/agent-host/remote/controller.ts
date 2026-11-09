/**
 * RemoteControlController — owns the in-app RemoteGateway lifecycle for the
 * desktop agent-host process. Config arrives from main via parentPort
 * ("remote:init"/"remote:changed", mirroring the herdr snapshot pattern);
 * status flows back as "remote-status" messages.
 *
 * The gateway never listens: it dials the user-configured relay outbound.
 * Reconnects loop every 3s while enabled (relay restarts, network blips).
 */
import type { RpcServer } from "../../contract/rpc.ts";
import { RemoteGateway, type GatewayState } from "./gateway.ts";
import type { RemoteControlConfig, RemoteControlStatus } from "../../contract/desktop.ts";
import { createRequire } from "node:module";

const RECONNECT_INTERVAL_MS = 3_000;
const STATUS_POLL_MS = 2_000;

export interface RemoteControlControllerOptions {
  server: Pick<RpcServer, "attachPort" | "detachPort">;
  /** Report a status snapshot upward (parentPort.postMessage in the app). */
  postStatus: (status: RemoteControlStatus) => void;
  /** Diagnostics channel (host forwards to main log). */
  log?: (message: string) => void;
  /** Test hook: inject a WebSocket constructor (defaults to the "ws" module). */
  connectWebSocket?: (url: string) => Promise<import("./gateway.ts").GatewaySocket>;
}

type Timer = ReturnType<typeof setInterval>;

export class RemoteControlController {
  private config: RemoteControlConfig | null = null;
  private gateway: RemoteGateway | null = null;
  private lastStatus: RemoteControlStatus | null = null;
  private reconnectTimer: Timer | null = null;
  private statusTimer: Timer | null = null;
  private disposed = false;
  private readonly require: NodeRequire;
  private readonly reconnectMs: number;
  private readonly statusPollMs: number;

  constructor(
    private readonly options: RemoteControlControllerOptions,
    deps: { require?: NodeRequire; reconnectMs?: number; statusPollMs?: number } = {},
  ) {
    // Resolve relative to this module so the bundled file finds the app's
    // node_modules (standard upward resolution); a bare require would break
    // inside the CJS bundle.
    this.require = deps.require ?? createRequire(import.meta.url);
    this.reconnectMs = deps.reconnectMs ?? RECONNECT_INTERVAL_MS;
    this.statusPollMs = deps.statusPollMs ?? STATUS_POLL_MS;
  }

  /** Apply the latest config from main; starts/stops/recreates as needed. */
  applyConfig(config: RemoteControlConfig): void {
    if (this.disposed) return;
    const relayUrlChanged = this.config?.relayUrl !== config.relayUrl;
    const identityChanged =
      this.config?.hostId !== config.hostId ||
      this.config?.name !== config.name ||
      this.config?.e2eePublicKey !== config.e2eePublicKey;
    const wasEnabled = this.config?.enabled ?? false;
    this.config = {
      enabled: config.enabled,
      relayUrl: config.relayUrl,
      hostId: config.hostId,
      name: config.name,
      mode: config.mode ?? "lan",
      lanPort: config.lanPort,
      e2eePublicKey: config.e2eePublicKey,
      e2eePrivateKey: config.e2eePrivateKey,
    };
    if (!config.enabled) {
      this.stopReconnect();
      this.gateway?.dispose();
      this.gateway = null;
      this.emitStatus("disabled");
      return;
    }
    if (!this.gateway || relayUrlChanged || identityChanged) {
      this.gateway?.dispose();
      this.gateway = this.createGateway(config.relayUrl);
      if (!wasEnabled || relayUrlChanged || identityChanged) this.emitStatus("connecting");
      void this.startGateway();
    } else if (this.gateway.getState() === "stopped") {
      this.emitStatus("connecting");
      void this.startGateway();
    }
    this.ensureStatusPolling();
  }

  /** Manual reconnect (settings card): discard the current gateway and dial fresh now. */
  reconnectNow(): void {
    if (this.disposed || !this.config?.enabled) return;
    this.gateway?.dispose();
    this.gateway = this.createGateway(this.config.relayUrl);
    this.emitStatus("connecting");
    void this.startGateway();
    this.ensureStatusPolling();
  }

  /** Issue a one-time pairing token (desktop QR) via the relay. */
  async createPairingToken(): Promise<{ token: string; expiresAt: number }> {
    const gateway = this.gateway;
    if (!gateway) throw new Error("remote control is disabled");
    const result = await gateway.sendControl("pair.create");
    const token = typeof result.token === "string" ? result.token : "";
    const expiresAt = typeof result.expiresAt === "number" ? result.expiresAt : 0;
    if (!token) throw new Error("relay did not return a pairing token");
    return { token, expiresAt };
  }

  /** Revoke a paired device (immediate: the relay drops its live connection). */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const gateway = this.gateway;
    if (!gateway) throw new Error("remote control is disabled");
    const result = await gateway.sendControl("pair.revoke", { deviceId });
    return result.revoked === true;
  }

  /** Paired devices bound to this host (secrets excluded). */
  async listDevices(): Promise<Array<{ deviceId: string; label?: string; pairedAt: number }>> {
    const gateway = this.gateway;
    if (!gateway) throw new Error("remote control is disabled");
    const result = await gateway.sendControl("pair.devices");
    return Array.isArray(result.devices)
      ? (result.devices as Array<{ deviceId: string; label?: string; pairedAt: number }>)
      : [];
  }

  dispose(): void {
    this.disposed = true;
    this.stopReconnect();
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.gateway?.dispose();
    this.gateway = null;
  }

  /** Force the host role on the configured endpoint (users paste a bare URL). */
  private hostRelayUrl(relayUrl: string): string {
    try {
      const url = new URL(relayUrl);
      url.searchParams.set("role", "host");
      return url.toString();
    } catch {
      return relayUrl;
    }
  }

  private createGateway(relayUrl: string): RemoteGateway {
    const WebSocket = this.require("ws") as new (url: string) => import("./gateway.ts").GatewaySocket;
    const e2ee =
      this.config?.e2eePublicKey && this.config?.e2eePrivateKey
        ? { publicKey: this.config.e2eePublicKey, privateKey: this.config.e2eePrivateKey }
        : undefined;
    this.options.log?.(
      `creating gateway hostId=${this.config?.hostId ?? "(none)"} label=${this.config?.name ?? "(none)"} e2ee=${e2ee ? "on" : "off"}`,
    );
    return new RemoteGateway(this.options.server, {
      relayUrl: this.hostRelayUrl(relayUrl),
      hostId: this.config?.hostId,
      hostLabel: this.config?.name,
      ...(e2ee ? { e2ee } : {}),
      connectWebSocket: (url) => Promise.resolve(new WebSocket(url)),
    });
  }

  private async startGateway(): Promise<void> {
    const gateway = this.gateway;
    if (!gateway || this.disposed) return;
    try {
      await gateway.start();
    } catch (err) {
      this.emitStatus("stopped", err instanceof Error ? err.message : String(err));
    }
  }

  private ensureStatusPolling(): void {
    if (this.statusTimer || this.disposed) return;
    this.statusTimer = setInterval(() => {
      if (this.disposed) return;
      const gateway = this.gateway;
      const state: GatewayState | "disabled" = this.config?.enabled ? (gateway?.getState() ?? "stopped") : "disabled";
      if (this.config?.enabled && gateway && state === "stopped") {
        this.scheduleReconnect();
      }
      this.emitStatus(state === "disabled" ? "disabled" : state);
    }, this.statusPollMs);
    if (typeof this.statusTimer.unref === "function") this.statusTimer.unref();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed || !this.config?.enabled) return;
    this.reconnectTimer = setInterval(() => {
      if (this.disposed || !this.config?.enabled) {
        this.stopReconnect();
        return;
      }
      const state = this.gateway?.getState() ?? "stopped";
      if (state === "stopped") void this.startGateway();
    }, this.reconnectMs);
    if (typeof this.reconnectTimer.unref === "function") this.reconnectTimer.unref();
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private emitStatus(state: RemoteControlStatus["state"], lastError?: string): void {
    const status: RemoteControlStatus = {
      state,
      relayUrl: this.config?.relayUrl ?? "",
      deviceCount: this.gateway?.getDeviceCount() ?? 0,
      ...(lastError ? { lastError } : {}),
    };
    // Only push on change to keep the parentPort quiet.
    const prev = this.lastStatus;
    if (
      prev &&
      prev.state === status.state &&
      prev.relayUrl === status.relayUrl &&
      prev.deviceCount === status.deviceCount &&
      prev.lastError === status.lastError
    ) {
      return;
    }
    this.lastStatus = status;
    try {
      this.options.postStatus(status);
    } catch {
      /* parentPort delivery is best-effort */
    }
  }
}
