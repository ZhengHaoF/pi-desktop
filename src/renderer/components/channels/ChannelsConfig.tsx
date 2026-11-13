import { ChannelToolSelection } from "./ChannelToolSelection";
import { QRCodeSVG } from "@rc-component/qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChannelAccountConfig,
  ChannelAccountView,
  ChannelBinding,
  ChannelLoginEvent,
  ChannelProbeResult,
  ChannelStatus,
  ChannelActivity,
  ChannelRuntimeState,
  ChannelsSnapshot,
  FeishuDomain,
} from "@shared/channel-types";
import { FEISHU_REQUIRED_TENANT_SCOPES } from "@shared/feishu-app";
import type { SessionInfo } from "@contract/types";
import { call, listSessions, subscribe } from "@/lib/api-client";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/i18n";
import { RemoteControlCard } from "./RemoteControlCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SecretTextInput } from "@/components/ui/SecretTextInput";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";
import { Dialog } from "@/components/ui/Dialog";
import { useConfirm } from "@/components/ui/ConfirmDialog";

const EMPTY: ChannelsSnapshot = { accounts: [], statuses: [], pairings: [], bindings: [], activities: [] };
const TELEGRAM_BASE_URL = "https://api.telegram.org";
const FEISHU_BASE_URLS: Record<FeishuDomain, string> = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
};
export const FEISHU_PERMISSION_IMPORT_JSON = JSON.stringify(
  {
    scopes: {
      tenant: FEISHU_REQUIRED_TENANT_SCOPES,
      user: [],
    },
  },
  null,
  2,
);

function statusFor(snapshot: ChannelsSnapshot, accountId: string): ChannelStatus | undefined {
  return snapshot.statuses.find((status) => status.accountId === accountId);
}

function statusColor(status?: ChannelStatus): string {
  if (status?.state === "running") return "var(--success)";
  if (status?.state === "starting" || status?.state === "reconnecting") return "var(--warning)";
  if (status?.state === "error") return "var(--danger)";
  return "var(--text-dim)";
}

type Translate = (key: string, fallback: string) => string;

function channelStatusLabel(status: ChannelRuntimeState, t: Translate): string {
  switch (status) {
    case "starting":
      return t("channelStatus_starting", "starting");
    case "running":
      return t("channelStatus_running", "running");
    case "reconnecting":
      return t("channelStatus_reconnecting", "reconnecting");
    case "stopped":
      return t("channelStatus_stopped", "stopped");
    case "error":
      return t("channelStatus_error", "error");
  }
}

function activityDirectionLabel(direction: ChannelActivity["direction"], t: Translate): string {
  switch (direction) {
    case "inbound":
      return t("activityDirection_inbound", "inbound");
    case "outbound":
      return t("activityDirection_outbound", "outbound");
    case "system":
      return t("activityDirection_system", "system");
  }
}

function activityOutcomeLabel(outcome: ChannelActivity["outcome"], t: Translate): string {
  switch (outcome) {
    case "accepted":
      return t("activityOutcome_accepted", "accepted");
    case "ignored":
      return t("activityOutcome_ignored", "ignored");
    case "sent":
      return t("activityOutcome_sent", "sent");
    case "failed":
      return t("activityOutcome_failed", "failed");
  }
}

function channelLabel(channel: ChannelAccountConfig["channel"], t: Translate, domain?: FeishuDomain): string {
  if (channel === "telegram") return "Telegram";
  if (channel === "feishu") {
    if (domain === "lark") return "Lark";
    if (domain === "feishu") return t("feishu", "Feishu");
    return t("feishuLark", "Feishu / Lark");
  }
  return t("weixin", "WeChat");
}

function channelAccent(channel: ChannelAccountConfig["channel"]): string {
  if (channel === "telegram") return "#229ed9";
  if (channel === "feishu") return "#3370ff";
  return "#07c160";
}

