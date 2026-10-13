import { useEffect, useId, useState } from "react";
import { useI18n } from "@/i18n";
import { getModelPreferences, setThinkingLevelDefault } from "@/lib/api-client";
import { SettingRow, selectStyle } from "./settings-controls";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function thinkingLevelLabel(level: string, t: (key: string, fallback: string) => string): string {
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
    default:
      return level;
  }
}

/**
 * Global default thinking level. The value lives in the Pi CLI settings file, so
 * this row owns its own load/save cycle instead of the renderer UI state.
 * Per-model defaults in the model editor win over this setting.
 */
export function DefaultThinkingLevelSettings() {
  const { t } = useI18n();
  const controlId = useId();
  const [level, setLevel] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"load" | "save" | null>(null);

  useEffect(() => {
    let disposed = false;
    void getModelPreferences()
      .then((preferences) => {
        if (disposed) return;
        setLevel(preferences.defaultThinkingLevel ?? "");
        setError(null);
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

  const save = async (next: string): Promise<void> => {
    const previous = level;
    setSaving(true);
    setError(null);
    try {
      const result = await setThinkingLevelDefault(undefined, next || null);
      setLevel(result.defaultThinkingLevel ?? "");
    } catch {
      setLevel(previous);
      setError("save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingRow label={t("defaultThinkingLevel", "Default thinking level")} controlId={controlId}>
        <select
          id={controlId}
          value={level}
          disabled={loading || saving || error === "load"}
          onChange={(event) => {
            void save(event.target.value);
          }}
          style={{ ...selectStyle, cursor: saving ? "wait" : "pointer" }}
        >
          <option value="">{t("defaultThinkingLevelUnset", "Built-in default (Medium)")}</option>
          {THINKING_LEVELS.map((value) => (
            <option key={value} value={value}>
              {thinkingLevelLabel(value, t)}
            </option>
          ))}
        </select>
      </SettingRow>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: "var(--text-dim)" }}>
        {t(
          "defaultThinkingLevelDescription",
          "Used by new conversations when the composer is set to Auto. Per-model defaults in the model editor override it. Shared with the Pi CLI.",
        )}
      </p>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: "var(--danger)" }}>
          {error === "load"
            ? t("defaultThinkingLevelLoadFailed", "The Pi default thinking level could not be read.")
            : t("defaultThinkingLevelSaveFailed", "The Pi default thinking level could not be saved.")}
        </p>
      )}
    </>
  );
}
