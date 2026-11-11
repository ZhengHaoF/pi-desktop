import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { call } from "@/lib/api-client";
import { useI18n } from "@/i18n";
import type { LanAddress, RemoteControlConfig, RemoteControlStatus, RelayServiceStatus } from "@contract/desktop";
import { Button } from "@/components/ui/Button";

const DEFAULT_PORT = 8788;
const DEFAULT_RELAY_URL = `ws://127.0.0.1:${DEFAULT_PORT}/ws`;

type Draft = {
  enabled: boolean;
  mode: "lan" | "custom";
  relayUrl: string;
  lanPort: number;
  name: string;
};

function toDraft(config: RemoteControlConfig | null): Draft {
  return {
    enabled: config?.enabled ?? false,
    mode: config?.mode ?? "lan",
    relayUrl: config?.relayUrl ?? DEFAULT_RELAY_URL,
    lanPort: config?.lanPort ?? DEFAULT_PORT,
    name: config?.name ?? "",
  };
}

function statusColor(state: string | undefined): string {
  switch (state) {
    case "running":
    case "ready":
      return "#07c160";
    case "starting":
    case "connecting":
      return "#e6a23c";
    case "port-conflict":
    case "crashed":
    case "stopped":
      return "#f56c6c";
    default:
      return "var(--text-dim)";
  }
}

/**
 * QR rendered straight from the encoder matrix (no canvas/pngjs) so it works
 * inside the sandboxed renderer and stays crisp at any size.
 */
function QrCode({ value, size = 132 }: { value: string; size?: number }) {
  const cells = useMemo(() => {
    try {
      const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
      const count = qr.modules.size;
      const data = qr.modules.data as unknown as Uint8Array | number[];
      const rects: Array<{ x: number; y: number }> = [];
      for (let y = 0; y < count; y += 1) {
        for (let x = 0; x < count; x += 1) {
          if (data[y * count + x]) rects.push({ x, y });
        }
      }
      return { count, rects };
    } catch {
      return null;
    }
  }, [value]);

  if (!cells) return null;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${cells.count} ${cells.count}`} shapeRendering="crispEdges">
      <rect width={cells.count} height={cells.count} fill="#fff" />
      {cells.rects.map((cell) => (
        <rect key={`${cell.x}-${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} fill="#111" />
      ))}
    </svg>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  fontSize: 12,
  color: "var(--text)",
  background: "var(--bg)",
};

