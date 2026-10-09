import { statSync } from "node:fs";
import {
  createAgentSessionServices,
  getAgentDir,
  type ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ApiHandler } from "../../contract/rpc";
import {
  RpcError,
  type ModelInfo,
  type ModelCatalogStatus,
  type ModelCatalogWarning,
  type ModelPreferencesResult,
  type ModelsListResult,
} from "../../contract/types";
import { modelCatalogRefreshCoordinator } from "../model-runtime";

const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function stripThinkingSuffix(modelRef: string): string {
  const trimmed = modelRef.trim();
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex === -1) return trimmed;
  const suffix = trimmed.substring(colonIndex + 1);
  return THINKING_SUFFIXES.has(suffix) ? trimmed.substring(0, colonIndex) : trimmed;
}

function filterByExactEnabledModels<T extends { id: string; provider: string }>(
  available: readonly T[],
  enabledModels: string[] | undefined,
): readonly T[] {
  if (!enabledModels || enabledModels.length === 0) return available;
  const refs = new Set(enabledModels.map(stripThinkingSuffix).filter(Boolean));
  const visible = available.filter((m) => refs.has(`${m.provider}/${m.id}`) || refs.has(m.id));
  return visible.length > 0 ? visible : available;
}

function resolveDefaultModel(
  settings: Pick<SettingsManager, "getDefaultProvider" | "getDefaultModel">,
  visible: readonly { provider: string; id: string }[],
): { provider: string; modelId: string } | null {
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (provider && modelId && visible.some((model) => model.provider === provider && model.id === modelId)) {
    return { provider, modelId };
  }
  return null;
}

/**
 * Mirrors Pi's own persisted-default handling: a default filtered out by
 * enabledModels never reaches the picker, so it is added back to the list.
 */
export function includeDefaultModelInEnabled(
  enabledModels: string[] | undefined,
  provider: string,
  modelId: string,
): string[] | undefined {
  if (!enabledModels || enabledModels.length === 0) return enabledModels;
  const reference = `${provider}/${modelId}`.toLowerCase();
  if (enabledModels.some((entry) => stripThinkingSuffix(entry).toLowerCase() === reference)) return enabledModels;
  return [...enabledModels, `${provider}/${modelId}`];
}

