import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * models.dev catalog access for the "fill model info" action.
 *
 * The public database is downloaded once and cached as a slim index next to
 * models.json; only the fields models.json can store are kept. Nothing about
 * the user's providers or keys is ever sent — the endpoint URL is fixed and
 * matching happens entirely on the local index.
 */

/** Public models.dev database. Provider entries carry pricing, limits and capabilities. */
export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const MODELS_DEV_SOURCE_URL = "https://models.dev";
export const MODELS_DEV_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MODELS_DEV_FETCH_TIMEOUT_MS = 30_000;

export interface ModelInfoCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Provider entry facts, normalized to the models.json field names. */
export interface ModelFacts {
  name?: string;
  cost?: ModelInfoCost;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  canonicalModelId?: string;
}

export interface ModelsDevCatalog {
  fetchedAt: number;
  providers: Record<string, { name: string; api?: string; models: Record<string, ModelFacts> }>;
}

export type CatalogLoadResult = { catalog: ModelsDevCatalog; stale: boolean };

/** Minimal runtime surface used for the offline built-in catalog fallback. */
export interface BuiltinModelSource {
  getModels(): readonly BuiltinModel[];
  getProvider(providerId: string): { name: string } | undefined;
}

export interface BuiltinModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  input: readonly string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface ModelInfoQuery {
  modelId: string;
  providerName?: string;
  baseUrl?: string;
}

export type ModelInfoMatchedBy = "baseUrl" | "host" | "global" | "builtin";

export interface ModelInfoMatch {
  providerId: string;
  providerName: string;
  matchedBy: ModelInfoMatchedBy;
  facts: ModelFacts;
  /** Present when the pricing came from a different provider entry than the metadata. */
  price?: ModelInfoCost;
  priceProviderName?: string;
}

export interface ModelInfoFillFields {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: true;
  input?: string[];
  cost?: ModelInfoCost;
}

export interface ModelInfoFill {
  fields: ModelInfoFillFields;
  /** Field names whose values actually differ from the current model entry. */
  filled: string[];
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toPositiveNumber(value: unknown): number | undefined {
  const parsed = toFiniteNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function toTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Normalize one models.dev model entry to the fields models.json can store. */
export function toModelFacts(entry: unknown): ModelFacts | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  const facts: ModelFacts = {};
  const name = toTrimmedString(record.name);
  if (name) facts.name = name;

  const cost = record.cost;
  if (cost && typeof cost === "object") {
    const rates = cost as Record<string, unknown>;
    const mapped: ModelInfoCost = {};
    for (const [key, source] of [
      ["input", rates.input],
      ["output", rates.output],
      ["cacheRead", rates.cache_read],
      ["cacheWrite", rates.cache_write],
    ] as const) {
      const value = toFiniteNumber(source);
      if (value !== undefined) mapped[key] = value;
    }
    if (Object.keys(mapped).length > 0) facts.cost = mapped;
  }

  const limit = record.limit;
  if (limit && typeof limit === "object") {
    const bounds = limit as Record<string, unknown>;
    const contextWindow = toPositiveNumber(bounds.context);
    if (contextWindow !== undefined) facts.contextWindow = contextWindow;
    const maxTokens = toPositiveNumber(bounds.output);
    if (maxTokens !== undefined) facts.maxTokens = maxTokens;
  }

  if (record.reasoning === true) facts.reasoning = true;

  const modalities = record.modalities;
  if (modalities && typeof modalities === "object") {
    const input = (modalities as Record<string, unknown>).input;
    if (Array.isArray(input)) {
      const supported = input.filter((modality): modality is string => modality === "text" || modality === "image");
      if (supported.length > 0) facts.input = supported;
    }
  }

  const canonicalModelId = toTrimmedString(record.canonical_model_id);
  if (canonicalModelId) facts.canonicalModelId = canonicalModelId;
  return facts;
}

/**
 * Reduce the models.dev payload to a slim index. Accepts both the flat
 * `api.json` shape and the `{ providers: ... }` shape used by `catalog.json`.
 */
export function slimModelsDevCatalog(payload: unknown, fetchedAt: number): ModelsDevCatalog {
  const providers: ModelsDevCatalog["providers"] = {};
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
  const source = root?.providers ?? root;
  if (!source || typeof source !== "object") return { fetchedAt, providers };

  for (const [providerId, provider] of Object.entries(source as Record<string, unknown>)) {
    if (!provider || typeof provider !== "object") continue;
    const record = provider as Record<string, unknown>;
    const models = record.models;
    if (!models || typeof models !== "object") continue;
    const slimModels: Record<string, ModelFacts> = {};
    for (const [modelId, entry] of Object.entries(models as Record<string, unknown>)) {
      const facts = toModelFacts(entry);
      if (facts) slimModels[modelId] = facts;
    }
    providers[providerId] = {
      name: toTrimmedString(record.name) ?? providerId,
      api: toTrimmedString(record.api),
      models: slimModels,
    };
  }
  return { fetchedAt, providers };
}

export function modelsDevCatalogPath(): string {
  return path.join(getAgentDir(), "models-dev-catalog.json");
}

export function readCachedModelsDevCatalog(): ModelsDevCatalog | undefined {
  const file = modelsDevCatalogPath();
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ModelsDevCatalog;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (typeof parsed.fetchedAt !== "number" || !parsed.providers || typeof parsed.providers !== "object") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeCachedModelsDevCatalog(catalog: ModelsDevCatalog): void {
  const file = modelsDevCatalogPath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(catalog), "utf8");
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* a failed cache write must never break the fill action */
    }
  }
}