export function ChannelsConfig({ onSnapshotChange }: { onSnapshotChange?: (snapshot: ChannelsSnapshot) => void }) {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirm();
  const [snapshot, setSnapshot] = useState<ChannelsSnapshot>(EMPTY);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [login, setLogin] = useState<ChannelLoginEvent | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [telegramDialogOpen, setTelegramDialogOpen] = useState(false);
  const [telegramError, setTelegramError] = useState("");
  const [feishuDialogOpen, setFeishuDialogOpen] = useState(false);
  const [feishuError, setFeishuError] = useState("");
  const [feishuScanDomain, setFeishuScanDomain] = useState<FeishuDomain>("feishu");

  const refresh = useCallback(async () => {
    try {
      const [channels, sessionResult] = await Promise.all([call("channels.list"), listSessions()]);
      setSnapshot(channels);
      onSnapshotChange?.(channels);
      setSessions(sessionResult.sessions);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [onSnapshotChange]);

  useEffect(() => {
    void refresh();
    const unsubs: Array<() => void> = [];
    void Promise.all([
      subscribe("channels.status", "*", () => void refresh()),
      subscribe("channels.pairing", "*", () => void refresh()),
      subscribe("channels.binding", "*", () => void refresh()),
      subscribe("channels.activity", "*", () => void refresh()),
      subscribe("channels.login", "*", (event) => setLogin(event)),
    ]).then((items) => unsubs.push(...items));
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }, [refresh]);

  useEffect(() => {
    if (
      !login ||
      ["confirmed", "already_connected", "expired", "error", "cancelled", "verification_required"].includes(login.phase)
    ) {
      return;
    }
    let cancelled = false;
    const delay = Math.min(10_000, Math.max(500, login.pollAfterMs ?? 600));
    const timer = setTimeout(() => {
      void call("channels.loginWait", { channel: login.channel, sessionKey: login.sessionKey })
        .then((event) => {
          if (!cancelled) {
            setLogin(event);
            if (event.phase === "confirmed" || event.accountId) void refresh();
          }
        })
        .catch((cause) => {
          if (!cancelled) {
            setLogin({
              ...login,
              phase: "error",
              message: cause instanceof Error ? cause.message : String(cause),
            });
          }
        });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [login, refresh]);

  const run = useCallback(
    async (task: () => Promise<unknown>) => {
      setBusy(true);
      setError("");
      try {
        await task();
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const beginLogin = () =>
    run(async () => {
      const event = await call("channels.loginStart", { channel: "weixin", force: true });
      setLogin(event);
    });

  const beginFeishuLogin = async (domain: FeishuDomain) => {
    setBusy(true);
    setFeishuError("");
    setFeishuScanDomain(domain);
    try {
      const event = await call("channels.loginStart", { channel: "feishu", domain, force: true });
      setFeishuDialogOpen(false);
      setLogin(event);
    } catch (cause) {
      setFeishuError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const connectTelegram = async (token: string) => {
    setBusy(true);
    setTelegramError("");
    try {
      const now = new Date().toISOString();
      const accountId = `telegram-${crypto.randomUUID()}`;
      const account: ChannelAccountConfig = {
        id: accountId,
        channel: "telegram",
        name: "",
        enabled: false,
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "disabled",
        groupIds: [],
        groupAllowFrom: [],
        requireMention: true,
        commandsEnabled: false,
        toolNames: [],
        createdAt: now,
        updatedAt: now,
      };
      if (typeof window.piBridge.setChannelCredential !== "function") {
        throw new Error(
          t("telegramBridgeUnavailable", "The desktop runtime is outdated. Restart Pi Desktop and try again."),
        );
      }
      await window.piBridge.setChannelCredential({
        channel: "telegram",
        accountId,
        credential: { token, providerAccountId: accountId, baseUrl: TELEGRAM_BASE_URL },
      });
      const next = await call("channels.accountConnect", { account });
      setSnapshot(next);
      onSnapshotChange?.(next);
      setTelegramDialogOpen(false);
    } catch (cause) {
      setTelegramError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const connectFeishu = async (appId: string, appSecret: string, domain: FeishuDomain) => {
    setBusy(true);
    setFeishuError("");
    try {
      const now = new Date().toISOString();
      const accountId = `feishu-${crypto.randomUUID()}`;
      const account: ChannelAccountConfig = {
        id: accountId,
        channel: "feishu",
        name: "",
        enabled: false,
        appId,
        domain,
        baseUrl: FEISHU_BASE_URLS[domain],
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "disabled",
        groupIds: [],
        groupAllowFrom: [],
        requireMention: true,
        commandsEnabled: false,
        toolNames: [],
        createdAt: now,
        updatedAt: now,
      };
      if (typeof window.piBridge.setChannelCredential !== "function") {
        throw new Error(
          t("channelBridgeUnavailable", "The desktop credential bridge is unavailable. Restart Pi Desktop."),
        );
      }
      await window.piBridge.setChannelCredential({
        channel: "feishu",
        accountId,
        credential: {
          token: appSecret,
          providerAccountId: accountId,
          baseUrl: FEISHU_BASE_URLS[domain],
        },
      });
      const next = await call("channels.accountConnect", { account });
      setSnapshot(next);
      onSnapshotChange?.(next);
      setFeishuDialogOpen(false);
    } catch (cause) {
      setFeishuError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const closeLogin = () => {
    if (login && !["confirmed", "already_connected", "expired", "error", "cancelled"].includes(login.phase)) {
      void call("channels.loginCancel", { channel: login.channel, sessionKey: login.sessionKey });
    }
    setLogin(null);
    setVerificationCode("");
  };

  const configuredCount = snapshot.accounts.filter((account) => account.configured).length;

  return (
    <div style={{ width: "100%", overflowY: "auto", padding: "22px clamp(16px, 4vw, 36px)" }}>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <h2 style={{ margin: 0, color: "var(--text)", fontSize: 16 }}>
              {t("messagingChannels", "Messaging channels")}
            </h2>
            <p style={{ margin: "6px 0 0", color: "var(--text-dim)", fontSize: 12, lineHeight: 1.6 }}>
              {t("channelsDescription", "Connect IM accounts, control access, and bind conversations to Pi sessions.")}
            </p>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 7 }}>
            <Button
              type="button"
              disabled={busy}
              size="lg"
              onClick={() => {
                setFeishuError("");
                setFeishuDialogOpen(true);
              }}
            >
              {t("connectFeishu", "Connect Feishu / Lark")}
            </Button>
            <Button
              type="button"
              disabled={busy}
              size="lg"
              onClick={() => {
                setTelegramError("");
                setTelegramDialogOpen(true);
              }}
            >
              {t("connectTelegram", "Connect Telegram")}
            </Button>
            <Button type="button" disabled={busy} size="lg" onClick={beginLogin}>
              {t("connectWeixin", "Connect WeChat")}
            </Button>
          </div>
        </div>

        {error && (
          <div
            style={{
              marginTop: 14,
              border: "1px solid var(--danger-border)",
              background: "var(--danger-soft)",
              color: "var(--danger)",
              borderRadius: 7,
              padding: 10,
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <RemoteControlCard />

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
            {t("channelOverview", "Overview")} · {configuredCount} {t("configuredAccounts", "accounts configured")}
          </div>
          {loading ? (
            <div style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("loading", "Loading…")}</div>
          ) : snapshot.accounts.length === 0 ? (
            <div
              style={{
                border: "1px dashed var(--border)",
                borderRadius: 9,
                padding: 28,
                textAlign: "center",
                color: "var(--text-dim)",
                fontSize: 12,
              }}
            >
              {t(
                "noChannels",
                "No messaging accounts configured. Connect WeChat, Telegram, or Feishu / Lark to get started.",
              )}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {snapshot.accounts.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  status={statusFor(snapshot, account.id)}
                  busy={busy}
                  onSave={(next) => run(() => call("channels.accountUpsert", { account: next }))}
                  onStart={() => run(() => call("channels.start", { accountId: account.id }))}
                  onStop={() => run(() => call("channels.stop", { accountId: account.id }))}
                  onRestart={() => run(() => call("channels.restart", { accountId: account.id }))}
                  onProbe={() => call("channels.probe", { accountId: account.id })}
                  onUpdateToken={async (token) => {
                    await window.piBridge.setChannelCredential({
                      channel: account.channel,
                      accountId: account.id,
                      credential: {
                        token,
                        providerAccountId: account.providerAccountId ?? account.id,
                        ...(account.providerUsername ? { providerUsername: account.providerUsername } : {}),
                        baseUrl: account.baseUrl || TELEGRAM_BASE_URL,
                      },
                    });
                    const probe = await call("channels.probe", { accountId: account.id });
                    if (!probe.ok || !probe.providerAccountId) throw new Error(probe.message);
                    await window.piBridge.setChannelCredential({
                      channel: account.channel,
                      accountId: account.id,
                      credential: {
                        token,
                        providerAccountId: probe.providerAccountId,
                        ...(probe.providerUsername ? { providerUsername: probe.providerUsername } : {}),
                        baseUrl: account.baseUrl || TELEGRAM_BASE_URL,
                      },
                    });
                    await call("channels.accountUpsert", {
                      account: {
                        ...account,
                        enabled: true,
                        providerAccountId: probe.providerAccountId,
                        ...(probe.providerUsername ? { providerUsername: probe.providerUsername } : {}),
                        name: account.name || probe.providerUsername || probe.displayName || "Telegram",
                        updatedAt: new Date().toISOString(),
                      },
                    });
                    return probe;
                  }}
                  onUpdateFeishuCredential={async (nextAccount, appSecret) => {
                    const appId = nextAccount.appId?.trim();
                    const domain = nextAccount.domain === "lark" ? "lark" : "feishu";
                    if (!appId) throw new Error(t("feishuAppIdRequired", "App ID is required."));
                    await window.piBridge.setChannelCredential({
                      channel: "feishu",
                      accountId: account.id,
                      credential: {
                        token: appSecret,
                        providerAccountId: account.providerAccountId ?? account.id,
                        baseUrl: FEISHU_BASE_URLS[domain],
                      },
                    });
                    await call("channels.accountUpsert", {
                      account: {
                        ...nextAccount,
                        appId,
                        domain,
                        baseUrl: FEISHU_BASE_URLS[domain],
                        enabled: true,
                        updatedAt: new Date().toISOString(),
                      },
                    });
                    const probe = await call("channels.probe", { accountId: account.id });
                    if (!probe.ok || !probe.providerAccountId) throw new Error(probe.message);
                    await window.piBridge.setChannelCredential({
                      channel: "feishu",
                      accountId: account.id,
                      credential: {
                        token: appSecret,
                        providerAccountId: probe.providerAccountId,
                        baseUrl: FEISHU_BASE_URLS[domain],
                      },
                    });
                    await call("channels.accountUpsert", {
                      account: {
                        ...nextAccount,
                        appId,
                        domain,
                        baseUrl: FEISHU_BASE_URLS[domain],
                        enabled: true,
                        providerAccountId: probe.providerAccountId,
                        name: nextAccount.name || probe.displayName || channelLabel("feishu", t, domain),
                        updatedAt: new Date().toISOString(),
                      },
                    });
                    await refresh();
                    return probe;
                  }}
                  onTestSend={(peerId, message) =>
                    run(() => call("channels.testSend", { accountId: account.id, peerId, message }))
                  }
                  onDelete={() => {
                    void confirm({
                      title: t("deleteChannelConfirm", "Delete this messaging account and its bindings?"),
                      danger: true,
                      confirmLabel: t("delete", "Delete"),
                    }).then((ok) => {
                      if (ok) void run(() => call("channels.accountDelete", { accountId: account.id }));
                    });
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <PairingSection snapshot={snapshot} busy={busy} run={run} />
        <BindingsSection snapshot={snapshot} sessions={sessions} busy={busy} run={run} />
        <ActivitySection snapshot={snapshot} />
      </div>

      {/* Always mounted so the shared Dialog shell can play its exit
          animation; open drives visibility and each dialog freezes its own
          content for the shrink-out. */}
      <LoginDialog
        open={login !== null}
        event={login}
        code={verificationCode}
        setCode={setVerificationCode}
        onSubmitCode={() => {
          if (!login) return;
          const pendingLogin = login;
          void run(async () => {
            await call("channels.loginSubmitCode", {
              channel: pendingLogin.channel,
              sessionKey: pendingLogin.sessionKey,
              code: verificationCode,
            });
            setVerificationCode("");
            setLogin({ ...pendingLogin, phase: "waiting", message: "正在验证…" });
          });
        }}
        onRetry={() => {
          if (!login) return;
          if (login.channel === "feishu") void beginFeishuLogin(feishuScanDomain);
          else void beginLogin();
        }}
        onClose={closeLogin}
      />
      <TelegramTokenDialog
        open={telegramDialogOpen}
        busy={busy}
        error={telegramError}
        onConnect={(token) => void connectTelegram(token)}
        onClose={() => setTelegramDialogOpen(false)}
      />
      <FeishuCredentialDialog
        open={feishuDialogOpen}
        busy={busy}
        error={feishuError}
        onStartScan={(domain) => void beginFeishuLogin(domain)}
        onConnect={(appId, appSecret, domain) => void connectFeishu(appId, appSecret, domain)}
        onClose={() => setFeishuDialogOpen(false)}
      />
      {dialog}
    </div>
  );
}

export function AccountCard({
  account,
  status,
  busy,
  onSave,
  onStart,
  onStop,
  onRestart,
  onProbe,
  onUpdateToken,
  onUpdateFeishuCredential,
  onTestSend,
  onDelete,
}: {
  account: ChannelAccountView;
  status?: ChannelStatus;
  busy: boolean;
  onSave: (account: ChannelAccountConfig) => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onProbe: () => Promise<ChannelProbeResult>;
  onUpdateToken: (token: string) => Promise<ChannelProbeResult>;
  onUpdateFeishuCredential: (account: ChannelAccountConfig, appSecret: string) => Promise<ChannelProbeResult>;
  onTestSend: (peerId: string, message: string) => void;
  onDelete: () => void;
}) {
  const { language, t } = useI18n();
  const { confirm, dialog } = useConfirm();
  const [draft, setDraft] = useState<ChannelAccountConfig>(account);
  const [testPeer, setTestPeer] = useState("");
  const [testMessage, setTestMessage] = useState(() => t("channelTestMessage", "Pi Agent Desktop channel test"));
  const [probing, setProbing] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [feishuAppSecret, setFeishuAppSecret] = useState("");
  const [updatingToken, setUpdatingToken] = useState(false);
  const [probeFeedback, setProbeFeedback] = useState<{ ok: boolean; message: string; at: number } | null>(null);
  useEffect(() => setDraft(account), [account]);
  useEffect(() => {
    if (!probeFeedback) return;
    const timer = setTimeout(() => setProbeFeedback(null), 8_000);
    return () => clearTimeout(timer);
  }, [probeFeedback]);

  const handleProbe = async () => {
    setProbing(true);
    setProbeFeedback(null);
    try {
      const result = await onProbe();
      setProbeFeedback({
        ok: result.ok,
        message: result.ok ? t("connectionHealthy", "Connection is healthy") : result.message,
        at: Date.now(),
      });
    } catch (cause) {
      setProbeFeedback({
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
        at: Date.now(),
      });
    } finally {
      setProbing(false);
    }
  };

  const handleTokenUpdate = async () => {
    const token = telegramToken.trim();
    if (!token) return;
    setUpdatingToken(true);
    setProbeFeedback(null);
    try {
      const result = await onUpdateToken(token);
      setTelegramToken("");
      setProbeFeedback({ ok: result.ok, message: result.message, at: Date.now() });
    } catch (cause) {
      setProbeFeedback({ ok: false, message: cause instanceof Error ? cause.message : String(cause), at: Date.now() });
    } finally {
      setUpdatingToken(false);
    }
  };

  const handleFeishuCredentialUpdate = async () => {
    const appId = draft.appId?.trim();
    const appSecret = feishuAppSecret.trim();
    if (!appId || !appSecret) return;
    setUpdatingToken(true);
    setProbeFeedback(null);
    try {
      const result = await onUpdateFeishuCredential(
        { ...draft, appId, domain: draft.domain === "lark" ? "lark" : "feishu" },
        appSecret,
      );
      setFeishuAppSecret("");
      setProbeFeedback({ ok: result.ok, message: result.message, at: Date.now() });
    } catch (cause) {
      setProbeFeedback({ ok: false, message: cause instanceof Error ? cause.message : String(cause), at: Date.now() });
    } finally {
      setUpdatingToken(false);
    }
  };

  const accent = channelAccent(account.channel);
  const label = channelLabel(account.channel, t, account.domain);

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-panel)", padding: 15 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              display: "grid",
              placeItems: "center",
              background: `color-mix(in srgb, ${accent} 12%, transparent)`,
              color: accent,
              fontWeight: 800,
            }}
          >
            {account.channel === "telegram"
              ? "TG"
              : account.channel === "feishu"
                ? account.domain === "lark"
                  ? "L"
                  : "飞"
                : "微"}
          </div>
          <div>
            <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 700 }}>{account.name}</div>
            <div style={{ color: statusColor(status), fontSize: 11, marginTop: 2 }}>
              {channelStatusLabel(status?.state ?? "stopped", t)} ·{" "}
              {account.credentialFingerprint ?? t("notConfigured", "not configured")}
            </div>
            <div style={{ color: "var(--text-dim)", fontSize: 10, marginTop: 2 }}>
              {label}
              {account.providerUsername ? ` · ${account.providerUsername}` : ""}
              {account.providerAccountId ? ` · ${account.providerAccountId}` : ""}
            </div>
          </div>
        </div>
        <Checkbox
          checked={draft.enabled}
          onChange={(enabled) => setDraft({ ...draft, enabled })}
          label={t("enabled", "Enabled")}
          style={{ width: 18, height: 18 }}
        />
      </div>

      {status?.lastError && (
        <div style={{ color: "var(--danger)", fontSize: 11, marginTop: 10 }}>{status.lastError}</div>
      )}

      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10, marginTop: 14 }}
      >
        <Field label={t("channelName", "Name")}>
          <Input
            aria-label={t("channelName", "Name")}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </Field>
        <Field label={t("dmAccess", "Direct-message access")}>
          <Select
            aria-label={t("dmAccess", "Direct-message access")}
            value={draft.dmPolicy}
            onChange={(value) => setDraft({ ...draft, dmPolicy: value as ChannelAccountConfig["dmPolicy"] })}
            options={[
              { value: "pairing", label: t("policyPairing", "Pairing") },
              { value: "allowlist", label: t("policyAllowlistOnly", "Allowlist only") },
              { value: "open", label: t("policyOpenUnsafe", "Open (unsafe)") },
            ]}
          />
        </Field>
        <Field label={t("allowedUserIds", "Allowed user IDs")}>
          <Input
            aria-label={t("allowedUserIds", "Allowed user IDs")}
            value={draft.allowFrom.join(", ")}
            onChange={(event) =>
              setDraft({
                ...draft,
                allowFrom: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <Field label={t("groupAccess", "Group access")}>
          <Select
            aria-label={t("groupAccess", "Group access")}
            value={draft.groupPolicy}
            onChange={(value) => setDraft({ ...draft, groupPolicy: value as ChannelAccountConfig["groupPolicy"] })}
            options={[
              { value: "disabled", label: t("policyDisabledRecommended", "Disabled (recommended)") },
              { value: "allowlist", label: t("policyAllowlist", "Allowlist") },
              { value: "open", label: t("policyOpenUnsafe", "Open (unsafe)") },
            ]}
          />
        </Field>
        <Field label={t("allowedGroupIds", "Allowed group IDs")}>
          <Input
            aria-label={t("allowedGroupIds", "Allowed group IDs")}
            value={draft.groupIds.join(", ")}
            onChange={(event) =>
              setDraft({
                ...draft,
                groupIds: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <Field label={t("allowedGroupSenderIds", "Allowed group sender IDs")}>
          <Input
            aria-label={t("allowedGroupSenderIds", "Allowed group sender IDs")}
            value={draft.groupAllowFrom.join(", ")}
            onChange={(event) =>
              setDraft({
                ...draft,
                groupAllowFrom: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <Field label={t("groupMentionRequired", "Group mention required")}>
          <Checkbox
            checked={draft.requireMention}
            onChange={(checked) => setDraft({ ...draft, requireMention: checked })}
            label={t("requireMention", "Require @mention")}
            style={{ minHeight: 34 }}
          />
        </Field>
        <Field label={t("imCommands", "IM commands")}>
          <Checkbox
            checked={draft.commandsEnabled === true}
            onChange={(checked) => setDraft({ ...draft, commandsEnabled: checked })}
            label={t("enableImCommands", "Enable /help, /status, /new, /compact, and /reload")}
            style={{ minHeight: 34 }}
          />
        </Field>
        <Field label={t("defaultTools", "Default tools")}>
          <ChannelToolSelection
            toolNames={draft.toolNames}
            cwd={draft.defaultCwd}
            onChange={(toolNames) => setDraft({ ...draft, toolNames })}
          />
        </Field>
        <Field label={t("defaultProjectDirectory", "Default project directory")}>
          <div style={{ display: "flex", gap: 6 }}>
            <Input
              aria-label={t("defaultProjectDirectory", "Default project directory")}
              readOnly
              value={draft.defaultCwd ?? t("isolatedChannelWorkspace", "Isolated channel workspace")}
            />
            <Button
              type="button"
              size="lg"
              onClick={() =>
                void window.piBridge.selectDirectory().then((cwd) => cwd && setDraft({ ...draft, defaultCwd: cwd }))
              }
            >
              {t("browse", "Browse")}
            </Button>
          </div>
        </Field>
      </div>

      {account.channel === "telegram" && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(220px,1fr) auto",
              gap: 7,
            }}
          >
            <SecretTextInput
              value={telegramToken}
              onChange={setTelegramToken}
              placeholder={t("newTelegramBotToken", "New BotFather token")}
            />
            <Button
              type="button"
              disabled={busy || updatingToken || !telegramToken.trim()}
              size="lg"
              onClick={() => void handleTokenUpdate()}
            >
              {updatingToken ? t("saving", "Saving…") : t("updateTelegramToken", "Update token")}
            </Button>
          </div>
          <div style={{ marginTop: 6, color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5 }}>
            {t(
              "telegramGroupSetupHint",
              "Basic groups and supergroups are supported; topics require a forum supergroup. Send /status@bot_username first, then copy the chat ID from Recent activity into Allowed group IDs.",
            )}
          </div>
        </div>
      )}

      {account.channel === "feishu" && (
        <div
          data-testid="feishu-credential-settings"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))",
            gap: 7,
            marginTop: 12,
          }}
        >
          <Input
            value={draft.appId ?? ""}
            onChange={(event) => setDraft({ ...draft, appId: event.target.value })}
            placeholder={t("feishuAppId", "App ID (cli_…)")}
          />
          <Select
            value={draft.domain === "lark" ? "lark" : "feishu"}
            onChange={(value) => setDraft({ ...draft, domain: value as FeishuDomain })}
            options={[
              { value: "feishu", label: t("feishuChina", "Feishu (China)") },
              { value: "lark", label: "Lark" },
            ]}
          />
          <SecretTextInput
            value={feishuAppSecret}
            onChange={setFeishuAppSecret}
            placeholder={t("newFeishuAppSecret", "New App Secret")}
          />
          <Button
            type="button"
            disabled={busy || updatingToken || !draft.appId?.trim() || !feishuAppSecret.trim()}
            size="lg"
            onClick={() => void handleFeishuCredentialUpdate()}
          >
            {updatingToken ? t("saving", "Saving…") : t("updateFeishuCredential", "Update credentials")}
          </Button>
          <div style={{ gridColumn: "1 / -1", color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5 }}>
            {t(
              "feishuCredentialHint",
              "Changing the App Secret, App ID, or domain verifies the bot and hot-reloads its WebSocket connection without restarting Pi Desktop.",
            )}
          </div>
          <div
            data-testid="feishu-rich-card-hint"
            style={{ gridColumn: "1 / -1", color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5 }}
          >
            {t(
              "feishuRichCardHint",
              "Markdown final replies use Card JSON 2.0. Streaming also requires cardkit:card:write and Feishu 7.20+; missing card capability falls back safely to a final reply.",
            )}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 13 }}>
        <Button
          type="button"
          disabled={busy}
          variant="primary"
          size="lg"
          onClick={() => {
            const elevated =
              draft.dmPolicy === "open" ||
              draft.groupPolicy === "open" ||
              draft.commandsEnabled === true ||
              draft.toolNames.includes("bash") ||
              draft.toolNames.includes("powershell") ||
              draft.toolNames.includes("write");
            if (!elevated) {
              onSave(draft);
              return;
            }
            void confirm({
              title: t("elevatedChannelTitle", "Elevated channel configuration"),
              message: t(
                "elevatedChannelConfirm",
                "This configuration allows remote messages to reach powerful local capabilities. Confirm that the account and allowed users are trusted.",
              ),
              confirmLabel: t("save", "Save"),
            }).then((ok) => {
              if (ok) onSave(draft);
            });
          }}
        >
          {t("save", "Save")}
        </Button>
        {status?.state === "running" ? (
          <Button type="button" disabled={busy} size="lg" onClick={onStop}>
            {t("stop", "Stop")}
          </Button>
        ) : (
          <Button type="button" disabled={busy || !draft.enabled} size="lg" onClick={onStart}>
            {t("start", "Start")}
          </Button>
        )}
        <Button type="button" disabled={busy} size="lg" onClick={onRestart}>
          {t("restart", "Restart")}
        </Button>
        <Button
          type="button"
          disabled={busy || probing}
          size="lg"
          style={{ opacity: probing ? 0.65 : 1 }}
          onClick={() => void handleProbe()}
        >
          {probing ? t("testingConnection", "Testing…") : t("testConnection", "Test connection")}
        </Button>
        <Button type="button" disabled={busy} variant="danger" size="lg" onClick={onDelete}>
          {t("delete", "Delete")}
        </Button>
      </div>

      {probeFeedback && (
        <div
          role="status"
          data-testid="channel-probe-feedback"
          style={{
            marginTop: 9,
            padding: "7px 9px",
            border: `1px solid ${probeFeedback.ok ? "var(--success-border)" : "var(--danger-border)"}`,
            borderRadius: 6,
            background: probeFeedback.ok ? "var(--success-soft)" : "var(--danger-soft)",
            color: probeFeedback.ok ? "var(--success)" : "var(--danger)",
            fontSize: 11,
          }}
        >
          {probeFeedback.ok ? "✓" : "!"} {probeFeedback.message} ·{" "}
          {new Date(probeFeedback.at).toLocaleTimeString(language)}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(150px,1fr) minmax(220px,2fr) auto",
          gap: 7,
          marginTop: 12,
        }}
      >
        <Input
          value={testPeer}
          onChange={(event) => setTestPeer(event.target.value)}
          placeholder={
            account.channel === "telegram"
              ? t("testSendTelegramChatId", "Telegram chat ID for test-send")
              : account.channel === "feishu"
                ? t("testSendFeishuReceiveId", "Feishu open_id or chat_id for test-send")
                : t("testSendUserId", "User ID for test-send")
          }
        />
        <Input value={testMessage} onChange={(event) => setTestMessage(event.target.value)} />
        <Button
          type="button"
          disabled={busy || !testPeer.trim() || !testMessage.trim()}
          size="lg"
          onClick={() => onTestSend(testPeer.trim(), testMessage.trim())}
        >
          {t("testSend", "Test send")}
        </Button>
      </div>
      {dialog}
    </div>
  );
}

function PairingSection({
  snapshot,
  busy,
  run,
}: {
  snapshot: ChannelsSnapshot;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const { language, t } = useI18n();
  return (
    <Section title={`${t("pairingRequests", "Pairing requests")} (${snapshot.pairings.length})`}>
      {snapshot.pairings.length === 0 ? (
        <EmptyLine>{t("noPairingRequests", "No pending requests.")}</EmptyLine>
      ) : (
        snapshot.pairings.map((pairing) => (
          <div
            key={pairing.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              padding: "9px 0",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              <div>
                {channelLabel(
                  pairing.channel,
                  t,
                  snapshot.accounts.find((account) => account.id === pairing.accountId)?.domain,
                )}{" "}
                · {pairing.peerId}
              </div>
              <div style={{ color: "var(--text-dim)", marginTop: 3 }}>
                {t("pairingCode", "Code")} {pairing.code} · {t("expiresAt", "expires")}{" "}
                {new Date(pairing.expiresAt).toLocaleTimeString(language)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <Button
                disabled={busy}
                variant="primary"
                size="lg"
                onClick={() => void run(() => call("channels.pairingApprove", { pairingId: pairing.id }))}
              >
                {t("approve", "Approve")}
              </Button>
              <Button
                disabled={busy}
                size="lg"
                onClick={() => void run(() => call("channels.pairingReject", { pairingId: pairing.id }))}
              >
                {t("reject", "Reject")}
              </Button>
            </div>
          </div>
        ))
      )}
    </Section>
  );
}

function BindingsSection({
  snapshot,
  sessions,
  busy,
  run,
}: {
  snapshot: ChannelsSnapshot;
  sessions: SessionInfo[];
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <Section title={`${t("conversationBindings", "Conversation bindings")} (${snapshot.bindings.length})`}>
      {snapshot.bindings.length === 0 ? (
        <EmptyLine>
          {t("noConversationBindings", "A binding is created after an approved user sends the first message.")}
        </EmptyLine>
      ) : (
        snapshot.bindings.map((binding) => (
          <BindingRow key={binding.id} binding={binding} sessions={sessions} busy={busy} run={run} />
        ))
      )}
    </Section>
  );
}

function BindingRow({
  binding,
  sessions,
  busy,
  run,
}: {
  binding: ChannelBinding;
  sessions: SessionInfo[];
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [sessionId, setSessionId] = useState(binding.sessionId ?? "");
  useEffect(() => setSessionId(binding.sessionId ?? ""), [binding.sessionId]);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(150px,1fr) minmax(220px,2fr) auto",
        alignItems: "center",
        gap: 8,
        padding: "9px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>
        {channelLabel(binding.channel, t)} · {binding.peerId}
        {binding.threadId ? ` · ${t("topic", "topic")} ${binding.threadId}` : ""}
      </div>
      <Select
        value={sessionId}
        onChange={setSessionId}
        placeholder={t("dedicatedImSession", "Dedicated IM session")}
        options={[
          { value: "", label: t("dedicatedImSession", "Dedicated IM session") },
          ...sessions.map((session) => ({
            value: session.id,
            label: session.name || session.firstMessage || session.id,
          })),
        ]}
      />
      <div style={{ display: "flex", gap: 5 }}>
        <Button
          disabled={busy}
          size="lg"
          onClick={() =>
            void run(() =>
              call("channels.bindingUpsert", {
                binding: { ...binding, sessionId: sessionId || undefined, lastUsedAt: new Date().toISOString() },
              }),
            )
          }
        >
          {t("save", "Save")}
        </Button>
        <Button
          disabled={busy}
          variant="danger"
          size="lg"
          onClick={() => void run(() => call("channels.bindingDelete", { bindingId: binding.id }))}
          title={t("deleteBinding", "Delete binding")}
          aria-label={t("deleteBinding", "Delete binding")}
        >
          ×
        </Button>
      </div>
    </div>
  );
}

function ActivitySection({ snapshot }: { snapshot: ChannelsSnapshot }) {
  const { language, t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const visibleActivities = showAll ? snapshot.activities : snapshot.activities.slice(0, 12);
  return (
    <section
      style={{
        marginTop: 22,
        border: "1px solid var(--border)",
        borderRadius: 9,
        background: "var(--bg-panel)",
        padding: "4px 15px",
      }}
    >
      <Button
        type="button"
        data-testid="channel-activity-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        variant="ghost"
        style={{
          width: "100%",
          minHeight: 50,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: 0,
          border: 0,
          color: "var(--text)",
          textAlign: "left",
        }}
      >
        <span>
          <span style={{ display: "block", fontSize: 12, fontWeight: 700 }}>
            {t("recentActivity", "Recent activity")} ({snapshot.activities.length})
          </span>
          <span style={{ display: "block", marginTop: 3, fontSize: 10, color: "var(--text-dim)" }}>
            {t("recentActivityDescription", "Message content is never logged; the latest 100 records are retained.")}
          </span>
        </span>
        <span
          aria-hidden="true"
          style={{
            color: "var(--text-dim)",
            fontSize: 15,
            transform: expanded ? "rotate(180deg)" : "none",
            transition: "transform .15s ease",
          }}
        >
          ▾
        </span>
      </Button>

      {expanded && (
        <div style={{ borderTop: "1px solid var(--border)", paddingBottom: 8 }}>
          {snapshot.activities.length === 0 ? (
            <EmptyLine>{t("noChannelActivity", "No channel activity yet.")}</EmptyLine>
          ) : (
            visibleActivities.map((activity) => (
              <div
                key={activity.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "7px 0",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 11,
                }}
              >
                <span style={{ color: activity.outcome === "failed" ? "var(--danger)" : "var(--text-muted)" }}>
                  {channelLabel(activity.channel, t)} · {activityDirectionLabel(activity.direction, t)} ·{" "}
                  {activityOutcomeLabel(activity.outcome, t)}
                  {activity.peerId ? ` · ${activity.peerId}` : ""}
                  {activity.detail ? ` · ${activity.detail}` : ""}
                </span>
                <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                  {new Date(activity.at).toLocaleString(language)}
                </span>
              </div>
            ))
          )}
          {snapshot.activities.length > 12 && (
            <Button type="button" size="lg" style={{ marginTop: 9 }} onClick={() => setShowAll((value) => !value)}>
              {showAll
                ? t("showLatestTwelve", "Show latest 12")
                : `${t("showAllActivity", "Show all")} (${snapshot.activities.length})`}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function TelegramTokenDialog({
  open,
  busy,
  error,
  onConnect,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  onConnect: (token: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const tokenInputRef = useRef<HTMLInputElement>(null);
  // The Dialog shell focuses its card on open; re-claim focus for the token field.
  useEffect(() => {
    if (open) tokenInputRef.current?.focus();
  }, [open]);
  // The dialog stays mounted so the shared shell can play its exit animation;
  // keep the last error visible while shrinking out.
  const lastError = useRef(error);
  if (error) lastError.current = error;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel={t("connectTelegram", "Connect Telegram")}
      width={430}
      closeOnBackdrop={false}
      closeOnEscape={!busy}
      style={{ padding: 22, background: "var(--bg)", boxShadow: "0 14px 45px rgba(0,0,0,.25)" }}
    >
      <h3 style={{ margin: 0, color: "var(--text)", fontSize: 16 }}>{t("connectTelegram", "Connect Telegram")}</h3>
      <p style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
        {t(
          "telegramTokenDescription",
          "Create a bot with @BotFather, paste its token here, then Pi Desktop will verify it with getMe and store it using OS encryption.",
        )}
      </p>
      <SecretTextInput
        ref={tokenInputRef}
        value={token}
        onChange={setToken}
        placeholder={t("telegramBotToken", "BotFather token")}
      />
      {lastError.current && (
        <div
          role="alert"
          data-testid="telegram-connect-error"
          style={{ marginTop: 10, color: "var(--danger)", fontSize: 11, lineHeight: 1.5, overflowWrap: "anywhere" }}
        >
          {lastError.current}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 7, marginTop: 16 }}>
        <Button type="button" disabled={busy} size="lg" onClick={onClose}>
          {t("cancel", "Cancel")}
        </Button>
        <Button
          type="button"
          disabled={busy || !token.trim()}
          variant="primary"
          size="lg"
          onClick={() => onConnect(token.trim())}
        >
          {busy ? t("testingConnection", "Testing…") : t("saveAndConnect", "Save and connect")}
        </Button>
      </div>
    </Dialog>
  );
}

export function FeishuCredentialDialog({
  open,
  busy,
  error,
  onStartScan,
  onConnect,
  onClose,
  initialMode = "scan",
}: {
  open: boolean;
  busy: boolean;
  error: string;
  onStartScan: (domain: FeishuDomain) => void;
  onConnect: (appId: string, appSecret: string, domain: FeishuDomain) => void;
  onClose: () => void;
  initialMode?: "scan" | "manual";
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"scan" | "manual">(initialMode);
  const [domain, setDomain] = useState<FeishuDomain>("feishu");
  // Keep the last error visible while the shell plays its exit animation.
  const lastError = useRef(error);
  if (error) lastError.current = error;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel={t("connectFeishu", "Connect Feishu / Lark")}
      width={560}
      closeOnBackdrop={false}
      closeOnEscape={!busy}
      style={{
        padding: 22,
        background: "var(--bg)",
        boxShadow: "0 14px 45px rgba(0,0,0,.25)",
        maxHeight: "calc(100dvh - 40px)",
        overflowY: "auto",
      }}
    >
      <div data-testid="feishu-connect-dialog">
        <h3 style={{ margin: 0, color: "var(--text)", fontSize: 16 }}>{t("connectFeishu", "Connect Feishu / Lark")}</h3>
        <p style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
          {mode === "scan"
            ? t(
                "feishuScanDescription",
                "Scan to create a new bot with the official Feishu/Lark flow. Credentials stay in the Agent Host and are stored with OS encryption without entering the UI.",
              )
            : t(
                "feishuCredentialDescription",
                "Connect an existing self-built app through the official WebSocket long connection. App Secret is stored with OS encryption.",
              )}
        </p>

        <div
          role="tablist"
          aria-label={t("feishuConnectionMethod", "Connection method")}
          style={{ display: "flex", gap: 7 }}
        >
          <Button
            type="button"
            role="tab"
            aria-selected={mode === "scan"}
            data-testid="feishu-scan-tab"
            variant={mode === "scan" ? "primary" : "default"}
            size="lg"
            onClick={() => setMode("scan")}
          >
            {t("feishuScanCreate", "Scan to create (recommended)")}
          </Button>
          <Button
            type="button"
            role="tab"
            aria-selected={mode === "manual"}
            data-testid="feishu-manual-tab"
            variant={mode === "manual" ? "primary" : "default"}
            size="lg"
            onClick={() => setMode("manual")}
          >
            {t("feishuExistingApp", "Existing app")}
          </Button>
        </div>

        {mode === "scan" ? (
          <div data-testid="feishu-scan-create" style={{ marginTop: 14 }}>
            <label style={{ display: "grid", gap: 6, color: "var(--text-muted)", fontSize: 11 }}>
              {t("feishuTenantRegion", "Account region")}
              <Select
                autoFocus
                value={domain}
                onChange={(value) => setDomain(value as FeishuDomain)}
                options={[
                  { value: "feishu", label: t("feishuChina", "Feishu (China)") },
                  { value: "lark", label: "Lark" },
                ]}
              />
            </label>
            <div
              style={{
                marginTop: 12,
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg-panel)",
                padding: "11px 13px",
                color: "var(--text-muted)",
                fontSize: 11,
                lineHeight: 1.65,
              }}
            >
              <strong style={{ color: "var(--text)" }}>{t("feishuScanCreatesNew", "Creates a new bot")}</strong>
              <div>
                {t(
                  "feishuScanSecurityDefaults",
                  "The scanning user is the only allowed DM sender by default. Groups, commands, and Agent tools remain disabled until you enable them.",
                )}
              </div>
              <div style={{ marginTop: 6 }}>
                {t(
                  "feishuScanExistingHint",
                  "Already have an app? Use the Existing app tab instead; scanning never reads an existing App Secret.",
                )}
              </div>
            </div>
            <FeishuDialogError error={lastError.current} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 7, marginTop: 16 }}>
              <Button type="button" disabled={busy} size="lg" onClick={onClose}>
                {t("cancel", "Cancel")}
              </Button>
              <Button
                type="button"
                data-testid="start-feishu-scan"
                disabled={busy}
                variant="primary"
                size="lg"
                onClick={() => onStartScan(domain)}
              >
                {busy ? t("creatingQrCode", "Creating QR code…") : t("createQrCode", "Create QR code")}
              </Button>
            </div>
          </div>
        ) : (
          <FeishuManualForm
            busy={busy}
            error={error}
            domain={domain}
            setDomain={setDomain}
            onConnect={onConnect}
            onClose={onClose}
          />
        )}
      </div>
    </Dialog>
  );
}

function FeishuDialogError({ error }: { error: string }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      data-testid="feishu-connect-error"
      style={{ marginTop: 10, color: "var(--danger)", fontSize: 11, lineHeight: 1.5, overflowWrap: "anywhere" }}
    >
      {error}
    </div>
  );
}

function FeishuManualForm({
  busy,
  error,
  domain,
  setDomain,
  onConnect,
  onClose,
}: {
  busy: boolean;
  error: string;
  domain: FeishuDomain;
  setDomain: (domain: FeishuDomain) => void;
  onConnect: (appId: string, appSecret: string, domain: FeishuDomain) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [permissionCopyState, setPermissionCopyState] = useState<"idle" | "copied" | "error">("idle");
  // Keep the last error visible while the shell plays its exit animation.
  const lastError = useRef(error);
  if (error) lastError.current = error;
  const appIdInputRef = useRef<HTMLInputElement>(null);
  // The Dialog shell focuses its card on open; re-claim focus for the app id field.
  useEffect(() => appIdInputRef.current?.focus(), []);
  const docsBase = domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  const copyPermissionJson = async () => {
    try {
      await copyText(FEISHU_PERMISSION_IMPORT_JSON);
      setPermissionCopyState("copied");
    } catch {
      setPermissionCopyState("error");
    }
  };
  return (
    <div data-testid="feishu-existing-app" style={{ marginTop: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 150px", gap: 8 }}>
        <Input
          ref={appIdInputRef}
          autoComplete="off"
          value={appId}
          onChange={(event) => setAppId(event.target.value)}
          placeholder={t("feishuAppId", "App ID (cli_…)")}
        />
        <Select
          value={domain}
          onChange={(value) => setDomain(value as FeishuDomain)}
          options={[
            { value: "feishu", label: t("feishuChina", "Feishu (China)") },
            { value: "lark", label: "Lark" },
          ]}
        />
      </div>
      <SecretTextInput
        style={{ marginTop: 8 }}
        value={appSecret}
        onChange={setAppSecret}
        placeholder={t("feishuAppSecret", "App Secret")}
      />

      <div
        style={{
          marginTop: 14,
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-panel)",
          padding: "11px 13px",
          color: "var(--text-muted)",
          fontSize: 11,
          lineHeight: 1.6,
        }}
      >
        <div style={{ color: "var(--text)", fontWeight: 700 }}>{t("feishuSetupChecklist", "Quick setup")}</div>
        <ol style={{ margin: "7px 0 0", paddingLeft: 19 }}>
          <li>{t("feishuSetupBot", "Create an enterprise self-built app and enable Bot capability.")}</li>
          <li>
            {t(
              "feishuSetupPermissionImport",
              "Copy the permission JSON below, then paste it under Permissions & Scopes → Batch import/export scopes and apply for access.",
            )}
          </li>
          <li>
            {t(
              "feishuSetupConnection",
              "Under Events and Callbacks, select long connection mode and subscribe to im.message.receive_v1 and application.bot.menu_v6.",
            )}
          </li>
          <li>
            {t(
              "feishuSetupMenu",
              "Optional native menu: enable commands in this account's settings, then add event actions with keys pi_help, pi_status, pi_new, pi_compact, and pi_reload under Bot → Custom menu.",
            )}
          </li>
          <li>
            {t(
              "feishuSetupPublish",
              "Publish a new app version, configure availability, and add the bot to each allowed group.",
            )}
          </li>
        </ol>
        <pre
          data-testid="feishu-permission-json"
          style={{
            margin: "9px 0 0",
            maxHeight: 176,
            overflow: "auto",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            color: "var(--text-muted)",
            padding: "9px 10px",
            fontSize: 10,
            lineHeight: 1.45,
            whiteSpace: "pre",
            userSelect: "text",
          }}
        >
          {FEISHU_PERMISSION_IMPORT_JSON}
        </pre>
        {permissionCopyState === "error" && (
          <div role="alert" style={{ marginTop: 6, color: "var(--danger)" }}>
            {t("feishuPermissionCopyFailed", "Copy failed. Select and copy the JSON above manually.")}
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 9 }}>
          <Button
            type="button"
            data-testid="copy-feishu-permission-json"
            variant="primary"
            size="lg"
            onClick={() => void copyPermissionJson()}
          >
            {permissionCopyState === "copied"
              ? t("feishuPermissionJsonCopied", "Permission JSON copied")
              : t("copyFeishuPermissionJson", "Copy permission JSON")}
          </Button>
          <Button type="button" size="lg" onClick={() => void window.piBridge.openExternal(`${docsBase}/app`)}>
            {t("openDeveloperConsole", "Open developer console")}
          </Button>
        </div>
      </div>

      <FeishuDialogError error={lastError.current} />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 7, marginTop: 16 }}>
        <Button type="button" disabled={busy} size="lg" onClick={onClose}>
          {t("cancel", "Cancel")}
        </Button>
        <Button
          type="button"
          disabled={busy || !appId.trim() || !appSecret.trim()}
          variant="primary"
          size="lg"
          onClick={() => onConnect(appId.trim(), appSecret.trim(), domain)}
        >
          {busy ? t("testingConnection", "Testing…") : t("saveAndConnect", "Save and connect")}
        </Button>
      </div>
    </div>
  );
}

export function LoginDialog({
  open,
  event,
  code,
  setCode,
  onSubmitCode,
  onRetry,
  onClose,
}: {
  open: boolean;
  event: ChannelLoginEvent | null;
  code: string;
  setCode: (value: string) => void;
  onSubmitCode: () => void;
  onRetry?: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // The dialog stays mounted so the shared shell can play its exit animation;
  // freeze the last event so the card keeps its content (QR, phase message)
  // while shrinking out after the parent clears the login state.
  const lastEvent = useRef<ChannelLoginEvent | null>(event);
  if (event) lastEvent.current = event;
  const current = lastEvent.current;
  const terminal = current
    ? ["confirmed", "already_connected", "expired", "error", "cancelled"].includes(current.phase)
    : false;
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!current?.expiresAt || terminal) return;
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [current?.expiresAt, terminal]);
  const remainingSeconds = current?.expiresAt ? Math.max(0, Math.ceil((current.expiresAt - clock) / 1_000)) : undefined;
  const isFeishu = current?.channel === "feishu";
  const retryable =
    current?.phase === "expired" ||
    current?.phase === "cancelled" ||
    (current?.phase === "error" && !current.accountId);
  const codeInputRef = useRef<HTMLInputElement>(null);
  // The Dialog shell focuses its card on open; re-claim focus for the code field.
  useEffect(() => {
    if (open && current?.phase === "verification_required") codeInputRef.current?.focus();
  }, [open, current?.phase]);
  if (!current) return null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel={
        isFeishu ? t("feishuScanCreateTitle", "Scan to create Feishu / Lark bot") : t("connectWeixin", "Connect WeChat")
      }
      width={390}
      closeOnBackdrop={false}
      style={{ padding: 22, background: "var(--bg)", boxShadow: "0 14px 45px rgba(0,0,0,.25)" }}
    >
      <div data-testid={`channel-login-dialog-${current.channel}`} style={{ textAlign: "center" }}>
        <h3 style={{ margin: 0, color: "var(--text)", fontSize: 16 }}>
          {isFeishu
            ? t("feishuScanCreateTitle", "Scan to create Feishu / Lark bot")
            : t("connectWeixin", "Connect WeChat")}
        </h3>
        {current.qrContent && !terminal && (
          <div
            style={{
              width: 236,
              height: 236,
              padding: 10,
              background: "white",
              borderRadius: 8,
              margin: "18px auto 12px",
            }}
          >
            <QRCodeSVG
              value={current.qrContent ?? ""}
              size={216}
              level="M"
              marginSize={2}
              title={
                isFeishu
                  ? t("feishuCreateQrCode", "Feishu / Lark app creation QR code")
                  : t("weixinLoginQrCode", "WeChat login QR code")
              }
            />
          </div>
        )}
        {remainingSeconds !== undefined && !terminal && (
          <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 8 }}>
            {t("qrCodeExpiresIn", "QR code expires in")} {remainingSeconds}s
          </div>
        )}
        <p
          style={{
            color: current.phase === "error" ? "var(--danger)" : "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          {current.message}
        </p>
        {current.phase === "verification_required" && (
          <div style={{ display: "flex", gap: 7, marginTop: 12 }}>
            <Input
              ref={codeInputRef}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder={t("verificationNumber", "Verification number")}
            />
            <Button type="button" variant="primary" size="lg" onClick={onSubmitCode}>
              {t("submit", "Submit")}
            </Button>
          </div>
        )}
        {(current.phase === "waiting" || current.phase === "scanned") && (
          <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
            {isFeishu
              ? t("waitingForFeishuAuthorization", "Waiting securely for Feishu / Lark authorization…")
              : t("pollingSecurely", "Polling securely…")}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "center", gap: 7, marginTop: 16 }}>
          {retryable && onRetry && (
            <Button type="button" variant="primary" size="lg" onClick={onRetry}>
              {t("regenerateQrCode", "Generate a new QR code")}
            </Button>
          )}
          <Button type="button" size="lg" onClick={onClose}>
            {terminal ? t("close", "Close") : t("cancel", "Cancel")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 5, color: "var(--text-dim)", fontSize: 12 }}>
      <span>{label}</span>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        marginTop: 22,
        border: "1px solid var(--border)",
        borderRadius: 9,
        background: "var(--bg-panel)",
        padding: "13px 15px",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 5 }}>{title}</div>
      {children}
    </section>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <div style={{ color: "var(--text-dim)", fontSize: 11, padding: "9px 0" }}>{children}</div>;
}
