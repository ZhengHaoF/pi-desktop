import { JsonObjectField } from "./JsonObjectField";
import { THINKING_LEVELS, type ThinkingLevel } from "@shared/thinking-levels";
import { useState, useEffect, useCallback, useRef } from "react";
import { Check, Field, NumInput, SecretTextInput, Select, SectionTitle, TextInput } from "../form-controls";
import { applyStrictOptionalPositiveInteger } from "@/lib/strict-integer";
import { useI18n } from "@/i18n";
import { type ModelEntry, type ProviderEntry } from "@/lib/models-config-state";
import { call } from "@/lib/api-client";
import type { ModelInfoFillResult } from "@contract/types";
import { ImportModelsPanel } from "./ImportModelsPanel";

/** Public database behind the "fill model info" action. */
const MODELS_DEV_URL = "https://models.dev";

type ModelFillState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; result: ModelInfoFillResult }
  | { phase: "error"; message: string };

type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number };

const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

export function ProviderDetail({
  name,
  provider,
  onChange,
  onRename,
  onDelete,
  onImportModels,
  onValidityChange,
}: {
  name: string;
  provider: ProviderEntry;
  onChange: (p: ProviderEntry) => void;
  onRename: (n: string) => void;
  onDelete: () => void;
  onImportModels: (models: ModelEntry[]) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const { t } = useI18n();
  const [editingName, setEditingName] = useState(name);
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => setEditingName(name), [name]);
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  useEffect(() => {
    if (!provider.api) onChange({ ...provider, api: "openai-completions" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial provider load intentionally runs once.
  }, [provider.api]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("modelProvider", "Provider")}</SectionTitle>
        <button
          type="button"
          onClick={onDelete}
          style={{
            minHeight: 32,
            padding: "0 10px",
            background: "none",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 4,
            color: "#ef4444",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          {t("delete", "Delete")}
        </button>
      </div>

      <Field label={t("modelProviderName", "Provider name")}>
        <TextInput value={editingName} onChange={setEditingName} placeholder="provider-name" mono />
        {editingName !== name && editingName.trim() && (
          <button
            type="button"
            onClick={() => onRename(editingName.trim())}
            style={{
              marginTop: 4,
              minHeight: 32,
              padding: "0 12px",
              background: "var(--accent)",
              border: "none",
              borderRadius: 4,
              color: "#fff",
              cursor: "pointer",
              fontSize: 12,
              alignSelf: "flex-start",
            }}
          >
            {t("rename", "Rename")}
          </button>
        )}
      </Field>

      <Field label={t("modelBaseUrl", "Base URL")}>
        <TextInput
          value={provider.baseUrl ?? ""}
          onChange={(v) => set("baseUrl", v || undefined)}
          placeholder="https://api.example.com/v1"
          mono
        />
      </Field>

      <Field label={t("modelApiKey", "API Key")}>
        <SecretTextInput
          value={provider.apiKey ?? ""}
          onChange={(v) => set("apiKey", v || undefined)}
          placeholder={t("modelApiKeySourcePlaceholder", "ENV_VAR_NAME, !shell-command, or literal key")}
          mono
        />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          {t("modelApiKeySourceHint", "Prefix with ! to run a shell command, or use an environment variable name.")}
        </span>
      </Field>

      <Field label={t("modelApi", "API")}>
        <Select
          value={provider.api ?? "openai-completions"}
          onChange={(v) => set("api", v)}
          options={API_OPTIONS}
          required
        />
      </Field>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button
          type="button"
          onClick={() => setImportOpen((open) => !open)}
          aria-expanded={importOpen}
          style={{
            display: "inline-flex",
            alignItems: "center",
            alignSelf: "flex-start",
            gap: 6,
            minHeight: 32,
            padding: "0 12px",
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: 5,
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {t("modelFetchModelList", "Fetch model list")}
        </button>
        {!importOpen && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.5 }}>
            {t(
              "modelFetchModelListHint",
              "Fetches the provider's available models using the Base URL and API Key above, then adds the ones you pick.",
            )}
          </span>
        )}
        {importOpen && (
          <ImportModelsPanel
            providerName={name}
            provider={provider}
            onImport={onImportModels}
            onClose={() => setImportOpen(false)}
          />
        )}
      </div>

      <ModelOverridesField
        value={provider.modelOverrides}
        onValidityChange={onValidityChange}
        onChange={(modelOverrides) => set("modelOverrides", modelOverrides)}
      />
    </div>
  );
}

export function ModelOverridesField(props: {
  value: ProviderEntry["modelOverrides"];
  onValidityChange?: (valid: boolean) => void;
  onChange: (value: ProviderEntry["modelOverrides"]) => void;
}) {
  const { t } = useI18n();
  return (
    <JsonObjectField
      {...props}
      label={t("modelProviderOverrides", "Chat model overrides by model ID (JSON)")}
      example={JSON.stringify({ "model-id": { samplingParams: { temperature: 0.2 } } }, null, 2)}
    />
  );
}

function thinkingLevelLabel(level: ThinkingLevel, t: (key: string, fallback: string) => string): string {
  switch (level) {
    case "off":
      return t("thinkingOff", "Off");
    case "minimal":
      return t("thinkingMinimal", "Minimal");
    case "low":
      return t("thinkingLow", "Low");
    case "medium":
      return t("thinkingMedium", "Medium");
    case "high":
      return t("thinkingHigh", "High");
    case "xhigh":
      return t("thinkingXHigh", "Extra high");
    case "max":
      return t("thinkingMax", "Maximum");
  }
}

function modelCostLabel(
  kind: "input" | "output" | "cacheRead" | "cacheWrite",
  t: (key: string, fallback: string) => string,
): string {
  switch (kind) {
    case "input":
      return t("modelCostInput", "input");
    case "output":
      return t("modelCostOutput", "output");
    case "cacheRead":
      return t("modelCostCacheRead", "cache read");
    case "cacheWrite":
      return t("modelCostCacheWrite", "cache write");
  }
}

const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  off: "var(--text-dim)",
  minimal: "#a19d92",
  low: "#d97706",
  medium: "#ea580c",
  high: "#c2410c",
  xhigh: "#9a3412",
  max: "#7c2d12",
};

function ThinkingLevelMapEditor({
  value,
  onChange,
}: {
  value: Record<string, string | null> | undefined;
  onChange: (v: Record<string, string | null> | undefined) => void;
}) {
  const { t } = useI18n();
  const map = value ?? {};

  const setLevel = (level: ThinkingLevel, entry: string | null | "omit") => {
    const next = { ...map };
    if (entry === "omit") {
      delete next[level];
    } else {
      next[level] = entry;
    }
    onChange(Object.keys(next).length ? next : undefined);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {THINKING_LEVELS.map((level) => {
        const raw = map[level];
        const state: "omit" | "null" | "string" = !(level in map) ? "omit" : raw === null ? "null" : "string";
        const strVal = typeof raw === "string" ? raw : "";
        const color = LEVEL_COLORS[level];

        const btnBase: React.CSSProperties = {
          minHeight: 32,
          padding: "0 10px",
          fontSize: 12,
          border: "none",
          cursor: "pointer",
          fontWeight: 400,
          transition: "background 0.1s, color 0.1s",
          whiteSpace: "nowrap",
          background: "var(--bg-panel)",
          color: "var(--text-dim)",
        };
        const btnActive: React.CSSProperties = {
          background: "var(--accent)",
          color: "#fff",
          fontWeight: 600,
        };
        const btnActiveDisabled: React.CSSProperties = {
          background: "#ef4444",
          color: "#fff",
          fontWeight: 600,
        };

        return (
          <div
            key={level}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 4px",
              borderRadius: 6,
              background: "transparent",
              border: "1px solid transparent",
            }}
          >
            {/* Level badge */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, width: 68, flexShrink: 0 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: color,
                  flexShrink: 0,
                  opacity: state === "null" ? 0.3 : 1,
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: state === "null" ? "var(--text-dim)" : "var(--text-muted)",
                  textDecoration: state === "null" ? "line-through" : "none",
                }}
              >
                {thinkingLevelLabel(level, t)}
              </span>
            </div>

            {/* Default + Disabled buttons */}
            <div
              style={{
                display: "flex",
                borderRadius: 5,
                border: "1px solid var(--border)",
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              <button
                onClick={() => setLevel(level, "omit")}
                style={{ ...btnBase, ...(state === "omit" ? btnActive : {}) }}
              >
                {t("modelDefault", "Default")}
              </button>
              <button
                onClick={() => setLevel(level, null)}
                style={{
                  ...btnBase,
                  borderLeft: "1px solid var(--border)",
                  ...(state === "null" ? btnActiveDisabled : {}),
                }}
              >
                {t("modelDisabled", "Disabled")}
              </button>
            </div>

            {/* Custom button + input fused */}
            <div
              style={{
                display: "flex",
                borderRadius: 5,
                border: `1px solid ${state === "string" ? "var(--accent)" : "var(--border)"}`,
                overflow: "hidden",
                transition: "border-color 0.1s",
              }}
            >
              <button
                onClick={() => setLevel(level, strVal || level)}
                style={{
                  ...btnBase,
                  ...(state === "string" ? btnActive : {}),
                  borderRight: "1px solid var(--border)",
                  flexShrink: 0,
                }}
              >
                {t("modelCustom", "Custom")}
              </button>
              <input
                value={strVal}
                onChange={(e) => setLevel(level, e.target.value)}
                onFocus={() => {
                  if (state !== "string") setLevel(level, strVal || level);
                }}
                placeholder={level}
                maxLength={10}
                style={{
                  width: "12ch",
                  background: state === "string" ? "var(--bg)" : "var(--bg-panel)",
                  border: "none",
                  outline: "none",
                  color: state === "string" ? "var(--text)" : "var(--text-dim)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  padding: "4px 7px",
                  transition: "background 0.1s, color 0.1s",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * DeepSeek reasoning-model compatibility profile, mirroring the core of Pi's
 * built-in deepseek provider entries (deepseek-flash / deepseek-v4-pro):
 * the thinking switch protocol, mandatory reasoning_content on replayed
 * assistant messages, the system (not developer) instruction role, and
 * DeepSeek's request shape. Pi only auto-detects these from a deepseek.com
 * base URL, so relays and custom endpoints need them applied explicitly.
 */
const DEEPSEEK_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
  supportsDeveloperRole: false,
  supportsStore: false,
  maxTokensField: "max_tokens",
  supportsStrictMode: true,
} as const;

function hasDeepseekCompat(model: ModelEntry): boolean {
  return model.compat?.thinkingFormat === "deepseek";
}

function setDeepseekCompat(model: ModelEntry, enabled: boolean): ModelEntry {
  if (enabled) {
    return { ...model, compat: { ...(model.compat ?? {}), ...DEEPSEEK_COMPAT } };
  }
  if (!model.compat) return model;
  const rest = { ...model.compat };
  for (const key of Object.keys(DEEPSEEK_COMPAT)) delete rest[key];
  return { ...model, compat: Object.keys(rest).length ? rest : undefined };
}

export function ModelDetail({
  providerName,
  provider,
  model,
  onChange,
  onDelete,
  isDefault = false,
  settingDefault = false,
  onSetDefault,
  defaultThinkingLevel = null,
  onDefaultThinkingLevelChange,
  onValidityChange,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  onChange: (m: ModelEntry) => void;
  onDelete: () => void;
  isDefault?: boolean;
  settingDefault?: boolean;
  onSetDefault?: () => void | Promise<void>;
  /** Persisted per-model default thinking level (Pi global settings), null when unset. */
  defaultThinkingLevel?: string | null;
  onDefaultThinkingLevelChange?: (level: string | null) => void | Promise<void>;
  onValidityChange?: (valid: boolean) => void;
}) {
  const { t } = useI18n();
  const [invalidFields, setInvalidFields] = useState<string[]>([]);
  const validField = (key: string, valid: boolean) => {
    const next = valid ? invalidFields.filter((field) => field !== key) : [...new Set([...invalidFields, key])];
    setInvalidFields(next);
    onValidityChange?.(next.length === 0);
  };
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const [fillState, setFillState] = useState<ModelFillState>({ phase: "idle" });
  const [defaultState, setDefaultState] = useState<{ phase: "idle" | "saving" | "error"; message?: string }>({
    phase: "idle",
  });
  const [thinkingLevelState, setThinkingLevelState] = useState<{
    phase: "idle" | "saving" | "error";
    message?: string;
  }>({ phase: "idle" });
  const fillSnapshot = useRef<ModelEntry | null>(null);
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v });
  const costVal = (k: keyof NonNullable<ModelEntry["cost"]>) =>
    model.cost?.[k] !== undefined ? String(model.cost[k]) : "";
  const setCost = (k: keyof NonNullable<ModelEntry["cost"]>, v: string) => {
    const n = parseFloat(v);
    // models.json requires all four cost keys whenever a cost object exists, so
    // editing one field materializes the complete object; a cleared field is 0.
    const previous = model.cost;
    const cost = {
      input: previous?.input ?? 0,
      output: previous?.output ?? 0,
      cacheRead: previous?.cacheRead ?? 0,
      cacheWrite: previous?.cacheWrite ?? 0,
      [k]: isNaN(n) ? 0 : n,
    };
    onChange({ ...model, cost });
  };
  const testSummary = (() => {
    if (testState.phase === "idle") return null;
    if (testState.phase === "testing") return t("modelTestingConnection", "Testing model connection…");
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
      return [t("modelConnectionConnected", "Connected"), ...meta, testState.responseText || null]
        .filter(Boolean)
        .join(" · ");
    }
    return [t("modelConnectionFailed", "Failed"), ...meta, testState.message].filter(Boolean).join(" · ");
  })();

  useEffect(() => {
    setTestState({ phase: "idle" });
    setFillState({ phase: "idle" });
    setDefaultState({ phase: "idle" });
    setThinkingLevelState({ phase: "idle" });
    fillSnapshot.current = null;
  }, [providerName, provider.baseUrl, provider.api, provider.apiKey, model.id, model.api]);

  const handleTest = useCallback(async () => {
    if (!model.id.trim() || testState.phase === "testing") return;
    setTestState({ phase: "testing" });
    try {
      const d = await call("modelsConfig.test", { providerName, provider, model });
      if (!d.ok) {
        setTestState({
          phase: "error",
          message: d.error ?? t("modelConnectionFailed", "Failed"),
          latencyMs: d.latencyMs,
          status: d.status,
        });
        return;
      }
      setTestState({
        phase: "success",
        latencyMs: d.latencyMs,
        status: d.status,
        responseText: d.responseText,
      });
    } catch (e) {
      setTestState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [model, provider, providerName, t, testState.phase]);

  const savingDefault = defaultState.phase === "saving" || settingDefault;
  const handleSetDefault = useCallback(async () => {
    if (!model.id.trim() || isDefault || savingDefault) return;
    setDefaultState({ phase: "saving" });
    try {
      await onSetDefault?.();
      setDefaultState({ phase: "idle" });
    } catch (e) {
      setDefaultState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [isDefault, model.id, onSetDefault, savingDefault]);

  const savingThinkingLevel = thinkingLevelState.phase === "saving";
  const handleThinkingLevelDefaultChange = useCallback(
    async (level: string | null) => {
      if (!model.id.trim() || savingThinkingLevel) return;
      setThinkingLevelState({ phase: "saving" });
      try {
        await onDefaultThinkingLevelChange?.(level);
        setThinkingLevelState({ phase: "idle" });
      } catch (e) {
        setThinkingLevelState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [model.id, onDefaultThinkingLevelChange, savingThinkingLevel],
  );

  const handleFillInfo = useCallback(async () => {
    if (!model.id.trim() || fillState.phase === "loading") return;
    setFillState({ phase: "loading" });
    try {
      const result = await call("modelsConfig.fillModelInfo", { modelId: model.id, providerName, provider, model });
      if (!result.ok) {
        setFillState({
          phase: "error",
          message: result.error ?? t("modelFillInfoFailed", "Failed to fetch model info."),
        });
        return;
      }
      const filled = result.filled ?? [];
      if (filled.length > 0 && result.fields) {
        fillSnapshot.current = model;
        onChange({ ...model, ...result.fields });
      }
      setFillState({ phase: "done", result });
    } catch (e) {
      setFillState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [fillState.phase, model, onChange, provider, providerName, t]);

  const handleUndoFill = useCallback(() => {
    if (fillSnapshot.current) onChange(fillSnapshot.current);
    fillSnapshot.current = null;
    setFillState({ phase: "idle" });
  }, [onChange]);

  const fillStatus = (() => {
    if (fillState.phase !== "done") return null;
    const result = fillState.result;
    const filledCount = result.filled?.length ?? 0;
    const source = result.source;
    const sourceLabel = source?.kind === "builtin" ? t("modelFillInfoSourceBuiltin", "Built-in catalog") : "models.dev";
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
          fontSize: 11,
          color: "var(--text-muted)",
        }}
      >
        <span>
          {filledCount > 0
            ? t("modelFillInfoFilledCount", "Filled {count} fields").replace("{count}", String(filledCount))
            : t("modelFillInfoUpToDate", "Model info already matches the source")}
        </span>
        {source?.priceProviderName && (
          <span>
            ·{" "}
            {t("modelFillInfoPriceFrom", "pricing matched by Base URL: {provider}").replace(
              "{provider}",
              source.priceProviderName,
            )}
          </span>
        )}
        {source && source.matchedBy === "global" && !source.priceProviderName && (
          <span>
            ·{" "}
            {t("modelFillInfoGlobalMatch", "matched by model ID: {provider}").replace(
              "{provider}",
              source.providerName,
            )}
          </span>
        )}
        <span style={{ color: "var(--text-dim)" }}>
          {t("modelFillInfoSourceLabel", "Source: {source}").replace("{source}", sourceLabel)}
          {result.stale ? ` ${t("modelFillInfoStaleCache", "(offline cache)")}` : ""}
        </span>
        {source?.kind === "models-dev" && (
          <button
            type="button"
            onClick={() => void window.piBridge?.openExternal(MODELS_DEV_URL)}
            title={t("modelFillInfoOpenSource", "Open models.dev")}
            aria-label={t("modelFillInfoOpenSource", "Open models.dev")}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              textDecoration: "underline",
            }}
          >
            ↗
          </button>
        )}
        {filledCount > 0 && fillSnapshot.current && (
          <button
            type="button"
            onClick={handleUndoFill}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              textDecoration: "underline",
            }}
          >
            {t("modelFillInfoUndo", "Undo")}
          </button>
        )}
      </div>
    );
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("model", "Model")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {testSummary && (
            <span
              title={testSummary}
              style={{
                maxWidth: 260,
                height: 24,
                padding: "0 8px",
                border: `1px solid ${testState.phase === "error" ? "var(--danger-border)" : testState.phase === "success" ? "var(--success-border)" : "var(--border)"}`,
                borderRadius: 4,
                background:
                  testState.phase === "error"
                    ? "var(--danger-soft)"
                    : testState.phase === "success"
                      ? "var(--success-soft)"
                      : "var(--bg-hover)",
                color:
                  testState.phase === "error"
                    ? "var(--danger)"
                    : testState.phase === "success"
                      ? "var(--success)"
                      : "var(--text-muted)",
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                boxSizing: "border-box",
              }}
            >
              {testSummary}
            </span>
          )}
          <button
            type="button"
            onClick={handleTest}
            disabled={!model.id.trim() || testState.phase === "testing"}
            title={t("modelTestConnection", "Test model connection")}
            style={{
              height: 32,
              padding: "0 10px",
              background: testState.phase === "success" ? "var(--success)" : "none",
              border: `1px solid ${testState.phase === "success" ? "var(--success)" : "var(--border)"}`,
              borderRadius: 4,
              color:
                testState.phase === "success"
                  ? "var(--on-accent)"
                  : !model.id.trim() || testState.phase === "testing"
                    ? "var(--text-dim)"
                    : "var(--text-muted)",
              cursor: !model.id.trim() || testState.phase === "testing" ? "not-allowed" : "pointer",
              fontSize: 12,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              boxSizing: "border-box",
              gap: 5,
            }}
          >
            {testState.phase === "success" && (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {testState.phase === "testing"
              ? t("testingConnection", "Testing…")
              : testState.phase === "success"
                ? "OK"
                : t("modelTest", "Test")}
          </button>
          {defaultState.phase === "error" && (
            <span
              title={defaultState.message}
              style={{
                maxWidth: 260,
                height: 24,
                padding: "0 8px",
                border: "1px solid var(--danger-border)",
                borderRadius: 4,
                background: "var(--danger-soft)",
                color: "var(--danger)",
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                boxSizing: "border-box",
              }}
            >
              {defaultState.message || t("modelSetDefaultFailed", "Failed to set the default model.")}
            </span>
          )}
          <button
            type="button"
            onClick={handleSetDefault}
            disabled={isDefault || !model.id.trim() || savingDefault}
            title={t("modelSetAsDefaultHint", "New conversations start with this model")}
            style={{
              height: 32,
              padding: "0 10px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: isDefault || !model.id.trim() || savingDefault ? "var(--text-dim)" : "var(--text-muted)",
              cursor: isDefault || !model.id.trim() || savingDefault ? "not-allowed" : "pointer",
              fontSize: 12,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              boxSizing: "border-box",
            }}
          >
            {savingDefault
              ? t("modelSetDefaultSaving", "Setting…")
              : isDefault
                ? t("modelCurrentDefault", "Default")
                : t("modelSetAsDefault", "Set as default")}
          </button>
          <button
            type="button"
            onClick={onDelete}
            style={{
              height: 32,
              padding: "0 10px",
              background: "none",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 4,
              color: "#ef4444",
              cursor: "pointer",
              fontSize: 12,
              boxSizing: "border-box",
            }}
          >
            {t("modelRemove", "Remove")}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label={t("modelId", "ID *")}>
          <TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono />
        </Field>
        <Field label={t("modelName", "Name")}>
          <TextInput
            value={model.name ?? ""}
            onChange={(v) => set("name", v || undefined)}
            placeholder={t("modelDisplayName", "Display name")}
          />
        </Field>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button
          type="button"
          onClick={() => void handleFillInfo()}
          disabled={!model.id.trim() || fillState.phase === "loading"}
          title={t(
            "modelFillInfoHint",
            "Fills context window, max output tokens, and pricing from the models.dev database.",
          )}
          style={{
            display: "inline-flex",
            alignItems: "center",
            alignSelf: "flex-start",
            gap: 6,
            minHeight: 30,
            padding: "0 12px",
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: !model.id.trim() || fillState.phase === "loading" ? "var(--text-dim)" : "var(--text-muted)",
            cursor: !model.id.trim() || fillState.phase === "loading" ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          {fillState.phase === "loading"
            ? t("modelFillInfoLoading", "Querying models.dev…")
            : t("modelFillInfo", "Fill model info")}
        </button>
        {fillStatus}
        {fillState.phase === "error" && (
          <span style={{ fontSize: 11, color: "#f87171", lineHeight: 1.5, overflowWrap: "anywhere" }}>
            {fillState.message}
          </span>
        )}
      </div>

      <Field label={t("modelApiOverride", "API override")}>
        <Select value={model.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
      </Field>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Check
          label={t("modelReasoning", "Reasoning / thinking")}
          checked={model.reasoning ?? false}
          onChange={(v) => set("reasoning", v || undefined)}
        />
        <Check
          label={t("modelImageInput", "Image input")}
          checked={model.input?.includes("image") ?? false}
          onChange={(v) => set("input", v ? ["text", "image"] : undefined)}
        />
      </div>

      {model.reasoning && (
        <>
          <div>
            <Check
              label={t("modelDeepSeekCompat", "DeepSeek compatibility")}
              checked={hasDeepseekCompat(model)}
              onChange={(v) => onChange(setDeepseekCompat(model, v))}
            />
            <div
              style={{
                fontSize: 11,
                lineHeight: 1.5,
                color: "var(--text-dim)",
                marginTop: 2,
                maxWidth: 520,
              }}
            >
              {t(
                "modelDeepSeekCompatHint",
                "Sends DeepSeek's request protocol: the thinking switch, the system (not developer) role, and reasoning_content on replayed assistant messages. Enable for DeepSeek models behind a relay or custom endpoint.",
              )}
            </div>
          </div>
          <div>
            <Field label={t("modelDefaultThinkingLevel", "Default thinking level")}>
              <Select
                value={defaultThinkingLevel ?? ""}
                onChange={(v) => void handleThinkingLevelDefaultChange(v || null)}
                options={THINKING_LEVELS}
                labels={Object.fromEntries(THINKING_LEVELS.map((level) => [level, thinkingLevelLabel(level, t)]))}
                emptyLabel={t("modelDefaultThinkingLevelAuto", "Auto (global default)")}
                disabled={!model.id.trim() || savingThinkingLevel}
              />
            </Field>
            <div
              style={{
                fontSize: 11,
                lineHeight: 1.5,
                color: "var(--text-dim)",
                marginTop: 2,
                maxWidth: 520,
              }}
            >
              {t(
                "modelDefaultThinkingLevelHint",
                "New conversations on this model resolve the composer's Auto level to this value, and switching to this model mid-session applies it too.",
              )}
            </div>
            {thinkingLevelState.phase === "error" && (
              <span style={{ fontSize: 11, color: "#f87171", lineHeight: 1.5, overflowWrap: "anywhere" }}>
                {thinkingLevelState.message ||
                  t("modelDefaultThinkingLevelFailed", "Failed to set the default thinking level.")}
              </span>
            )}
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <SectionTitle>{t("modelThinkingLevelMap", "Thinking level map")}</SectionTitle>
              {model.thinkingLevelMap && (
                <button
                  type="button"
                  onClick={() => set("thinkingLevelMap", undefined)}
                  style={{
                    minHeight: 32,
                    fontSize: 12,
                    padding: "0 9px",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    color: "var(--text-dim)",
                    cursor: "pointer",
                  }}
                >
                  {t("modelClearAll", "Clear all")}
                </button>
              )}
            </div>
            <ThinkingLevelMapEditor value={model.thinkingLevelMap} onChange={(v) => set("thinkingLevelMap", v)} />
          </div>
        </>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label={t("modelContextWindow", "Context window (tokens)")}>
          <NumInput
            value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
            onChange={(value) => set("contextWindow", applyStrictOptionalPositiveInteger(model.contextWindow, value))}
            placeholder="128000"
          />
        </Field>
        <Field label={t("modelMaxOutputTokens", "Max output tokens")}>
          <NumInput
            value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
            onChange={(value) => set("maxTokens", applyStrictOptionalPositiveInteger(model.maxTokens, value))}
            placeholder="16384"
          />
        </Field>
      </div>

      <div>
        <SectionTitle>{t("modelCostPerMillion", "Cost (per million tokens)")}</SectionTitle>
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
          {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
            <Field key={k} label={modelCostLabel(k, t)}>
              <NumInput value={costVal(k)} onChange={(v) => setCost(k, v)} placeholder="0" />
            </Field>
          ))}
        </div>
      </div>
      <SectionTitle>{t("modelAdvancedParameters", "Advanced model parameters")}</SectionTitle>
      <JsonObjectField
        label={t("modelSamplingParams", "Sampling parameters (JSON)")}
        example={JSON.stringify({ temperature: 0.2, top_p: 0.9 }, null, 2)}
        value={model.samplingParams}
        onValidityChange={(valid) => validField("samplingParams", valid)}
        onChange={(value) => set("samplingParams", value)}
      />
      <JsonObjectField
        label={t("modelSamplingByThinking", "Sampling parameters by thinking level (JSON)")}
        example={JSON.stringify({ high: { temperature: 0.2 }, low: { temperature: 0.7 } }, null, 2)}
        value={model.samplingParamsByThinkingLevel as Record<string, unknown> | undefined}
        onValidityChange={(valid) => validField("samplingParamsByThinkingLevel", valid)}
        onChange={(value) => set("samplingParamsByThinkingLevel", value)}
      />
      <JsonObjectField
        label={t("modelInputLimits", "Image and request input limits (JSON)")}
        example={JSON.stringify({ images: { resize: { maxWidth: 2000, maxHeight: 2000 } } }, null, 2)}
        value={model.inputLimits as Record<string, unknown> | undefined}
        onValidityChange={(valid) => validField("inputLimits", valid)}
        onChange={(value) => set("inputLimits", value)}
      />
    </div>
  );
}