export async function downloadModelsDevCatalog(
  fetchImpl: typeof fetch,
  timeoutMs: number = MODELS_DEV_FETCH_TIMEOUT_MS,
  now: number = Date.now(),
): Promise<ModelsDevCatalog> {
  const response = await fetchImpl(MODELS_DEV_API_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`models.dev responded with HTTP ${response.status}`);
  }
  return slimModelsDevCatalog(await response.json(), now);
}

/**
 * Cache-first catalog load: a fresh cache skips the network, an expired cache
 * is refreshed on a best-effort basis, and a failed refresh falls back to the
 * stale cache so the action keeps working offline.
 */
export async function loadModelsDevCatalog(
  options: {
    now?: number;
    fetchImpl?: typeof fetch;
    ttlMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<CatalogLoadResult> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? MODELS_DEV_CACHE_TTL_MS;
  const cached = readCachedModelsDevCatalog();
  if (cached && now - cached.fetchedAt < ttlMs) return { catalog: cached, stale: false };
  try {
    const fresh = await downloadModelsDevCatalog(
      options.fetchImpl ?? fetch,
      options.timeoutMs ?? MODELS_DEV_FETCH_TIMEOUT_MS,
      now,
    );
    writeCachedModelsDevCatalog(fresh);
    return { catalog: fresh, stale: false };
  } catch (error) {
    if (cached) return { catalog: cached, stale: true };
    throw error;
  }
}

function normalizeUrl(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\/+$/, "");
}

function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/.exec(url);
  return match ? match[1] : "";
}

/** Exact id, case-insensitive id, then relay ids such as "stepfun/step-5-preview". */
function lookupFacts(
  models: Record<string, ModelFacts>,
  modelId: string,
): { facts: ModelFacts; exact: boolean } | undefined {
  const direct = models[modelId];
  if (direct) return { facts: direct, exact: true };
  const lower = modelId.toLowerCase();
  for (const [id, facts] of Object.entries(models)) {
    if (id.toLowerCase() === lower) return { facts, exact: true };
  }
  for (const [id, facts] of Object.entries(models)) {
    const slash = id.lastIndexOf("/");
    if (slash >= 0 && id.slice(slash + 1).toLowerCase() === lower) return { facts, exact: false };
  }
  return undefined;
}

function nameSimilarity(providerId: string, providerName: string, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0;
  const id = providerId.toLowerCase();
  const name = providerName.toLowerCase();
  if (id === normalizedQuery || name === normalizedQuery) return 3;
  if (id.includes(normalizedQuery) || normalizedQuery.includes(id)) return 2;
  if (name.includes(normalizedQuery) || normalizedQuery.includes(name)) return 1;
  return 0;
}

