import type { WebSearchCredentialSource, WebSearchSettings } from "../../shared/web-search.ts";
import { getSharedModelRuntime } from "../model-runtime.ts";
import { WebSearchError } from "./client.ts";

/** Reads the resolved api-key auth for a provider; injectable for tests. */
export type ProviderKeyReader = (providerId: string) => Promise<string | undefined>;

/** Key resolution order: explicit override, then the provider credential (the same pattern MCP server configs use). */
export async function resolveWebSearchApiKey(
  settings: WebSearchSettings,
  readKey: ProviderKeyReader = readProviderApiKey,
): Promise<{ apiKey: string; source: "override" | "provider" }> {
  const override = settings.apiKeyOverride.trim();
  if (override) return { apiKey: override, source: "override" };
  const providerKey = await readKey(settings.providerId);
  const trimmed = providerKey?.trim();
  if (trimmed) return { apiKey: trimmed, source: "provider" };
  throw new WebSearchError(
    "NOT_CONFIGURED",
    `No DeepSeek API key is configured for web search. Add a DeepSeek provider key in Settings → Models, or set a dedicated key in Settings → Search.`,
  );
}

/** Reads the resolved api-key auth for a provider; never throws. */
export async function readProviderApiKey(providerId: string): Promise<string | undefined> {
  try {
    const runtime = await getSharedModelRuntime();
    const resolution = await runtime.getAuth(providerId);
    const apiKey = resolution?.auth?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  } catch {
    /* an unreadable credential store means "not configured" for this feature */
  }
  return undefined;
}

export async function probeWebSearchCredential(
  settings: WebSearchSettings,
  readKey: ProviderKeyReader = readProviderApiKey,
): Promise<WebSearchCredentialSource> {
  if (settings.apiKeyOverride.trim()) return "override";
  return (await readKey(settings.providerId)) ? "provider" : "none";
}
