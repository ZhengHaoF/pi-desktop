/** Wire types for the desktop web search feature. Shared so the contract, Host and Renderer agree. */

export const WEB_SEARCH_TOOL_NAMES = ["web_search", "web_fetch"] as const;

export type WebSearchToolName = (typeof WEB_SEARCH_TOOL_NAMES)[number];

export function isWebSearchToolName(name: string): name is WebSearchToolName {
  return (WEB_SEARCH_TOOL_NAMES as readonly string[]).includes(name);
}

/** Where a resolved API key came from. */
export type WebSearchCredentialSource = "override" | "provider" | "none";

export interface WebSearchSettings {
  /** Global feature gate. Off by default; every call is billed per successful request. */
  enabled: boolean;
  /** Registered provider id ("deepseek", "tencent-wsa"). */
  providerId: string;
  /** Dedicated keys per provider; empty entries reuse the provider credential from ~/.pi/agent/auth.json. */
  apiKeys: Record<string, string>;
  /** Default result count for web_search when the model does not pass one. */
  maxResults: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

export interface WebSearchProviderInfo {
  id: string;
  label: string;
  /** Whether the provider implements web_fetch; only then does the tool become available. */
  supportsFetch: boolean;
}

export interface WebSearchSnapshot {
  settings: WebSearchSettings;
  credential: { source: WebSearchCredentialSource; providerId: string };
  providers: WebSearchProviderInfo[];
  loadFailed: boolean;
}

export const WEB_SEARCH_DEFAULTS: WebSearchSettings = {
  enabled: false,
  providerId: "deepseek",
  apiKeys: {},
  maxResults: 5,
  timeoutMs: 20_000,
};

/** Moves the pre-multi-provider `apiKeyOverride` onto the active provider's key slot. */
function migrateLegacyKey(record: Record<string, unknown>): Record<string, unknown> {
  const override = typeof record.apiKeyOverride === "string" ? record.apiKeyOverride.trim() : "";
  if (!override || record.apiKeys !== undefined) return record;
  const providerId =
    typeof record.providerId === "string" && record.providerId.trim()
      ? record.providerId.trim()
      : WEB_SEARCH_DEFAULTS.providerId;
  return { ...record, apiKeys: { [providerId]: override } };
}

export const WEB_SEARCH_LIMITS = {
  maxResults: { min: 1, max: 10 },
  timeoutMs: { min: 5_000, max: 60_000 },
  apiKeyOverrideMaxLength: 512,
  maxQueryLength: 128,
  maxUrlLength: 8192,
} as const;

/** Clamp and coerce persisted or inbound values; unknown fields are dropped. */
export function normalizeWebSearchSettings(value: unknown): WebSearchSettings {
  const record = migrateLegacyKey((value ?? {}) as Record<string, unknown>);
  const clamp = (input: unknown, fallback: number, min: number, max: number): number => {
    const numeric = typeof input === "number" && Number.isFinite(input) ? Math.floor(input) : fallback;
    return Math.min(max, Math.max(min, numeric));
  };
  const keys: Record<string, string> = {};
  if (record.apiKeys && typeof record.apiKeys === "object") {
    for (const [id, key] of Object.entries(record.apiKeys as Record<string, unknown>)) {
      if (typeof key === "string" && key.trim())
        keys[id.trim().slice(0, 64)] = key.trim().slice(0, WEB_SEARCH_LIMITS.apiKeyOverrideMaxLength);
    }
  }
  return {
    enabled: record.enabled === true,
    providerId:
      typeof record.providerId === "string" && record.providerId.trim()
        ? record.providerId.trim()
        : WEB_SEARCH_DEFAULTS.providerId,
    apiKeys: keys,
    maxResults: clamp(
      record.maxResults,
      WEB_SEARCH_DEFAULTS.maxResults,
      WEB_SEARCH_LIMITS.maxResults.min,
      WEB_SEARCH_LIMITS.maxResults.max,
    ),
    timeoutMs: clamp(
      record.timeoutMs,
      WEB_SEARCH_DEFAULTS.timeoutMs,
      WEB_SEARCH_LIMITS.timeoutMs.min,
      WEB_SEARCH_LIMITS.timeoutMs.max,
    ),
  };
}