function hasUsableFacts(facts: ModelFacts | undefined): boolean {
  if (!facts) return false;
  return (
    facts.contextWindow !== undefined ||
    facts.maxTokens !== undefined ||
    facts.cost !== undefined ||
    facts.reasoning === true ||
    facts.input !== undefined
  );
}

/**
 * Find the best catalog entry for a model. Providers whose endpoint matches the
 * configured base URL win; otherwise the same host, then a global id lookup.
 * Pricing is taken from the matched entry, or from a sibling entry on the same
 * host / vendor when the endpoint-specific entry omits it.
 */
export function matchModelFacts(catalog: ModelsDevCatalog, query: ModelInfoQuery): ModelInfoMatch | undefined {
  const modelId = query.modelId.trim();
  if (!modelId) return undefined;
  const entries = Object.entries(catalog.providers);
  if (entries.length === 0) return undefined;
  const baseUrl = normalizeUrl(query.baseUrl);

  let pool = entries;
  let matchedBy: ModelInfoMatchedBy = "global";
  if (baseUrl) {
    const exact = entries.filter(([, provider]) => normalizeUrl(provider.api) === baseUrl);
    const overlapping = exact.length
      ? exact
      : entries.filter(([, provider]) => {
          const api = normalizeUrl(provider.api);
          return api.length > 0 && (baseUrl.startsWith(api) || api.startsWith(baseUrl));
        });
    const host = hostOf(baseUrl);
    const sameHost = host ? entries.filter(([, provider]) => hostOf(normalizeUrl(provider.api)) === host) : [];
    if (overlapping.length > 0) {
      pool = overlapping;
      matchedBy = "baseUrl";
    } else if (sameHost.length > 0) {
      pool = sameHost;
      matchedBy = "host";
    }
  }

  const candidates = pool
    .map(([providerId, provider]) => {
      const found = lookupFacts(provider.models, modelId);
      return found ? { providerId, provider, facts: found.facts, exact: found.exact } : undefined;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => {
    // An exact id match outranks a relay-prefixed one; priced entries outrank
    // unpriced ones; a provider name resembling the user's wins ties.
    const scoreA =
      (a.exact ? 2 : 0) +
      (a.facts.cost ? 4 : 0) +
      nameSimilarity(a.providerId, a.provider.name, query.providerName ?? "");
    const scoreB =
      (b.exact ? 2 : 0) +
      (b.facts.cost ? 4 : 0) +
      nameSimilarity(b.providerId, b.provider.name, query.providerName ?? "");
    if (scoreA !== scoreB) return scoreB - scoreA;
    return a.providerId.localeCompare(b.providerId);
  });
  const best = candidates[0];
  const facts = best.facts;

  let price = facts.cost;
  let priceProviderName: string | undefined;
  if (!price) {
    const host = hostOf(baseUrl);
    const priceCandidates = entries
      .filter(([providerId]) => providerId !== best.providerId)
      .map(([providerId, provider]) => {
        const found = lookupFacts(provider.models, modelId);
        return found ? { providerId, provider, facts: found.facts, exact: found.exact } : undefined;
      })
      .filter(
        (candidate): candidate is NonNullable<typeof candidate> =>
          candidate !== undefined && candidate.facts.cost !== undefined,
      )
      .sort((a, b) => {
        const rank = (candidate: { providerId: string; provider: { name: string; api?: string }; exact: boolean }) => {
          const api = normalizeUrl(candidate.provider.api);
          let score = 0;
          if (host && hostOf(api) === host) score += 8;
          if (best.providerId.startsWith(candidate.providerId) || candidate.providerId.startsWith(best.providerId)) {
            score += 4;
          }
          if (candidate.exact) score += 2;
          return score + nameSimilarity(candidate.providerId, candidate.provider.name, query.providerName ?? "");
        };
        const scoreA = rank(a);
        const scoreB = rank(b);
        if (scoreA !== scoreB) return scoreB - scoreA;
        return a.providerId.localeCompare(b.providerId);
      });
    const priceSource = priceCandidates[0];
    if (priceSource) {
      price = priceSource.facts.cost;
      priceProviderName = priceSource.provider.name;
    }
  }

  return {
    providerId: best.providerId,
    providerName: best.provider.name,
    matchedBy,
    facts,
    ...(price ? { price } : {}),
    ...(priceProviderName ? { priceProviderName } : {}),
  };
}

/** Offline fallback: search the SDK's built-in model catalogs. */
export function matchBuiltinModelFacts(
  source: BuiltinModelSource,
  modelId: string,
  excludeProviders: ReadonlySet<string> = new Set(),
): ModelInfoMatch | undefined {
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  const matches = source
    .getModels()
    .filter(
      (model) =>
        !excludeProviders.has(model.provider) &&
        (model.id === trimmed || model.id.toLowerCase() === lower || model.id.toLowerCase().endsWith(`/${lower}`)),
    );
  for (const model of matches) {
    // models.json entries without metadata get injected defaults (an all-zero
    // cost); only entries that carry real values are usable as a fill source.
    const rates: ModelInfoCost = {
      input: toFiniteNumber(model.cost.input),
      output: toFiniteNumber(model.cost.output),
      cacheRead: toFiniteNumber(model.cost.cacheRead),
      cacheWrite: toFiniteNumber(model.cost.cacheWrite),
    };
    const cost: ModelInfoCost = {};
    for (const [key, value] of Object.entries(rates)) {
      if (value !== undefined && value >= 0) cost[key as keyof ModelInfoCost] = value;
    }
    const carriesPricing = Object.keys(cost).length > 0 && Object.values(cost).some((value) => value !== 0);
    const facts: ModelFacts = {
      name: model.name || undefined,
      contextWindow: toPositiveNumber(model.contextWindow),
      maxTokens: toPositiveNumber(model.maxTokens),
      ...(model.reasoning ? { reasoning: true } : {}),
      ...(model.input.includes("image") ? { input: ["text", "image"] } : {}),
      ...(carriesPricing ? { cost } : {}),
    };
    if (!hasUsableFacts(facts)) continue;
    return {
      providerId: model.provider,
      providerName: source.getProvider(model.provider)?.name ?? model.provider,
      matchedBy: "builtin",
      facts,
      ...(facts.cost ? { price: facts.cost } : {}),
    };
  }
  return undefined;
}

/**
 * Decide which fields to write. Only values the source actually provides are
 * returned, names never overwrite an existing one, and reasoning is only ever
 * switched on — the user's manual choices are never cleared.
 */
export function buildModelInfoFill(
  match: ModelInfoMatch,
  current: {
    name?: unknown;
    contextWindow?: unknown;
    maxTokens?: unknown;
    reasoning?: unknown;
    input?: unknown;
    cost?: unknown;
  },
): ModelInfoFill {
  const fields: ModelInfoFillFields = {};
  const filled: string[] = [];
  const { facts } = match;

  const currentName = toTrimmedString(current.name);
  if (!currentName && facts.name) {
    fields.name = facts.name;
    filled.push("name");
  }

  if (facts.contextWindow !== undefined && current.contextWindow !== facts.contextWindow) {
    fields.contextWindow = facts.contextWindow;
    filled.push("contextWindow");
  }

  if (facts.maxTokens !== undefined && current.maxTokens !== facts.maxTokens) {
    fields.maxTokens = facts.maxTokens;
    filled.push("maxTokens");
  }

  if (facts.reasoning === true && current.reasoning !== true) {
    fields.reasoning = true;
    filled.push("reasoning");
  }

  if (facts.input?.includes("image")) {
    const currentInput = Array.isArray(current.input) ? (current.input as string[]) : [];
    if (!currentInput.includes("image")) {
      fields.input = ["text", "image"];
      filled.push("input");
    }
  }

  const cost = match.price;
  if (cost) {
    const currentCost =
      current.cost && typeof current.cost === "object" ? (current.cost as Record<string, unknown>) : {};
    // models.json requires all four cost keys whenever a cost object exists, so
    // the filled cost is always complete: source values win, the user's existing
    // values survive for keys the source omits, and anything still missing is 0.
    const nextCost: ModelInfoCost = {};
    let changed = false;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = cost[key] ?? toFiniteNumber(currentCost[key]) ?? 0;
      nextCost[key] = value;
      if (currentCost[key] !== value) changed = true;
    }
    if (changed) {
      fields.cost = nextCost;
      filled.push("cost");
    }
  }

  return { fields, filled };
}
