import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createDesktopModelRuntime } from "./model-credentials";
import type { DiscoveredModel, ModelDiscoveryResult } from "../contract/types.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

/** APIs whose catalogs cannot be listed through a model-list endpoint. */
const UNLISTABLE_APIS = new Set(["google-generative-ai"]);

const DEFAULT_PROVIDER_NAME = "__desktop_discovery__";
const DISCOVERY_MODEL_ID = "__desktop_model_discovery__";

function discoveryEndpoints(value: unknown): URL[] {
  if (typeof value !== "string" || !value.trim()) throw new Error("Base URL is required");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS Base URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Use an HTTP or HTTPS Base URL without credentials, query parameters, or a fragment");
  const base = url.pathname.replace(/\/+$/, "").replace(/\/models$/, "");
  url.pathname = `${base}/models`;
  return base ? [url] : [url, new URL("/v1/models", url)];
}

interface ComposedCredentials {
  baseUrl: string;
  headers: Record<string, string>;
  apiKey?: string;
}

/**
 * Composes the draft provider exactly like the runtime does, so `$ENV_VAR` and
 * `!shell-command` credentials resolve and stored credentials are visible. A
 * synthetic model replaces the draft rows: half-edited rows must not block
 * discovery, and provider headers resolve through model-scoped auth.
 */
async function composeCredentials(
  provider: Record<string, unknown>,
  providerName: string,
): Promise<ComposedCredentials> {
  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(path.join(tmpdir(), "pi-desktop-model-discover-"));
    const modelsPath = path.join(tempDir, "models.json");
    const providerConfig: Record<string, unknown> = { ...provider };
    providerConfig.models = [{ id: DISCOVERY_MODEL_ID }];
    delete providerConfig.modelOverrides;
    if (
      providerConfig.headers &&
      typeof providerConfig.headers === "object" &&
      !Array.isArray(providerConfig.headers)
    ) {
      // models.json rejects null header values; discovery treats them as absent.
      providerConfig.headers = Object.fromEntries(
        Object.entries(providerConfig.headers).filter(([, value]) => value !== null),
      );
    }
    if (typeof providerConfig.api !== "string" || !providerConfig.api.trim()) providerConfig.api = "openai-completions";
    writeFileSync(modelsPath, JSON.stringify({ providers: { [providerName]: providerConfig } }, null, 2), "utf8");
    const runtime = await createDesktopModelRuntime({ modelsPath, allowModelNetwork: false });
    const composed = runtime.getProvider(providerName);
    if (!composed) throw new Error(runtime.getError() ?? `Provider "${providerName}" failed to load.`);
    const headers = stringHeaders(composed.headers);
    let apiKey: string | undefined;
    try {
      // getAuth applies the same literal / $ENV_VAR / !shell-command resolution as real requests.
      // Passing the model (not the provider id) also merges the configured provider headers.
      const model = runtime.getModel(providerName, DISCOVERY_MODEL_ID);
      const auth = model ? await runtime.getAuth(model) : await runtime.getAuth(providerName);
      Object.assign(headers, auth?.auth?.headers ?? {});
      apiKey = auth?.auth?.apiKey;
    } catch {
      // Resolver errors can include shell commands or credential expressions.
      throw new Error("Could not resolve the API key or headers. Check the configured credential sources.");
    }
    return { baseUrl: composed.baseUrl?.trim() ?? "", headers, apiKey };
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function hasAuthHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => {
    const lower = key.toLowerCase();
    return lower === "authorization" || lower === "x-api-key" || lower === "x-goog-api-key";
  });
}

function stringHeaders(headers: Record<string, string | null | undefined> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) if (value != null) result[key] = value;
  return result;
}

/**
 * Resolves the draft provider's configured headers through the SDK's credential
 * expressions (`$ENV`, `${ENV}`, `!shell-command`) without touching stored
 * credentials; provider composition through models.json does not resolve them.
 */
async function resolveConfiguredCredentials(provider: Record<string, unknown>): Promise<{
  headers: Record<string, string>;
  apiKey?: string;
}> {
  const configuredHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    (provider.headers && typeof provider.headers === "object" ? provider.headers : {}) as Record<string, unknown>,
  )) {
    if (value !== null) configuredHeaders[key] = value as string;
  }
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw new Error("Discovery cannot write credentials");
      },
      delete: async () => {
        throw new Error("Discovery cannot delete credentials");
      },
    },
  });
  const id = "desktop-model-discovery";
  runtime.registerProvider(id, {
    api: "openai-completions",
    apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "",
    headers: configuredHeaders,
  });
  const result = await runtime.getAuth(id);
  return { headers: stringHeaders(result?.auth.headers), apiKey: result?.auth.apiKey };
}

