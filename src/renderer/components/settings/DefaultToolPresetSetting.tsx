import { useEffect, useId, useState } from "react";
import { call } from "@/lib/api-client";
import { useI18n } from "@/i18n";
import { SELECTABLE_TOOL_PRESETS, type SelectableToolPreset, type ToolPresetSettings } from "@shared/tool-presets";

export function DefaultToolPresetSetting() {
  const { t } = useI18n();
  const id = useId();
  const [settings, setSettings] = useState<ToolPresetSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"load" | "save" | null>(null);
  const labels: Record<SelectableToolPreset, string> = {
    none: t("permissionReadOnly", "Read only"),
    default: t("permissionStandard", "Standard"),
    full: t("permissionFull", "Full access"),
  };
  useEffect(() => {
    let active = true;
    void call("settings.getDefaultToolPreset").then(
      (value) => {
        if (active) setSettings(value);
      },
      () => {
        if (active) setError("load");
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const save = async (preset: SelectableToolPreset) => {
    setSaving(true);
    setError(null);
    try {
      setSettings(await call("settings.setDefaultToolPreset", { preset }));
    } catch {
      setError("save");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      aria-label={t("defaultToolPreset", "Default tool preset")}
      style={{ maxWidth: 620, paddingBottom: 28, marginBottom: 28, borderBottom: "1px solid var(--border)" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <label htmlFor={id} style={{ fontSize: 14, color: "var(--text)" }}>
          {t("defaultToolPreset", "Default tool preset")}
        </label>
        <select
          id={id}
          value={settings?.preset ?? ""}
          disabled={!settings || saving}
          onChange={(event) => void save(event.target.value as SelectableToolPreset)}
          style={{
            minWidth: 145,
            minHeight: 34,
            padding: "4px 8px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            color: "var(--text)",
            background: "var(--bg)",
          }}
        >
          {settings ? (
            SELECTABLE_TOOL_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {labels[preset]}
              </option>
            ))
          ) : (
            <option value="">{t("loading", "Loading…")}</option>
          )}
        </select>
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
        {t(
          "defaultToolPresetHint",
          "Used by new sessions. Existing sessions keep their saved tool selection, and channels keep their own presets.",
        )}
      </p>
      {error && (
        <p role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>
          {error === "load"
            ? t("defaultToolPresetLoadFailed", "The default tool preset could not be loaded.")
            : t("defaultToolPresetSaveFailed", "The default tool preset could not be saved.")}
        </p>
      )}
    </section>
  );
}
