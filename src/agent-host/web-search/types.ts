import type { WebSearchCredentialSource } from "../../shared/web-search.ts";

/** One normalized search result. `summary` is the long model-facing digest; `content` stays empty unless requested. */
export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  siteName?: string | null;
  date?: string | null;
  score?: number;
  authority?: number;
}

export interface WebSearchCallContext {
  apiKey: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface WebSearchProvider {
  readonly id: string;
  readonly label: string;
  /** Whether the provider implements page fetches; search-only providers declare false. */
  readonly supportsFetch: boolean;
  search(input: { query: string; count: number }, ctx: WebSearchCallContext): Promise<WebSearchResultItem[]>;
  fetch?(input: { url: string }, ctx: WebSearchCallContext): Promise<{ title: string; content: string }>;
}

/** Provider metadata for the settings UI; derived from the registry. */
export type WebSearchProviderList = readonly { id: string; label: string; supportsFetch: boolean }[];

export interface WebSearchAvailability {
  enabled: boolean;
  hasCredential: boolean;
  source: WebSearchCredentialSource;
  /** Names of the tools the active provider actually supports; web_fetch drops out for search-only providers. */
  toolNames: string[];
}