async function discoveryHeaders(
  provider: Record<string, unknown>,
  providerName: string,
  api: string,
): Promise<{ headers: Headers; baseUrl: string }> {
  if (provider.headers !== undefined) {
    if (!provider.headers || typeof provider.headers !== "object" || Array.isArray(provider.headers))
      throw new Error("Provider headers must be an object");
    for (const value of Object.values(provider.headers)) {
      if (value === null) continue;
      if (typeof value !== "string") throw new Error("Provider header values must be strings");
    }
  }
  if (provider.apiKey !== undefined && typeof provider.apiKey !== "string") throw new Error("API key must be a string");
  const composed = await composeCredentials(provider, providerName);
  let configured: Awaited<ReturnType<typeof resolveConfiguredCredentials>>;
  try {
    configured = await resolveConfiguredCredentials(provider);
  } catch {
    // Resolver errors can include shell commands or credential expressions.
    throw new Error("Could not resolve the API key or headers. Check the configured credential sources.");
  }
  const headers = new Headers({ Accept: "application/json" });
  const merged = { ...stringHeaders(composed.headers), ...configured.headers };
  for (const [key, value] of Object.entries(merged)) if (value != null) headers.set(key, value);
  const apiKey = composed.apiKey ?? configured.apiKey;
  if (!hasAuthHeader(merged) && apiKey) {
    if (api === "anthropic-messages") {
      headers.set("x-api-key", apiKey);
      headers.set("anthropic-version", "2023-06-01");
    } else if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
  }
  return { headers, baseUrl: composed.baseUrl };
}

/**
 * Accepts the OpenAI `{ data: [...] }` shape, the Anthropic variant, and bare
 * arrays of ids. Entries without a usable id are skipped.
 */
function parseModelList(payload: unknown): DiscoveredModel[] | null {
  const entries = Array.isArray(payload) ? payload : (payload as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(entries)) return null;
  const models = new Map<string, DiscoveredModel>();
  for (const entry of entries) {
    if (typeof entry === "string") {
      const id = entry.trim();
      if (id && !models.has(id)) models.set(id, { id });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; name?: unknown; display_name?: unknown };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || models.has(id)) continue;
    const name =
      typeof record.display_name === "string" && record.display_name.trim()
        ? record.display_name.trim()
        : typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : undefined;
    models.set(id, name ? { id, name } : { id });
  }
  if (entries.length && !models.size) throw new Error("The models response contains no valid model IDs");
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function readModels(response: Response): Promise<DiscoveredModel[]> {
  if (!response.body) throw new Error("The models endpoint returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("The models response is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("The models endpoint did not return valid JSON");
  }
  const models = parseModelList(payload);
  if (!models) throw new Error('Expected a model list with a "data" array or a bare array of ids');
  return models;
}

/**
 * Discovers model IDs only: a /models listing does not establish reasoning,
 * context, or pricing capabilities.
 */
export async function discoverProviderModels(
  provider: Record<string, unknown>,
  options: { fetch?: typeof fetch; timeoutMs?: number; providerName?: string } = {},
): Promise<ModelDiscoveryResult> {
  try {
    if (!provider || typeof provider !== "object" || Array.isArray(provider))
      throw new Error("Provider configuration is required");
    const api = typeof provider.api === "string" && provider.api.trim() ? provider.api.trim() : "openai-completions";
    if (UNLISTABLE_APIS.has(api))
      return { ok: false, unsupported: true, error: `Listing models is not supported for API "${api}".` };
    const providerName =
      typeof options.providerName === "string" && options.providerName.trim()
        ? options.providerName.trim()
        : DEFAULT_PROVIDER_NAME;
    const credentials = await discoveryHeaders(provider, providerName, api);
    const source = credentials.baseUrl || provider.baseUrl;
    const endpoints = discoveryEndpoints(source);
    const headers = credentials.headers;
    const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    for (const [index, endpoint] of endpoints.entries()) {
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(endpoint, { headers, signal, redirect: "error" });
      } catch {
        return {
          ok: false,
          error: signal.aborted
            ? "Model discovery timed out. Check the server and retry."
            : "Could not connect to the models endpoint. Check the Base URL and network; redirects are not followed.",
        };
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404 && index + 1 < endpoints.length) continue;
        return {
          ok: false,
          status: response.status,
          error:
            response.status === 401 || response.status === 403
              ? `Model discovery authentication failed (HTTP ${response.status}). Check the API key and headers.`
              : `The models endpoint returned HTTP ${response.status}. Check the Base URL.`,
        };
      }
      try {
        const models = await readModels(response);
        const baseUrl = new URL(endpoint);
        baseUrl.pathname = baseUrl.pathname.replace(/\/models$/, "");
        return { ok: true, models, baseUrl: baseUrl.href.replace(/\/$/, "") };
      } catch (error) {
        // Some gateways serve their HTML app at unknown paths, including /models.
        if (!signal.aborted && index + 1 < endpoints.length) continue;
        return {
          ok: false,
          error: signal.aborted
            ? "Model discovery timed out. Check the server and retry."
            : error instanceof Error
              ? error.message
              : "Invalid models response",
        };
      }
    }
    return { ok: false, error: "No models endpoint was found" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Model discovery failed" };
  }
}
