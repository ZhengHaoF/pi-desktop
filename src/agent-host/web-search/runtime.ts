import { WEB_SEARCH_TOOL_NAMES, type WebSearchCredentialSource } from "../../shared/web-search.ts";
import { deepseekProvider } from "./providers/deepseek.ts";
import {
  probeWebSearchCredential,
  readProviderApiKey,
  resolveWebSearchApiKey,
  type ProviderKeyReader,
} from "./credentials.ts";
import { WebSearchError } from "./client.ts";
import { webSearchSettings, type WebSearchSettingsStore } from "./settings.ts";
import type { WebSearchAvailability, WebSearchProvider } from "./types.ts";

export interface WebSearchRuntimeOptions {
  store?: WebSearchSettingsStore;
  providers?: readonly WebSearchProvider[];
  readProviderKey?: ProviderKeyReader;
}

/** Credential and settings changes outside this module converge within this window. */
const AVAILABILITY_TTL_MS = 30_000;

/**
 * Owns the provider registry and the cached availability snapshot. Availability
 * is synchronous for the tool policy; the underlying credential probe is async
 * and refreshed on startup, on settings changes, and lazily while stale.
 */
export class WebSearchRuntime {
  private readonly store: WebSearchSettingsStore;
  private readonly providers: Map<string, WebSearchProvider>;
  private readonly readProviderKey: ProviderKeyReader;
  private availability: WebSearchAvailability = { enabled: false, hasCredential: false, source: "none" };
  private refreshing: Promise<void> = Promise.resolve();
  private refreshedAt = 0;

  constructor(options: WebSearchRuntimeOptions = {}) {
    this.store = options.store ?? webSearchSettings;
    this.providers = new Map((options.providers ?? [deepseekProvider]).map((provider) => [provider.id, provider]));
    this.readProviderKey = options.readProviderKey ?? readProviderApiKey;
  }

  getProvider(id: string): WebSearchProvider | undefined {
    return this.providers.get(id);
  }

  getSettings() {
    return this.store.get();
  }

  getAvailability(): WebSearchAvailability {
    // A stale snapshot self-heals in the background; execute always resolves keys fresh.
    if (Date.now() - this.refreshedAt >= AVAILABILITY_TTL_MS) void this.refresh();
    return this.availability;
  }

  /** Resolves the effective key: explicit override first, then the provider credential. */
  resolveApiKey(settings = this.store.get()) {
    return resolveWebSearchApiKey(settings, this.readProviderKey);
  }

  /** Reloads persisted settings and re-probes the credential; never rejects. */
  async refresh(): Promise<void> {
    const operation = this.refreshing
      .then(async () => {
        const settings = this.store.get();
        const source: WebSearchCredentialSource = settings.enabled
          ? await probeWebSearchCredential(settings, this.readProviderKey)
          : "none";
        this.availability = { enabled: settings.enabled, hasCredential: source !== "none", source };
        this.refreshedAt = Date.now();
      })
      .catch(() => undefined);
    this.refreshing = operation;
    await operation;
  }
}

let runtime: WebSearchRuntime | undefined;

export function initializeWebSearchRuntime(): WebSearchRuntime {
  runtime ??= new WebSearchRuntime();
  void runtime.refresh();
  return runtime;
}
export function peekWebSearchRuntime(): WebSearchRuntime | undefined {
  return runtime;
}

export function getWebSearchRuntime(): WebSearchRuntime {
  if (!runtime) throw new WebSearchError("NOT_CONFIGURED", "The web search runtime is not initialized yet");
  return runtime;
}

/** Tool names the model may see right now; empty while the feature is off or unconfigured. */
export function webSearchToolNamesForAvailability(availability: WebSearchAvailability | undefined): string[] {
  return availability && availability.enabled && availability.hasCredential ? [...WEB_SEARCH_TOOL_NAMES] : [];
}
