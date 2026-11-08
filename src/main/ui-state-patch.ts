import { isAppLanguage } from "../shared/app-language.ts";
import type { DesktopUiStatePatch, RemoteControlConfig } from "../contract/desktop";
import { isChatAppearancePreferences } from "../shared/chat-appearance.ts";
import { isHerdrSettings } from "../contract/herdr.ts";
import { isSessionListMode } from "../shared/session-list-mode.ts";

const RENDERER_WRITABLE_UI_STATE_FIELDS = new Set([
  "language",
  "backgroundMode",
  "managedProcessesEnabled",
  "chatAppearance",
  "herdrSettings",
  "sessionListMode",
  "remoteControl",
]);

function isRemoteControlConfig(value: unknown): value is RemoteControlConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (typeof config.enabled !== "boolean") return false;
  if (typeof config.relayUrl !== "string") return false;
  const url = config.relayUrl;
  if (url.length === 0 || url.length > 2_048) return false;
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) return false;
  if (config.mode !== undefined && config.mode !== "lan" && config.mode !== "custom") {
    return false;
  }
  if (
    config.lanPort !== undefined &&
    (!Number.isInteger(config.lanPort) || (config.lanPort as number) < 1 || (config.lanPort as number) > 65_535)
  ) {
    return false;
  }
  if (config.name !== undefined && (typeof config.name !== "string" || config.name.length > 64)) return false;
  if (config.hostId !== undefined && (typeof config.hostId !== "string" || config.hostId.length > 64)) return false;
  return true;
}

export function validateDesktopUiStatePatch(value: unknown): DesktopUiStatePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid UI state patch");
  const patch = value as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !RENDERER_WRITABLE_UI_STATE_FIELDS.has(key))) {
    throw new Error("Unsupported UI state field");
  }

  const validated: DesktopUiStatePatch = {};
  if ("language" in patch) {
    if (!isAppLanguage(patch.language)) throw new Error("Invalid app language");
    validated.language = patch.language;
  }
  if ("backgroundMode" in patch) {
    if (typeof patch.backgroundMode !== "boolean") throw new Error("Background mode must be a boolean");
    validated.backgroundMode = patch.backgroundMode;
  }
  if ("managedProcessesEnabled" in patch) {
    if (typeof patch.managedProcessesEnabled !== "boolean") {
      throw new Error("Managed processes setting must be a boolean");
    }
    validated.managedProcessesEnabled = patch.managedProcessesEnabled;
  }
  if ("chatAppearance" in patch) {
    if (!isChatAppearancePreferences(patch.chatAppearance)) throw new Error("Invalid chat appearance preferences");
    validated.chatAppearance = patch.chatAppearance;
  }
  if ("herdrSettings" in patch) {
    if (!isHerdrSettings(patch.herdrSettings)) throw new Error("Invalid Herdr settings");
    validated.herdrSettings = patch.herdrSettings;
  }
  if ("sessionListMode" in patch) {
    if (!isSessionListMode(patch.sessionListMode)) throw new Error("Invalid session list mode");
    validated.sessionListMode = patch.sessionListMode;
  }
  if ("remoteControl" in patch) {
    if (!isRemoteControlConfig(patch.remoteControl)) throw new Error("Invalid remote control settings");
    validated.remoteControl = patch.remoteControl;
  }
  return validated;
}
