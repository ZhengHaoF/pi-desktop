import { validateModelEditorConfig } from "../model-editor-validation";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createDesktopModelRuntime } from "../model-credentials";
import { probeChatModel } from "../model-chat-probe";
import type { ApiHandler } from "../../contract/rpc";
import { RpcError, type ProviderModelInfo } from "../../contract/types";
import { reloadSharedModelRuntimeConfig, getSharedModelRuntime } from "../model-runtime";
import {
  buildModelInfoFill,
  loadModelsDevCatalog,
  matchBuiltinModelFacts,
  matchModelFacts,
  type CatalogLoadResult,
} from "../models-dev-catalog";
import { ensureAzureUpgrade } from "../azure-upgrade";
import { withLockedJsonFile } from "../../shared/node/locked-json-file";
import { inspectModelsConfig, parseModelsConfig } from "../models-config-validation";

function getModelsPath(): string {
  return path.join(getAgentDir(), "models.json");
}

type ModelsFileSnapshot = { raw: string | null; version: string };

function modelsContentVersion(raw: string | null): string {
  return raw === null ? "missing" : `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

function readModelsFileSnapshot(): ModelsFileSnapshot {
  const p = getModelsPath();
  if (!existsSync(p)) return { raw: null, version: modelsContentVersion(null) };
  const raw = readFileSync(p, "utf8");
  return { raw, version: modelsContentVersion(raw) };
}

function readModelsJsonSnapshot(): { config: Record<string, unknown>; version: string } {
  const snapshot = readModelsFileSnapshot();
  if (snapshot.raw === null) return { config: { providers: {} }, version: snapshot.version };
  try {
    return { config: parseModelsConfig(snapshot.raw), version: snapshot.version };
  } catch (e) {
    // ISSUE-009: never silently return empty and allow overwrite of corrupt file
    throw new RpcError({
      code: "PARSE_ERROR",
      message: e instanceof Error ? e.message : "models.json contains invalid JSON",
    });
  }
}

function modelsConfigConflict(expectedVersion: string, currentVersion: string): RpcError {
  return new RpcError({
    code: "CONFLICT",
    message: "models.json changed outside this editor; current edits were not saved",
    detail: { expectedVersion, currentVersion },
  });
}

/**
 * Loads the payload through the SDK exactly like the runtime does. The SDK drops
 * the whole file when a single entry is invalid, so a config it would reject must
 * never reach the disk. Only the user's own providers are checked, so unrelated
 * built-in catalog noise cannot block a save.
 */
async function validateModelsConfig(config: Record<string, unknown>): Promise<string | undefined> {
  const providerIds = Object.keys((config.providers ?? {}) as Record<string, unknown>);
  if (providerIds.length === 0) return undefined;
  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(path.join(tmpdir(), "pi-desktop-model-validate-"));
    const modelsPath = path.join(tempDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify(config, null, 2), "utf8");
    const modelRuntime = await createDesktopModelRuntime({ modelsPath, allowModelNetwork: false });
    const rejected = providerIds.filter((providerId) => !modelRuntime.getProvider(providerId));
    if (rejected.length === 0) return undefined;
    const detail = modelRuntime.getError() ?? "";
    const reason = detail
      .split("\n")
      .filter((line) => !line.startsWith("File:"))
      .join("\n")
      .trim();
    return `models.json would be rejected by the model runtime (providers: ${rejected.join(", ")})${reason ? `:\n${reason}` : "."}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
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

async function writeModelsJson(data: Record<string, unknown>, expectedVersion: string): Promise<string> {
  const p = getModelsPath();
  return withLockedJsonFile(
    p,
    async () => {
      mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      const initial = readModelsFileSnapshot();
      if (initial.version !== expectedVersion) throw modelsConfigConflict(expectedVersion, initial.version);
      // ISSUE-009: atomic write via temp + rename; keep .bak of previous good file
      const tmp = `${p}.${process.pid}.tmp`;
      const bak = `${p}.bak`;
      const serialized = JSON.stringify(data, null, 2);
      writeFileSync(tmp, serialized, { encoding: "utf8", mode: 0o600 });
      try {
        const beforeCommit = readModelsFileSnapshot();
        if (beforeCommit.version !== expectedVersion) throw modelsConfigConflict(expectedVersion, beforeCommit.version);
        if (beforeCommit.raw !== null) {
          try {
            writeFileSync(bak, beforeCommit.raw, { encoding: "utf8", mode: 0o600 });
            if (process.platform !== "win32") chmodSync(bak, 0o600);
          } catch {
            /* ignore bak failure */
          }
        }
        renameSync(tmp, p);
      } catch (e) {
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw e;
      }
      return modelsContentVersion(serialized);
    },
    undefined,
    { parse: parseModelsConfig },
  );
}

type ModelConfigHandlers = {
  get: NonNullable<ApiHandler["modelsConfig.get"]>;
  set: NonNullable<ApiHandler["modelsConfig.set"]>;
  test: NonNullable<ApiHandler["modelsConfig.test"]>;
  listModels: NonNullable<ApiHandler["modelsConfig.listModels"]>;
  fillModelInfo: NonNullable<ApiHandler["modelsConfig.fillModelInfo"]>;
};

/** Collapses concurrent "fill model info" clicks into one catalog download. */
let catalogLoadInFlight: Promise<CatalogLoadResult> | undefined;

async function loadCatalogOnce(): Promise<CatalogLoadResult> {
  if (!catalogLoadInFlight) {
    catalogLoadInFlight = loadModelsDevCatalog().finally(() => {
      catalogLoadInFlight = undefined;
    });
  }
  return catalogLoadInFlight;
}

const LIST_MODELS_TIMEOUT_MS = 20_000;
const LIST_MODELS_ERROR_BODY_MAX_CHARS = 200;

/** APIs whose catalogs cannot be listed through an OpenAI-style /models endpoint. */
const UNLISTABLE_MODEL_APIS = new Set(["google-generative-ai"]);

/**
 * Endpoint candidates for a provider base URL, most specific first. Gateways
 * disagree on whether the version segment is part of the configured base URL,
 * so a 404 on the first candidate retries with an explicit /v1 prefix.
 */
function modelListEndpointCandidates(baseUrl: string): string[] {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return [];
  const candidates = [`${trimmed}/models`];
  const versioned = `${trimmed}/v1/models`;
  if (!candidates.includes(versioned)) candidates.push(versioned);
  return candidates;
}

/** Accepts the OpenAI `{ data: [...] }` shape, the Anthropic variant, and bare arrays. */
function parseProviderModelList(payload: unknown): ProviderModelInfo[] | null {
  const entries = Array.isArray(payload) ? payload : (payload as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(entries)) return null;
  const models: ProviderModelInfo[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      const id = entry.trim();
      if (id) models.push({ id });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; name?: unknown; display_name?: unknown };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) continue;
    const displayName =
      typeof record.display_name === "string"
        ? record.display_name.trim()
        : typeof record.name === "string"
          ? record.name.trim()
          : "";
    models.push(displayName ? { id, name: displayName } : { id });
  }
  return models;
}

function parseJsonPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Provider error bodies can echo request details; keep them short and never include the key. */
function describeListModelsFailure(status: number | undefined, body: string): string {
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, LIST_MODELS_ERROR_BODY_MAX_CHARS);
  return snippet ? `HTTP ${status ?? "?"}: ${snippet}` : `HTTP ${status ?? "?"}`;
}

export const modelConfigHandlers = {
  get: async () => {
    // Inspect before migrations. An invalid SDK configuration must remain editable and byte-for-byte intact.
    const original = readModelsJsonSnapshot();
    const issues = inspectModelsConfig(original.config);
    if (issues.length) return { ...original, issues };
    const azureUpgrade = await ensureAzureUpgrade();
    const snapshot = readModelsJsonSnapshot();
    const currentIssues = inspectModelsConfig(snapshot.config);
    return { ...snapshot, azureUpgrade, ...(currentIssues.length ? { issues: currentIssues } : {}) };
  },

  set: async (params) => {
    const body = params as { config?: unknown; expectedVersion?: unknown };
    const config = body?.config as Record<string, unknown> | undefined;
    // ISSUE-009: refuse to persist empty overwrite without explicit providers key from a real load
    if (!config || typeof config !== "object" || !("providers" in config)) {
      throw new RpcError({ code: "BAD_REQUEST", message: "Invalid models config payload" });
    }
    if (typeof body.expectedVersion !== "string" || !body.expectedVersion) {
      throw new RpcError({ code: "BAD_REQUEST", message: "expectedVersion is required" });
    }
    validateModelEditorConfig(config);
    // Editor removals use undefined; validate exactly the JSON that will be persisted, not those sentinels.
    const persisted = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
    const issues = inspectModelsConfig(persisted);
    if (issues.length)
      throw new RpcError({
        code: "BAD_REQUEST",
        message: `Invalid model configuration; no changes were saved: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
        detail: { issues },
      });
    // Schema-valid entries can still make the SDK drop every provider, so load the
    // payload through the runtime exactly like a restart would before persisting it.
    const validationError = await validateModelsConfig(persisted);
    if (validationError) {
      throw new RpcError({ code: "BAD_REQUEST", message: validationError });
    }
    const version = await writeModelsJson(persisted, body.expectedVersion);
    await reloadSharedModelRuntimeConfig();
    return { ok: true as const, version };
  },

  test: async (params) => {
    const body = params;
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return { ok: false, error: "providerName is required" };
    if (!body.provider || typeof body.provider !== "object") {
      return { ok: false, error: "provider is required" };
    }
    if (!body.model || typeof body.model !== "object") {
      return { ok: false, error: "model is required" };
    }
    const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
    if (!modelId) return { ok: false, error: "Model ID is required" };

    let tempDir: string | undefined;
    try {
      tempDir = mkdtempSync(path.join(tmpdir(), "pi-desktop-model-test-"));
      const modelsPath = path.join(tempDir, "models.json");
      writeFileSync(
        modelsPath,
        JSON.stringify(
          {
            providers: {
              [providerName]: {
                ...body.provider,
                models: [{ ...body.model, id: modelId }],
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const modelRuntime = await createDesktopModelRuntime({ modelsPath, allowModelNetwork: false });
      const loadError = modelRuntime.getError();
      if (loadError) return { ok: false, error: loadError };

      const model = modelRuntime.getModel(providerName, modelId);
      if (!model) return { ok: false, error: `Model not found: ${providerName}/${modelId}` };

      const auth = await modelRuntime.getAuth(model);
      if (!auth) return { ok: false, error: `No authentication found for "${providerName}"` };

      return await probeChatModel(modelRuntime, model, 20_000);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (tempDir) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  },

  listModels: async (params) => {
    const body = params;
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return { ok: false, error: "providerName is required" };
    if (!body.provider || typeof body.provider !== "object") {
      return { ok: false, error: "provider is required" };
    }
    const provider = body.provider as Record<string, unknown>;
    const api = typeof provider.api === "string" && provider.api.trim() ? provider.api.trim() : "openai-completions";
    if (UNLISTABLE_MODEL_APIS.has(api)) {
      return { ok: false, unsupported: true, error: `Listing models is not supported for API "${api}".` };
    }

    let tempDir: string | undefined;
    try {
      tempDir = mkdtempSync(path.join(tmpdir(), "pi-desktop-model-list-"));
      const modelsPath = path.join(tempDir, "models.json");
      // Only provider auth/config is needed to list models; drop model entries so
      // half-edited rows in the editor cannot block provider composition.
      const providerConfig = { ...provider };
      delete providerConfig.models;
      delete providerConfig.modelOverrides;
      writeFileSync(modelsPath, JSON.stringify({ providers: { [providerName]: providerConfig } }, null, 2), "utf8");

      const modelRuntime = await createDesktopModelRuntime({ modelsPath, allowModelNetwork: false });
      const composedProvider = modelRuntime.getProvider(providerName);
      if (!composedProvider) {
        return { ok: false, error: modelRuntime.getError() ?? `Provider "${providerName}" failed to load.` };
      }
      // getAuth applies the same literal / $ENV_VAR / !shell-command resolution as real requests.
      const auth = await modelRuntime.getAuth(providerName);
      const baseUrl = composedProvider.baseUrl?.trim() ?? "";
      if (!baseUrl) return { ok: false, error: "A Base URL is required to fetch the model list." };

      const headers: Record<string, string> = {
        Accept: "application/json",
        ...(composedProvider.headers ?? {}),
        ...(auth?.auth?.headers ?? {}),
      };
      const apiKey = auth?.auth?.apiKey;
      const hasConfiguredAuthHeader = Object.keys(headers).some((key) => {
        const lower = key.toLowerCase();
        return lower === "authorization" || lower === "x-api-key" || lower === "x-goog-api-key";
      });
      if (!hasConfiguredAuthHeader && apiKey) {
        if (api === "anthropic-messages") {
          headers["x-api-key"] = apiKey;
          headers["anthropic-version"] = "2023-06-01";
        } else {
          headers.Authorization = `Bearer ${apiKey}`;
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LIST_MODELS_TIMEOUT_MS);
      const startedAt = Date.now();
      try {
        const candidates = modelListEndpointCandidates(baseUrl);
        for (const [index, url] of candidates.entries()) {
          let response: Awaited<ReturnType<typeof fetch>>;
          try {
            response = await fetch(url, { headers, signal: controller.signal });
          } catch (e) {
            if (controller.signal.aborted) {
              return { ok: false, error: "Model list request timed out.", latencyMs: Date.now() - startedAt };
            }
            return { ok: false, error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - startedAt };
          }
          if (response.status === 404 && index < candidates.length - 1) continue;
          const text = await response.text();
          const latencyMs = Date.now() - startedAt;
          if (!response.ok) {
            return {
              ok: false,
              error: describeListModelsFailure(response.status, text),
              status: response.status,
              latencyMs,
            };
          }
          const models = parseProviderModelList(parseJsonPayload(text));
          if (!models) {
            return {
              ok: false,
              error: "The provider response did not contain a recognizable model list.",
              status: response.status,
              latencyMs,
            };
          }
          return { ok: true, models, status: response.status, latencyMs };
        }
        return { ok: false, error: "No model list endpoint responded." };
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (tempDir) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  },

  fillModelInfo: async (params) => {
    const body = params;
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!modelId) return { ok: false, error: "modelId is required" };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    const provider = (body.provider ?? {}) as Record<string, unknown>;
    const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
    const model = (body.model ?? {}) as Record<string, unknown>;

    // Primary source: the models.dev database (disk cache first, network when stale).
    // Only the base URL is used, and only locally — nothing about the provider is uploaded.
    try {
      const { catalog, stale } = await loadCatalogOnce();
      const match = matchModelFacts(catalog, { modelId, providerName, baseUrl });
      if (match) {
        const fill = buildModelInfoFill(match, model);
        return {
          ok: true,
          fields: fill.fields,
          filled: fill.filled,
          stale,
          source: {
            kind: "models-dev" as const,
            providerName: match.providerName,
            matchedBy: match.matchedBy,
            ...(match.priceProviderName ? { priceProviderName: match.priceProviderName } : {}),
          },
        };
      }
    } catch {
      // Offline without a usable cache: fall through to the built-in catalogs.
    }

    // Fallback source: the SDK's built-in catalogs. The user's own providers are
    // excluded because metadata-less entries carry injected placeholder values.
    try {
      const snapshot = readModelsJsonSnapshot();
      const runtime = await getSharedModelRuntime();
      const builtin = matchBuiltinModelFacts(runtime, modelId, new Set(Object.keys(snapshot.config.providers ?? {})));
      if (builtin) {
        const fill = buildModelInfoFill(builtin, model);
        return {
          ok: true,
          fields: fill.fields,
          filled: fill.filled,
          source: {
            kind: "builtin" as const,
            providerName: builtin.providerName,
            matchedBy: builtin.matchedBy,
          },
        };
      }
    } catch {
      /* report the miss below */
    }

    return { ok: false, error: `No model information found for "${modelId}".` };
  },
} satisfies ModelConfigHandlers;
