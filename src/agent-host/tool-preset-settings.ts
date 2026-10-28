import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_TOOL_PRESET,
  isSelectableToolPreset,
  type SelectableToolPreset,
  type ToolPresetSettings,
} from "../shared/tool-presets.ts";
import { desktopDataRoot } from "./desktop-data-root.ts";

/** Desktop-local default for new sessions; existing sessions keep their stored selection. */
export class ToolPresetPreferences {
  constructor(private readonly filePath: string) {}

  get(): ToolPresetSettings {
    try {
      const value = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (value?.version !== 1 || !isSelectableToolPreset(value.preset)) {
        throw new Error("Invalid default tool preset settings");
      }
      return { preset: value.preset };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { preset: DEFAULT_TOOL_PRESET };
    }
  }

  set(preset: SelectableToolPreset): ToolPresetSettings {
    if (!isSelectableToolPreset(preset)) throw new Error("Invalid default tool preset selection");
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({ version: 1, preset }) + "\n", { mode: 0o600 });
    try {
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        /* ignore cleanup failure */
      }
      throw error;
    }
    return this.get();
  }
}

export function toolPresetPreferences(): ToolPresetPreferences {
  return new ToolPresetPreferences(path.join(desktopDataRoot(), "default-tool-preset.json"));
}
