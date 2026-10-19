import { useEffect, useId, useState } from "react";
import { useI18n } from "@/i18n";
import { getWebSearchSettings, setWebSearchSettings, testWebSearchSettings } from "@/lib/api-client";
import type { WebSearchSnapshot } from "@shared/web-search";
import { SettingRow } from "./settings-controls";

const inputStyle = {
  minWidth: 220,
  minHeight: 36,
  padding: "7px 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
} as const;

const buttonStyle = {
  minHeight: 36,
  padding: "7px 14px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-panel)",
  color: "var(--text)",
  fontSize: 13,
  cursor: "pointer",
} as const;

const hintStyle = { margin: "8px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--text-dim)" } as const;

/**
 * Web search tools panel. The feature is off by default because every
 * successful provider call is billed; the panel owns its own load/save cycle.
 */
export function WebSearchSettings() {
  const { t } = useI18n();
  const controlId = useId();
  const keyControlId = useId();
  const [snapshot, setSnapshot] = useState<WebSearchSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<"load" | "save" | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [keyDraft, setKeyDraft] = useState("");

  useEffect(() => {
    let disposed = false;
    void getWebSearchSettings()
      .then((result) => {
        if (disposed) return;
        setSnapshot(result);
        setKeyDraft(result.settings.apiKeyOverride);
        setError(result.loadFailed ? "load" : null);
      })
      .catch(() => {
        if (!disposed) setError("load");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const save = async (patch: Parameters<typeof setWebSearchSettings>[0]): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const result = await setWebSearchSettings(patch);
      setSnapshot(result);
      if (patch.apiKeyOverride !== undefined) setKeyDraft(result.settings.apiKeyOverride);
    } catch {
      try {
        const reloaded = await getWebSearchSettings();
        setSnapshot(reloaded);
        setKeyDraft(reloaded.settings.apiKeyOverride);
      } catch {
        /* keep the last known snapshot */
      }
      setError("save");
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      // A dirty draft is validated as typed; otherwise the saved key is tested.
      const draft = keyDraft.trim() !== (snapshot?.settings.apiKeyOverride ?? "") ? keyDraft.trim() : undefined;
      const response = await testWebSearchSettings(draft);
      setTestResult({
        ok: response.ok,
        text: response.ok
          ? `${t("webSearchTestPassed", "Test passed")} · ${response.latencyMs ?? 0} ms · ${response.responseText ?? ""}` +
            (snapshot?.settings.enabled
              ? ""
              : ` ${t("webSearchTestDisabledHint", "Enable the switch above to let the Agent use it.")}`)
          : (response.error ?? t("webSearchTestFailed", "Test failed")),
      });
    } catch (cause) {
      setTestResult({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setTesting(false);
    }
  };

  const credential = snapshot?.credential.source;
  const busy = loading || saving;
  const keyDirty = snapshot !== null && keyDraft.trim() !== snapshot.settings.apiKeyOverride;

  return (
    <div style={{ width: "100%", overflowY: "auto", padding: "28px clamp(18px, 5vw, 52px)" }}>
      <section aria-labelledby={`${controlId}-heading`} style={{ maxWidth: 620 }}>
        <h2 id={`${controlId}-heading`} style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>
          {t("webSearch", "Web search")}
        </h2>
        <p style={{ ...hintStyle, margin: "6px 0 16px" }}>
          {t(
            "webSearchDescription",
            "Give the Agent web_search and web_fetch tools for current information. Search runs on DeepSeek; fetched page content is treated as untrusted data.",
          )}
        </p>
        <SettingRow label={t("webSearchEnable", "Enable web search tools")} controlId={controlId}>
          <label
            htmlFor={controlId}
            style={{ width: 36, height: 36, display: "grid", placeItems: "center", cursor: busy ? "wait" : "pointer" }}
          >
            <input
              id={controlId}
              type="checkbox"
              checked={snapshot?.settings.enabled === true}
              disabled={busy}
              onChange={(event) => void save({ enabled: event.target.checked })}
              style={{ width: 18, height: 18, margin: 0, accentColor: "var(--accent)" }}
            />
          </label>
        </SettingRow>
        <p style={hintStyle}>
          {t(
            "webSearchBilling",
            "Search and fetch are billed per successful request (DeepSeek charges per 1,000 calls); failed requests are not billed. Each call is recorded in the session execution history.",
          )}
        </p>
        <p style={hintStyle}>
          {t(
            "webSearchToolsHint",
            "After enabling, grant the tools per session by choosing Full access in the session tool menu. New sessions keep their own tool choice.",
          )}
        </p>
        <div style={{ height: 1, background: "var(--border)", margin: "20px 0" }} />
        <SettingRow label={t("webSearchApiKeyOverride", "Dedicated API key (optional)")} controlId={keyControlId}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              id={keyControlId}
              style={inputStyle}
              type="password"
              autoComplete="new-password"
              placeholder={t("webSearchApiKeyOverridePlaceholder", "Reuse the DeepSeek provider key")}
              value={keyDraft}
              disabled={busy || testing}
              onChange={(event) => setKeyDraft(event.target.value)}
            />
            <button
              type="button"
              style={{ ...buttonStyle, opacity: keyDirty && !busy ? 1 : 0.6 }}
              disabled={!keyDirty || busy}
              onClick={() => void save({ apiKeyOverride: keyDraft.trim() })}
            >
              {t("webSearchApiKeyOverrideSave", "Save key")}
            </button>
            <button
              type="button"
              style={{ ...buttonStyle, opacity: testing ? 0.65 : 1 }}
              disabled={busy || testing}
              onClick={() => void test()}
            >
              {testing ? t("webSearchTesting", "Testing…") : t("webSearchTest", "Test")}
            </button>
          </div>
        </SettingRow>
        <p style={hintStyle}>
          {credential === "override"
            ? t("webSearchCredentialOverride", "Using the dedicated key saved above.")
            : credential === "provider"
              ? t("webSearchCredentialProvider", "Using the DeepSeek API key from Settings → Models.")
              : t(
                  "webSearchCredentialNone",
                  "No key configured. Add a DeepSeek provider in Settings → Models, or save a dedicated key above.",
                )}
        </p>
        {testResult && (
          <p
            role="status"
            style={{
              ...hintStyle,
              color: testResult.ok ? "var(--text-muted)" : "var(--danger)",
              overflowWrap: "anywhere",
            }}
          >
            {testResult.ok ? "✓" : "!"} {testResult.text}
          </p>
        )}
        {error && (
          <p role="alert" style={{ ...hintStyle, color: "var(--danger)" }}>
            {error === "load"
              ? t("webSearchLoadFailed", "Web search settings could not be loaded.")
              : t("webSearchSaveFailed", "Web search settings could not be saved. The previous setting was restored.")}
          </p>
        )}
      </section>
    </div>
  );
}
