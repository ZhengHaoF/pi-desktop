/**
 * RelayService — hosts the bundled standalone relay (out/relay/relay.mjs) as a
 * managed child process for 局域网 mode. Lifecycle: spawn on demand, health
 * probe over HTTP /healthz, backoff restart on crash, stop on teardown.
 *
 * One relay source at a time: when the user configures a custom relay URL the
 * service is stopped; the gateway then dials that external relay instead.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { app } from "electron";

export type RelayServiceState =
  | "stopped" // not requested (mode != lan or remote disabled)
  | "starting"
  | "running"
  | "port-conflict"
  | "crashed";

export interface RelayServiceStatus {
  state: RelayServiceState;
  port: number;
  pid?: number;
  detail?: string;
}

export interface RelayServiceOptions {
  /** Resolve the bundled relay.mjs (dev: out/relay, packaged: resources/relay). */
  resolveEntry?: (mainDirectory: string) => string;
  log?: (message: string) => void;
  onStatus?: (status: RelayServiceStatus) => void;
}

const RESTART_BACKOFF_MS = [3_000, 6_000, 12_000];
const HEALTH_TIMEOUT_MS = 6_000;
const MAX_RESTARTS = 3;

export class RelayService {
  private child: ChildProcess | null = null;
  private state: RelayServiceState = "stopped";
  private port = 8787;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly log: (message: string) => void;
  private readonly onStatus: (status: RelayServiceStatus) => void;
  private readonly resolveEntry: (mainDirectory: string) => string;

  constructor(options: RelayServiceOptions = {}) {
    this.log = options.log ?? (() => {});
    this.onStatus = options.onStatus ?? (() => {});
    this.resolveEntry = options.resolveEntry ?? resolveRelayEntry;
  }

  get status(): RelayServiceStatus {
    return {
      state: this.state,
      port: this.port,
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
    };
  }

  /** Start (or restart with a new port) the hosted relay. Idempotent. */
  start(port: number): void {
    if (this.disposed) return;
    if (this.state === "running" && this.port === port && this.child) return;
    this.stopChild();
    this.port = port;
    this.restarts = 0;
    void this.probePortThenSpawn();
  }

  /**
   * Windows permits a second bind on an in-use port, so the relay would start
   * "successfully" and silently split traffic. Probe with an exclusive bind
   * first and report a clear port-conflict instead.
   */
  private async probePortThenSpawn(): Promise<void> {
    this.setState("starting");
    const free = await isPortFree(this.port);
    if (this.disposed) return;
    if (!free) {
      this.setState("port-conflict", `port ${this.port} is already in use`);
      return;
    }
    this.spawnChild();
  }

  stop(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopChild();
    this.setState("stopped");
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private setState(state: RelayServiceState, detail?: string): void {
    if (this.state === state && !detail) return;
    this.state = state;
    this.onStatus(this.status);
    if (detail) this.log(`state=${state} detail=${detail}`);
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill();
    } catch {
      /* already dead */
    }
  }

  private spawnChild(): void {
    if (this.disposed) return;
    const entry = this.resolveEntry(__dirname);
    if (!existsSync(entry)) {
      this.setState("crashed", `relay bundle missing: ${entry}`);
      return;
    }
    this.setState("starting");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // process.execPath is electron.exe inside the app: this flag makes it
      // behave as a plain Node runtime for the bundled relay script.
      ELECTRON_RUN_AS_NODE: "1",
      RELAY_PORT: String(this.port),
      // LAN mode is diagnostic plaintext until pairing + E2EE ship.
      RELAY_CIPHER_REQUIRED: "false",
      RELAY_ALLOW_PLAINTEXT_PUBLIC: "diagnostic",
    };
    const child = spawn(process.execPath, [entry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.log(String(chunk).trim()));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = String(chunk).trim();
      this.log(`stderr: ${text}`);
      if (text.includes("EADDRINUSE")) {
        // Another process owns the port (often a manually started relay).
        this.setState("port-conflict", `port ${this.port} is already in use`);
      }
    });
    child.on("exit", (code) => {
      if (this.disposed || this.child !== child) return;
      this.child = null;
      if (this.state === "port-conflict") return;
      this.scheduleRestart(code ?? 0);
    });
    void this.probeHealth();
  }

  private async probeHealth(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline && this.child) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/healthz`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          this.setState("running");
          this.restarts = 0;
          return;
        }
      } catch (error) {
        const message = String((error as Error).message ?? error);
        // The relay exits with EADDRINUSE; distinguish a port clash from a
        // slow start so the UI can tell the user what to change.
        if (message.includes("fetch failed") && !this.child) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (this.child && this.state !== "running") {
      this.setState("crashed", `health probe failed on :${this.port}`);
      this.scheduleRestart(1);
    }
  }

  private scheduleRestart(exitCode: number): void {
    if (this.disposed) return;
    this.restarts += 1;
    if (this.restarts > MAX_RESTARTS) {
      this.setState("crashed", `exited code=${exitCode}; gave up after ${MAX_RESTARTS} restarts`);
      return;
    }
    this.setState("crashed", `exited code=${exitCode}; restarting…`);
    const delay = RESTART_BACKOFF_MS[Math.min(this.restarts - 1, RESTART_BACKOFF_MS.length - 1)];
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.disposed) this.spawnChild();
    }, delay);
    if (typeof this.restartTimer.unref === "function") this.restartTimer.unref();
  }
}

/** True when nothing else holds the TCP port (exclusive bind probe). */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

/** Dev: out/relay/relay.mjs (sibling of out/main); packaged: resources/relay/relay.mjs. */
export function resolveRelayEntry(mainDirectory = __dirname): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "relay", "relay.mjs");
  return path.join(mainDirectory, "..", "relay", "relay.mjs");
}

/** Diagnostics id for logs. */
export function newRelayInstanceId(): string {
  return `relay-${randomUUID().slice(0, 8)}`;
}
