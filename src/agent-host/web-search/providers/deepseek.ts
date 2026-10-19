import { postToolJson, WebSearchError, type WebSearchRequestContext } from "../client.ts";
import type { WebSearchProvider, WebSearchResultItem } from "../types.ts";

const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
const MAX_QUERY_LENGTH = 128;
const MAX_URL_LENGTH = 8192;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | null | undefined {
  return typeof value === "string" ? value : value === null ? null : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Fail fast on obviously invalid URLs instead of spending a billable upstream round-trip. */
export function assertFetchableUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebSearchError("BAD_REQUEST", "web_fetch requires an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new WebSearchError("BAD_REQUEST", "web_fetch only supports http and https URLs");
  if (parsed.username || parsed.password)
    throw new WebSearchError("BAD_REQUEST", "web_fetch does not accept URLs with embedded credentials");
  if (url.length > MAX_URL_LENGTH) throw new WebSearchError("BAD_REQUEST", "The URL is too long to fetch");
  if (!parsed.hostname) throw new WebSearchError("BAD_REQUEST", "web_fetch requires a URL with a host");
}

function normalizeResult(value: unknown): WebSearchResultItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const url = text(record.url);
  if (!url) return undefined;
  return {
    title: text(record.title) || url,
    url,
    snippet: text(record.snippet),
    summary: text(record.summary),
    siteName: optionalText(record.site_name),
    date: optionalText(record.date),
    score: optionalNumber(record.rerank_score),
    authority: optionalNumber(record.authority),
  };
}

/** DeepSeek Search/Fetch: raw JSON APIs sharing the DeepSeek API bearer credential. */
export const deepseekProvider: WebSearchProvider = {
  id: "deepseek",
  label: "DeepSeek",

  async search({ query, count }, ctx: WebSearchRequestContext) {
    const trimmed = query.trim();
    if (!trimmed) throw new WebSearchError("BAD_REQUEST", "web_search requires a non-empty query");
    const data = await postToolJson<{ results?: unknown }>(
      SEARCH_URL,
      { query: trimmed.slice(0, MAX_QUERY_LENGTH), count },
      ctx,
    );
    if (!Array.isArray(data.results)) return [];
    return data.results.map(normalizeResult).filter((item): item is WebSearchResultItem => item !== undefined);
  },

  async fetch({ url }, ctx: WebSearchRequestContext) {
    assertFetchableUrl(url);
    const data = await postToolJson<{ title?: unknown; content?: unknown }>(FETCH_URL, { url }, ctx);
    return { title: text(data.title), content: text(data.content) };
  },
};
