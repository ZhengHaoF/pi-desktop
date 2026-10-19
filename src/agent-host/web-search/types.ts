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
  search(input: { query: string; count: number }, ctx: WebSearchCallContext): Promise<WebSearchResultItem[]>;
  fetch(input: { url: string }, ctx: WebSearchCallContext): Promise<{ title: string; content: string }>;
}

export interface WebSearchAvailability {
  enabled: boolean;
  hasCredential: boolean;
  source: WebSearchCredentialSource;
}