export function projectModelPreferences<T extends { id: string; name: string; provider: string }>(
  available: readonly T[],
  enabledModels: string[] | undefined,
  settings: Pick<SettingsManager, "getDefaultProvider" | "getDefaultModel">,
): ModelPreferencesResult {
  const models: ModelInfo[] = available
    .map((model) => ({ id: model.id, name: model.name, provider: model.provider }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  const normalized = [...new Set((enabledModels ?? []).map(stripThinkingSuffix).filter(Boolean))];
  return {
    models,
    enabledModels: normalized.length > 0 ? normalized : null,
    // The picker hides models filtered out by enabledModels, so a default that is
    // filtered out would never surface; project it against the same visible set.
    defaultModel: resolveDefaultModel(settings, filterByExactEnabledModels(available, enabledModels)),
  };
}

function normalizeEnabledModelsInput(value: unknown): string[] | undefined {
  if (value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 2000) {
    throw new RpcError({
      code: "BAD_REQUEST",
      message: "enabledModels must be null or a non-empty array with at most 2000 entries",
    });
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const valueEntry of value) {
    if (typeof valueEntry !== "string") {
      throw new RpcError({ code: "BAD_REQUEST", message: "Every enabled model reference must be a string" });
    }
    const modelReference = stripThinkingSuffix(valueEntry);
    if (!modelReference || modelReference.length > 512) {
      throw new RpcError({ code: "BAD_REQUEST", message: "Invalid enabled model reference" });
    }
    if (!seen.has(modelReference)) {
      seen.add(modelReference);
      normalized.push(modelReference);
    }
  }
  return normalized;
}

function hasMatchingEnabledModel<T extends { id: string; provider: string }>(
  available: readonly T[],
  enabledModels: string[],
): boolean {
  const refs = new Set(enabledModels);
  return available.some((model) => refs.has(`${model.provider}/${model.id}`) || refs.has(model.id));
}

function resolveModelsCwd(params: { cwd?: string } | void): string {
  const cwd = params?.cwd || process.cwd();
  try {
    const st = statSync(cwd);
    if (!st.isDirectory()) throw new Error("not-directory");
  } catch {
    throw new RpcError({ code: "BAD_REQUEST", message: `Directory does not exist: ${cwd}` });
  }
  return cwd;
}

export type AvailableModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];

async function resolveAvailableModels(
  modelRuntime: ModelRuntime,
  signal?: AbortSignal,
): Promise<{ models: AvailableModel[]; warnings: ModelCatalogWarning[] }> {
  const snapshot = [...modelRuntime.getAvailableSnapshot()];
  const snapshotByProvider = new Map<string, AvailableModel[]>();
  for (const model of snapshot) {
    const models = snapshotByProvider.get(model.provider) ?? [];
    models.push(model);
    snapshotByProvider.set(model.provider, models);
  }

  const results = await Promise.all(
    [...modelRuntime.getProviders()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(async (provider) => {
        try {
          const models = [...(await modelRuntime.getAvailable(provider.id, { signal }))];
          return { models, warning: undefined };
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          return {
            models: snapshotByProvider.get(provider.id) ?? [],
            warning: {
              provider: provider.id,
              code: "PROVIDER_AVAILABILITY_FAILED" as const,
              message: `Unable to check ${provider.id} model availability; the last known state remains available.`,
            },
          };
        }
      }),
  );
  signal?.throwIfAborted();
  return {
    models: results.flatMap((result) => result.models),
    warnings: results.flatMap((result) => (result.warning ? [result.warning] : [])),
  };
}

export async function projectModelsList(
  modelRuntime: ModelRuntime,
  settings: SettingsManager,
  catalog: ModelCatalogStatus,
  options: { signal?: AbortSignal; cachedOnly?: boolean } = {},
): Promise<ModelsListResult> {
  const availability = options.cachedOnly
    ? { models: [...modelRuntime.getAvailableSnapshot()], warnings: [] }
    : await resolveAvailableModels(modelRuntime, options.signal);
  const available = availability.models;
  const enabledModels = settings.getEnabledModels();
  const visible = filterByExactEnabledModels(available, enabledModels);
  const models = visible
    .map((model) => ({ id: model.id, name: model.name, provider: model.provider }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider));

  const nameMap: Record<string, string> = {};
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  for (const model of visible) {
    const key = `${model.provider}:${model.id}`;
    nameMap[key] = model.name;
    thinkingLevels[key] = getSupportedThinkingLevels(model);
    if (model.thinkingLevelMap) thinkingLevelMaps[key] = model.thinkingLevelMap;
  }

  return {
    models,
    defaultModel: resolveDefaultModel(settings, visible),
    thinkingLevels,
    thinkingLevelMaps,
    nameMap,
    catalog: availability.warnings.length
      ? { ...catalog, warnings: [...catalog.warnings, ...availability.warnings] }
      : catalog,
  };
}

type ModelCatalogHandlers = {
  list: NonNullable<ApiHandler["models.list"]>;
  refresh: NonNullable<ApiHandler["models.refresh"]>;
  cancelRefresh: NonNullable<ApiHandler["models.refreshCancel"]>;
  getPreferences: NonNullable<ApiHandler["models.preferences.get"]>;
  setPreferences: NonNullable<ApiHandler["models.preferences.set"]>;
  setDefaultModel: NonNullable<ApiHandler["models.default.set"]>;
};

export const modelCatalogHandlers = {
  list: async (params) => {
    const cwd = resolveModelsCwd(params as { cwd?: string } | void);
    const agentDir = getAgentDir();
    const services = await createAgentSessionServices({ cwd, agentDir });
    return projectModelsList(services.modelRuntime, services.settingsManager, {
      source: process.env.PI_OFFLINE === undefined ? "cache" : "offline",
      refreshed: false,
      aborted: false,
      warnings: [],
    });
  },

  refresh: async (params) => {
    const { requestId } = params as { cwd?: string; requestId: string };
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) {
      throw new RpcError({ code: "BAD_REQUEST", message: "Invalid model refresh request id" });
    }
    const cwd = resolveModelsCwd(params);
    const agentDir = getAgentDir();
    return modelCatalogRefreshCoordinator.refresh(
      cwd,
      requestId,
      (signal) => createAgentSessionServices({ cwd, agentDir, modelRuntimeSignal: signal }),
      ({ services, catalog }, signal) =>
        projectModelsList(services.modelRuntime, services.settingsManager, catalog, {
          signal,
          cachedOnly: catalog.aborted,
        }),
    );
  },

  cancelRefresh: (params) => {
    const { requestId } = params as { requestId: string };
    return { ok: true as const, cancelled: modelCatalogRefreshCoordinator.cancel(requestId) };
  },

  getPreferences: async (params) => {
    const cwd = resolveModelsCwd(params as { cwd?: string } | void);
    const services = await createAgentSessionServices({ cwd, agentDir: getAgentDir() });
    const { models: available } = await resolveAvailableModels(services.modelRuntime);
    return projectModelPreferences(available, services.settingsManager.getEnabledModels(), services.settingsManager);
  },

  setPreferences: async (params) => {
    const body = params as { cwd?: string; enabledModels?: unknown };
    const cwd = resolveModelsCwd(body);
    const enabledModels = normalizeEnabledModelsInput(body.enabledModels);
    const services = await createAgentSessionServices({ cwd, agentDir: getAgentDir() });
    const { models: available } = await resolveAvailableModels(services.modelRuntime);
    if (enabledModels && !hasMatchingEnabledModel(available, enabledModels)) {
      throw new RpcError({ code: "BAD_REQUEST", message: "At least one available model must remain enabled" });
    }
    services.settingsManager.setEnabledModels(enabledModels);
    return projectModelPreferences(available, enabledModels, services.settingsManager);
  },

  setDefaultModel: async (params) => {
    const body = params as { cwd?: string; provider?: unknown; modelId?: unknown };
    const cwd = resolveModelsCwd(body);
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!provider || !modelId) {
      throw new RpcError({ code: "BAD_REQUEST", message: "provider and modelId are required" });
    }
    const services = await createAgentSessionServices({ cwd, agentDir: getAgentDir() });
    const { models: available } = await resolveAvailableModels(services.modelRuntime);
    if (!available.some((model) => model.provider === provider && model.id === modelId)) {
      throw new RpcError({ code: "BAD_REQUEST", message: `Model is not available: ${provider}/${modelId}` });
    }
    const settings = services.settingsManager;
    settings.setDefaultModelAndProvider(provider, modelId);
    const enabledModels = includeDefaultModelInEnabled(settings.getEnabledModels(), provider, modelId);
    if (enabledModels) settings.setEnabledModels(enabledModels);
    await settings.flush();
    if (settings.drainErrors().some((error) => error.scope === "global")) {
      throw new RpcError({ code: "INTERNAL", message: "Global Pi settings could not be saved" });
    }
    return projectModelPreferences(available, settings.getEnabledModels(), settings);
  },
} satisfies ModelCatalogHandlers;
