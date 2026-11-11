import { useI18n } from "@/i18n";
import { Select } from "@/components/ui/Select";
import { useCodingToolChoices } from "@/hooks/useCodingToolChoices";
import { getToolNamesForPreset } from "@shared/tool-presets";
import { isOrchestrationTool } from "@shared/orchestration-tools";

export function ChannelToolSelection({
  toolNames,
  cwd,
  onChange,
}: {
  toolNames: string[];
  cwd?: string;
  onChange: (names: string[]) => void;
}) {
  const { t } = useI18n();
  const codingTools = useCodingToolChoices(cwd);
  const presets = {
    none: [],
    read: ["read", "grep", "find", "ls"],
    full: getToolNamesForPreset("full", codingTools).filter((name) => !isOrchestrationTool(name)),
  };
  const key = [...toolNames].sort().join(",");
  const preset = Object.entries(presets).find(([, names]) => [...names].sort().join(",") === key)?.[0] ?? "custom";
  return (
    <>
      <Select
        aria-label={t("defaultTools", "Default tools")}
        value={preset}
        onChange={(value) => onChange([...presets[value as keyof typeof presets]])}
        options={[
          { value: "custom", label: t("permissionCustom", "Custom"), disabled: true },
          { value: "none", label: t("toolPresetNone", "No tools (recommended)") },
          { value: "read", label: t("toolPresetRead", "Read-only tools") },
          { value: "full", label: t("toolPresetFull", "Full coding tools") },
        ]}
      />
      <span style={{ color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5 }}>
        {t(
          "defaultToolsHint",
          "Used for new channel sessions and synchronized to sessions currently bound to this account when saved.",
        )}
      </span>
    </>
  );
}
