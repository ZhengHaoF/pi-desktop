import { postToolJson, WebSearchError } from "../client.ts";
import type { WebSearchProvider, WebSearchResultItem } from "../types.ts";

const SEARCH_URL = "https://api.wsa.cloud.tencent.com/SearchPro";
/** Cnt is the only page-size knob the SearchPro API exposes; valid values are 10/20/30/40/50. */
const COUNT_STEPS = [10, 20, 30, 40, 50] as const;
const MAX_QUERY_LENGTH = 128;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Business errors arrive inside a 200 response; these codes map onto the stable error set. */
const ERROR_CODE_MESSAGES: Record<string, string> = {
  InternalError: "The Yuanbao search service hit an internal error. Try again later.",
  InvalidParameter: "The Yuanbao search service rejected the request parameters.",
  RequestLimitExceeded: "Yuanbao search rate limit exceeded. Slow down or check your plan's quota.",
  ResourceNotFound: "Yuanbao search is not activated for this account. Enable it in the Tencent Cloud console.",
  ResourceUnavailable: "The Yuanbao search account is unavailable. Check whether the account is in arrears.",
  UnauthorizedOperation: "The Yuanbao search API key was rejected. Check the key in Settings → Search.",
};

function throwUpstream(code: string): never {
  throw new WebSearchError(
    code === "UnauthorizedOperation"
      ? "UNAUTHORIZED"
      : code === "RequestLimitExceeded"
        ? "RATE_LIMITED"
        : code === "ResourceUnavailable" || code === "ResourceNotFound"
          ? "PAYMENT_REQUIRED"
          : code === "InvalidParameter"
            ? "BAD_REQUEST"
            : "UPSTREAM",
    ERROR_CODE_MESSAGES[code] ?? `The Yuanbao search service failed (${code})`,
  );
}

/** Parses the response envelope; business errors inside HTTP 200 throw like transport errors. */
function parseEnvelope(data: unknown): { pages?: unknown } {
  if (!data || typeof data !== "object")
    throw new WebSearchError("UPSTREAM", "The Yuanbao search response is unreadable");
  const response = (data as Record<string, unknown>).Response;
  if (!response || typeof response !== "object") {
    throw new WebSearchError("UPSTREAM", "The Yuanbao search response is unreadable");
  }
  const record = response as Record<string, unknown>;
  const error = record.Error;
  if (error && typeof error === "object") {
    const code = (error as Record<string, unknown>).Code;
    if (typeof code === "string" && code) throwUpstream(code);
  }
  return { pages: record.Pages };
}

/** Each Pages entry is a JSON-encoded string; malformed entries are skipped, not fatal. */
function normalizePage(value: unknown): WebSearchResultItem | undefined {
  let page: unknown;
  if (typeof value === "string") {
    try {
      page = JSON.parse(value);
    } catch {
      return undefined;
    }
  } else {
    page = value;
  }
  if (!page || typeof page !== "object") return undefined;
  const record = page as Record<string, unknown>;
  const url = text(record.url);
  if (!url) return undefined;
  return {
    title: text(record.title) || url,
    url,
    snippet: text(record.passage),
    summary: text(record.content) || text(record.passage),
    siteName: optionalText(record.site),
    date: optionalText(record.date),
    score: optionalNumber(record.score),
    authority: optionalNumber(record.authority_level),
  };
}

/** Tencent Yuanbao SearchPro: bearer-auth JSON API for search; it has no fetch endpoint. */
export const tencentWsaProvider: WebSearchProvider = {
  id: "tencent-wsa",
  label: "Yuanbao Search",
  supportsFetch: false,

  async search({ query, count }, ctx) {
    const trimmed = query.trim();
    if (!trimmed) throw new WebSearchError("BAD_REQUEST", "web_search requires a non-empty query");
    const cnt = COUNT_STEPS.find((step) => step >= count) ?? COUNT_STEPS[COUNT_STEPS.length - 1];
    const data = await postToolJson<{ Pages?: unknown }>(
      SEARCH_URL,
      { Query: trimmed.slice(0, MAX_QUERY_LENGTH), Cnt: cnt },
      ctx,
    );
    const { pages } = parseEnvelope(data);
    if (!Array.isArray(pages)) return [];
    return pages
      .slice(0, count)
      .map(normalizePage)
      .filter((item): item is WebSearchResultItem => item !== undefined);
  },
};