export function RemoteControlCard() {
  const { t } = useI18n();
  const [config, setConfig] = useState<RemoteControlConfig | null>(null);
  const [draft, setDraft] = useState<Draft>(() => toDraft(null));
  const [remoteStatus, setRemoteStatus] = useState<RemoteControlStatus | null>(null);
  const [relayStatus, setRelayStatus] = useState<RelayServiceStatus | null>(null);
  const [lanAddresses, setLanAddresses] = useState<LanAddress[]>([]);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ token: string; expiresAt: number } | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState("");
  const [devices, setDevices] = useState<
    Array<{ deviceId: string; label?: string; pairedAt: number; online: boolean }>
  >([]);
  const [reconnecting, setReconnecting] = useState(false);

  const loadLanAddresses = useCallback(async () => {
    try {
      setLanAddresses(await window.piBridge.listLanAddresses());
    } catch {
      setLanAddresses([]);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void window.piBridge.getUiState().then((state) => {
      if (disposed) return;
      const rc = state.remoteControl ?? null;
      setConfig(rc);
      setDraft(toDraft(rc));
    });
    void window.piBridge.getRemoteStatus().then((status) => {
      if (!disposed) setRemoteStatus(status);
    });
    void window.piBridge.getRelayServiceStatus().then((status) => {
      if (!disposed) setRelayStatus(status);
    });
    void loadLanAddresses();
    const unsubRemote = window.piBridge.onRemoteStatus((status) => {
      if (disposed) return;
      setRemoteStatus(status);
      // 托盘/其他入口可能改总开关；state=disabled 即关闭，镜像到本地草稿。
      const enabled = status.state !== "disabled";
      setDraft((d) => (d.enabled === enabled ? d : { ...d, enabled }));
    });
    const unsubRelay = window.piBridge.onRelayServiceStatus((status) => {
      if (!disposed) setRelayStatus(status);
    });
    return () => {
      disposed = true;
      unsubRemote();
      unsubRelay();
    };
  }, [loadLanAddresses]);

  const save = useCallback(
    async (next: Draft) => {
      setSaving(true);
      setError("");
      try {
        const isLan = next.mode === "lan";
        const payload: RemoteControlConfig = {
          enabled: next.enabled,
          mode: next.mode,
          relayUrl: isLan ? `ws://127.0.0.1:${next.lanPort}/ws` : next.relayUrl.trim(),
          lanPort: next.lanPort,
          name: next.name.trim() || undefined,
          hostId: config?.hostId,
        };
        await window.piBridge.setUiState({ remoteControl: payload });
        setConfig(payload);
        setDraft({ ...next, relayUrl: payload.relayUrl });
        // Port may have changed → LAN URLs change with it.
        void loadLanAddresses();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [config?.hostId, loadLanAddresses],
  );

  const copy = (text: string, key: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    });
  };

  // 手动重连：main 会拉起内置 relay（lan 模式）并让 gateway 立即重拨。
  // 状态翻转经 onRemoteStatus 推送回来；这里短暂保持 busy 让点击有反馈。
  const reconnect = useCallback(() => {
    if (reconnecting || !draft.enabled) return;
    setReconnecting(true);
    void window.piBridge.reconnectRemote().finally(() => {
      window.setTimeout(() => setReconnecting(false), 1500);
    });
  }, [reconnecting, draft.enabled]);

  const loadDevices = useCallback(async (opts?: { quiet?: boolean }) => {
    try {
      const result = await call("remote.pair.devices");
      setDevices(result.devices ?? []);
    } catch (err) {
      // Poll-triggered refreshes stay silent (transient drops); user-facing
      // loads surface the error so "empty list" is never mistaken for a bug.
      if (!opts?.quiet) setPairingError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Paired/online counts live on the relay: reload when the gateway link is
  // ready and poll lightly so the online flags stay fresh.
  const remoteReady = remoteStatus?.state === "ready";
  useEffect(() => {
    if (!draft.enabled || !remoteReady) return;
    void loadDevices();
    const timer = window.setInterval(() => void loadDevices({ quiet: true }), 10_000);
    return () => window.clearInterval(timer);
  }, [draft.enabled, remoteReady, loadDevices]);

  const createPairingQr = useCallback(async () => {
    setPairingBusy(true);
    setPairingError("");
    try {
      const created = await call("remote.pair.create");
      setPairing(created);
      void loadDevices();
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : String(err));
    } finally {
      setPairingBusy(false);
    }
  }, [loadDevices]);

  const revokeDevice = useCallback(
    async (deviceId: string) => {
      setPairingError("");
      try {
        await call("remote.pair.revoke", { deviceId });
        await loadDevices();
      } catch (err) {
        setPairingError(err instanceof Error ? err.message : String(err));
      }
    },
    [loadDevices],
  );

  const preferred = lanAddresses.find((entry) => entry.preferred) ?? lanAddresses[0] ?? null;
  const active = lanAddresses.find((entry) => entry.url === selectedUrl) ?? preferred;
  const isLan = draft.mode === "lan";
  // Same source as the list below (relay pair.devices) — the count can never
  // disagree with the paired-device rows again.
  const onlineCount = devices.filter((device) => device.online).length;

  // 手机扫码载荷：relay 地址 + 目标 hostId + 一次性配对 token。
  const pairingQrValue = useMemo(() => {
    if (!pairing) return "";
    const relayUrl = isLan ? (active?.url ?? draft.relayUrl) : draft.relayUrl.trim();
    return JSON.stringify({
      v: 1,
      relayUrl,
      hostId: config?.hostId ?? "",
      token: pairing.token,
      ...(config?.e2eePublicKey ? { e2eePub: config.e2eePublicKey } : {}),
    });
  }, [pairing, isLan, active?.url, draft.relayUrl, config?.hostId, config?.e2eePublicKey]);

  const relayStateLabel = !draft.enabled
    ? t("remoteStateDisabled", "Disabled")
    : isLan
      ? (relayStatus?.state === "running" && t("relayStateRunning", "Running")) ||
        (relayStatus?.state === "starting" && t("relayStateStarting", "Starting…")) ||
        (relayStatus?.state === "port-conflict" && t("relayStatePortConflict", "Port in use")) ||
        (relayStatus?.state === "crashed" && t("relayStateCrashed", "Stopped unexpectedly")) ||
        t("relayStateIdle", "Stopped")
      : (remoteStatus?.state === "ready" && t("remoteStateReady", "Connected")) ||
        (remoteStatus?.state === "connecting" && t("remoteStateConnecting", "Connecting…")) ||
        (remoteStatus?.state === "stopped" && t("remoteStateStopped", "Offline (auto-reconnecting)")) ||
        t("remoteStateConnecting", "Connecting…");

  const indicator = !draft.enabled
    ? "stopped"
    : isLan
      ? relayStatus?.state
      : remoteStatus?.state === "ready"
        ? "running"
        : remoteStatus?.state === "connecting"
          ? "starting"
          : "stopped";

  return (
    <section style={{ marginTop: 20 }}>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          textTransform: "uppercase",
          letterSpacing: ".08em",
          marginBottom: 8,
        }}
      >
        {t("remoteControlSection", "Self-hosted · Phone app remote access")}
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: 9, padding: 14, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 9, height: 9, borderRadius: 999, background: statusColor(indicator), flex: "none" }} />
          <span style={{ fontSize: 12, color: "var(--text)", fontWeight: 600 }}>{relayStateLabel}</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {t("remotePairedDevices", "Paired devices")}: {devices.length}
            {devices.length > 0 ? ` · ${t("remoteOnlineDevices", "online")}: ${onlineCount}` : null}
          </span>
          {draft.enabled && (
            <Button
              type="button"
              disabled={reconnecting}
              style={{ padding: "4px 10px", borderRadius: 7, fontSize: 11 }}
              onClick={reconnect}
            >
              {reconnecting ? t("remoteReconnecting", "Reconnecting…") : t("remoteReconnect", "Reconnect")}
            </Button>
          )}
          <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={saving}
              onChange={(e) => void save({ ...draft, enabled: e.target.checked })}
            />
            <span style={{ fontSize: 12 }}>{t("remoteEnable", "Enable remote control")}</span>
          </label>
        </div>

        <div style={{ display: "flex", gap: 16, alignItems: "center", fontSize: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input
              type="radio"
              name="remote-mode"
              checked={isLan}
              disabled={saving}
              onChange={() => void save({ ...draft, mode: "lan" })}
            />
            {t("remoteModeLan", "LAN (built-in relay)")}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input
              type="radio"
              name="remote-mode"
              checked={!isLan}
              disabled={saving}
              onChange={() => void save({ ...draft, mode: "custom" })}
            />
            {t("remoteModeCustom", "Custom relay (VPS etc.)")}
          </label>
        </div>

        {isLan ? (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("relayPort", "Port")}</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={draft.lanPort}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, lanPort: Number(e.target.value) || DEFAULT_PORT })}
                style={{ ...inputStyle, width: 96 }}
              />
              <Button
                type="button"
                disabled={saving || draft.lanPort === (config?.lanPort ?? DEFAULT_PORT)}
                style={{ padding: "7px 12px", borderRadius: 8, fontSize: 12 }}
                onClick={() => void save(draft)}
              >
                {t("remoteApplyPort", "Apply")}
              </Button>
              <Button
                type="button"
                style={{ padding: "7px 12px", borderRadius: 8, fontSize: 12 }}
                onClick={() => void loadLanAddresses()}
              >
                {t("relayRefreshAddresses", "Refresh addresses")}
              </Button>
              {relayStatus?.state === "port-conflict" && (
                <span style={{ fontSize: 11, color: "#f56c6c" }}>
                  {t("relayPortConflictHint", "Port already in use — pick another one.")}
                </span>
              )}
            </div>

            {active ? (
              <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                <div style={{ flex: 1, display: "grid", gap: 6 }}>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    {t("relayLanAddressHint", "Phone relay address (same Wi-Fi / LAN):")}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {lanAddresses.map((entry) => (
                      <Button
                        key={entry.url}
                        type="button"
                        onClick={() => setSelectedUrl(entry.url)}
                        title={entry.url}
                        aria-pressed={entry.url === active.url}
                        style={{
                          padding: "4px 8px",
                          borderRadius: 6,
                          fontSize: 10.5,
                        }}
                      >
                        {entry.iface}
                      </Button>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <code
                      title={active.url}
                      style={{
                        flex: 1,
                        padding: "6px 8px",
                        borderRadius: 6,
                        // Neutral tint derived from the border color: --tool-bg is
                        // the dark tool-card surface and made the text unreadable here.
                        background: "color-mix(in srgb, var(--border) 45%, transparent)",
                        color: "var(--text)",
                        fontSize: 11,
                        fontFamily: "var(--font-mono, monospace)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {active.url}
                    </code>
                    <Button
                      type="button"
                      style={{ padding: "6px 10px", borderRadius: 6, fontSize: 11 }}
                      onClick={() => copy(active.url, "url")}
                    >
                      {copied === "url" ? t("remoteCopied", "Copied") : t("remoteCopy", "Copy")}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                {t("relayNoLanAddress", "No LAN IPv4 address found — connect this PC to Wi-Fi or Ethernet.")}
              </div>
            )}

            <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }}>
              {relayStatus?.detail && relayStatus.state !== "running" ? (
                <div style={{ color: "#f56c6c" }}>{relayStatus.detail}</div>
              ) : null}
              {t(
                "relayLanWarning",
                "The built-in relay listens on this port for the whole LAN and runs plaintext for now (no E2EE). Enable it only on a trusted network.",
              )}
            </div>
          </>
        ) : (
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div style={{ flex: 1, display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="text"
                  value={draft.relayUrl}
                  disabled={saving}
                  spellCheck={false}
                  onChange={(e) => setDraft({ ...draft, relayUrl: e.target.value })}
                  placeholder="wss://relay.example.com/ws"
                  style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-mono, monospace)" }}
                />
                <Button
                  type="button"
                  disabled={saving || draft.relayUrl.trim() === (config?.relayUrl ?? "")}
                  style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12 }}
                  onClick={() => void save(draft)}
                >
                  {t("remoteApplyUrl", "Apply URL")}
                </Button>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Button
                  type="button"
                  style={{ padding: "6px 10px", borderRadius: 6, fontSize: 11 }}
                  onClick={() => copy(draft.relayUrl.trim(), "custom-url")}
                >
                  {copied === "custom-url" ? t("remoteCopied", "Copied") : t("remoteCopy", "Copy")}
                </Button>
              </div>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--text-dim)", flex: "none" }}>
            {t("remotePcName", "PC name (shown on device selectors)")}
          </span>
          <input
            type="text"
            value={draft.name}
            disabled={saving}
            maxLength={64}
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="My-PC"
            style={{ ...inputStyle, flex: 1 }}
          />
          <Button
            type="button"
            disabled={saving || draft.name.trim() === (config?.name ?? "")}
            style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12 }}
            onClick={() => void save(draft)}
          >
            {t("remoteApplyName", "Apply")}
          </Button>
        </div>

        {error && <div style={{ fontSize: 12, color: "#f56c6c" }}>{error}</div>}

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              {t("remotePairingTitle", "Device pairing (scan with phone)")}
            </span>
            <Button
              type="button"
              disabled={pairingBusy || !draft.enabled}
              style={{ padding: "6px 10px", borderRadius: 8, fontSize: 12 }}
              onClick={() => void createPairingQr()}
            >
              {pairingBusy ? t("remotePairingCreating", "Generating…") : t("remotePairingAdd", "Add device")}
            </Button>
            <Button
              type="button"
              disabled={!draft.enabled}
              style={{ padding: "6px 10px", borderRadius: 8, fontSize: 12 }}
              onClick={() => void loadDevices()}
            >
              {t("remotePairingRefresh", "Refresh devices")}
            </Button>
            {!draft.enabled && (
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                {t("remotePairingEnableFirst", "Enable remote control first")}
              </span>
            )}
          </div>

          {pairing && pairingQrValue ? (
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div style={{ background: "#fff", padding: 8, borderRadius: 8, border: "1px solid var(--border)" }}>
                <QrCode value={pairingQrValue} size={144} />
              </div>
              <div style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
                <span>
                  {t(
                    "remotePairingHint",
                    "In the phone app, open the connect page and scan this QR code. The token is one-time and valid for 10 minutes.",
                  )}
                </span>
                <span>
                  {t("remotePairingExpires", "Expires at")}: {new Date(pairing.expiresAt).toLocaleTimeString()}
                </span>
                <Button
                  type="button"
                  style={{
                    justifySelf: "start",
                    padding: "5px 10px",
                    borderRadius: 8,
                    fontSize: 11.5,
                  }}
                  onClick={() => copy(pairingQrValue, "pairing-qr")}
                >
                  {copied === "pairing-qr" ? t("copied", "Copied") : t("remotePairingCopy", "Copy pairing payload")}
                </Button>
              </div>
            </div>
          ) : null}

          {devices.length > 0 ? (
            <div style={{ display: "grid", gap: 4 }}>
              {devices.map((device) => (
                <div key={device.deviceId} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                  <span
                    title={device.online ? t("remoteDeviceOnline", "online") : t("remoteDeviceOffline", "offline")}
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      flex: "none",
                      background: device.online ? "#07c160" : "var(--text-dim)",
                    }}
                  />
                  <span style={{ flex: 1, color: "var(--text)" }}>
                    {device.label?.trim() ? device.label : device.deviceId}
                    <span style={{ color: "var(--text-dim)", marginLeft: 8, fontSize: 11 }}>
                      {new Date(device.pairedAt).toLocaleDateString()}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="danger"
                    style={{ padding: "4px 9px", borderRadius: 7, fontSize: 11.5 }}
                    onClick={() => void revokeDevice(device.deviceId)}
                  >
                    {t("remotePairingRevoke", "Revoke")}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {t("remotePairingEmpty", "No paired devices yet")}
            </span>
          )}
          {pairingError && <div style={{ fontSize: 11, color: "#f56c6c" }}>{pairingError}</div>}
        </div>
      </div>
    </section>
  );
}
