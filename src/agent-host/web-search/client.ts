/** HTTP core for web search providers: retries, timeouts and stable error mapping. */

export type WebSearchErrorCode =
  | "NOT_CONFIGURED"
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "PAYMENT_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM"
  | "TIMEOUT"
  | "NETWORK"
  | "ABORTED"
  | "TOO_LARGE";

export class WebSearchError extends Error {
  readonly code: WebSearchErrorCode;
  readonly status?: number;
  /** Upstream Retry-After hint in milliseconds, when the provider sent one. */
  readonly retryAfterMs?: number;

  constructor(code: WebSearchErrorCode, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "WebSearchError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Only these statuses are worth another attempt; failed requests are not billed, so retries are free. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 5_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export interface WebSearchRequestContext {
  apiKey: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WebSearchError("ABORTED", "Operation aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new WebSearchError("ABORTED", "Operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reads the upstream Retry-After hint; absent or invalid headers fall back to exponential backoff. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number.parseFloat(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return undefined;
}

/** Maps an upstream failure to a stable, user-actionable error. */
export function mapUpstreamStatus(
  status: number,
  apiMessage: string | undefined,
  retryAfterMs?: number,
): WebSearchError {
  const detail = apiMessage?.trim();
  switch (status) {
    case 400:
      return new WebSearchError("BAD_REQUEST", detail || "The search provider rejected the request", status);
    case 401:
      return new WebSearchError(
        "UNAUTHORIZED",
        "The configured DeepSeek API key was rejected. Check the key in Settings → Search or Settings → Models.",
        status,
      );
    case 402:
      return new WebSearchError(
        "PAYMENT_REQUIRED",
        "The DeepSeek account balance is insufficient. Top up the account to keep using web search.",
        status,
      );
    case 403:
      return new WebSearchError("FORBIDDEN", detail || "The search provider refused this request", status);
    case 404:
      return new WebSearchError("NOT_FOUND", detail || "No readable content was found at this URL", status);
    case 408:
      return new WebSearchError(
        "UPSTREAM",
        detail || "The search provider timed out reading the request",
        status,
        retryAfterMs,
      );
    case 429:
      return new WebSearchError("RATE_LIMITED", detail || "Web search rate limited (HTTP 429)", status, retryAfterMs);
    default:
      return status >= 500
        ? new WebSearchError(
            "UPSTREAM",
            detail || `The search provider failed (HTTP ${String(status)})`,
            status,
            retryAfterMs,
          )
        : new WebSearchError(
            "BAD_REQUEST",
            detail || `The search provider rejected the request (HTTP ${String(status)})`,
            status,
          );
  }
}

async function readUpstreamError(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

async function once<T>(url: string, body: unknown, ctx: WebSearchRequestContext): Promise<T> {
  const signals: AbortSignal[] = [AbortSignal.timeout(ctx.timeoutMs)];
  if (ctx.signal) signals.push(ctx.signal);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (ctx.signal?.aborted) throw new WebSearchError("ABORTED", "Operation aborted");
    if (error instanceof Error && error.name === "TimeoutError")
      throw new WebSearchError("TIMEOUT", `The search provider did not respond within ${String(ctx.timeoutMs)}ms`);
    throw new WebSearchError("NETWORK", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw mapUpstreamStatus(response.status, await readUpstreamError(response), retryAfterMs(response));
  const text = await response.text();
  const bytes = Buffer.byteLength(text, "utf8");
  const maxBytes = ctx.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes > maxBytes)
    throw new WebSearchError("TOO_LARGE", `The search provider response exceeded ${String(maxBytes)} bytes`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new WebSearchError("UPSTREAM", "The search provider returned an unreadable response");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new WebSearchError("ABORTED", "Operation aborted");
}

/** POSTs JSON with bearer auth and retries only transient upstream failures. */
export async function postToolJson<T>(url: string, body: unknown, ctx: WebSearchRequestContext): Promise<T> {
  let lastError: WebSearchError | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    throwIfAborted(ctx.signal);
    try {
      return await once<T>(url, body, ctx);
    } catch (error) {
      if (!(error instanceof WebSearchError)) throw error;
      lastError = error;
      const retryable =
        error.code === "RATE_LIMITED" ||
        error.code === "UPSTREAM" ||
        error.code === "TIMEOUT" ||
        error.code === "NETWORK";
      const retryableStatus = error.status === undefined || RETRYABLE_STATUSES.has(error.status);
      if (!retryable || !retryableStatus || attempt === MAX_ATTEMPTS - 1) throw error;
      // Honor the upstream hint when present; otherwise exponential backoff capped at MAX_RETRY_AFTER_MS.
      await delay(error.retryAfterMs ?? Math.min(400 * 2 ** attempt, MAX_RETRY_AFTER_MS), ctx.signal);
    }
  }
  throw lastError ?? new WebSearchError("UPSTREAM", "The search provider request failed");
}
