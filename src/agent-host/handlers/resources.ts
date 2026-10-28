import { codingToolAvailability } from "../../shared/tool-presets";
import {
  WEB_SEARCH_LIMITS,
  normalizeWebSearchSettings,
  type WebSearchSettings,
  type WebSearchSnapshot,
} from "../../shared/web-search";
import { webSearchSettings } from "../web-search/settings";
import { initializeWebSearchRuntime, peekWebSearchRuntime } from "../web-search/runtime";
import { probeWebSearchCredential } from "../web-search/credentials";
import type { TestResult } from "../../contract/types";
import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ApiHandler } from "../../contract/rpc";
import { RpcError } from "../../contract/types";
import { applyPluginAction, readPlugins } from "../plugins-service";
import { installSkill, searchSkills } from "../skills-service";
import { updateSkillModelInvocation } from "../skill-frontmatter";
import { ToolchainError } from "../../shared/toolchains/errors";
import { toolchainRuntime } from "../toolchain-runtime";
import { cacheWarmingSettings, isCacheWarmingMode } from "../cache-warming-settings";
import { agentShellPreferences } from "../agent-shell-settings";
import { isAgentShell } from "../../shared/agent-shell";
import { isSelectableToolPreset } from "../../shared/tool-presets";
import { toolPresetPreferences } from "../tool-preset-settings";

/** A live query with stable results, so a successful test proves key, network and billing in one call. */
const WEB_SEARCH_TEST_QUERY = "DeepSeek";

async function resolveLoadedSkill(cwd: string, filePath: string) {
  if (!cwd || !filePath) {
    throw new RpcError({ code: "BAD_REQUEST", message: "cwd and filePath are required" });
  }
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await loader.reload();
  const requested = realpathSync(filePath);
  const skill = loader.getSkills().skills.find((candidate) => {
    try {
      return realpathSync(candidate.filePath) === requested;
    } catch {
      return false;
    }
  });
  if (!skill) {
    throw new RpcError({ code: "FORBIDDEN", message: "Skill is not loaded for this project" });
  }
  return skill;
}

/** Accepts only known keys with valid ranges; unknown or malformed fields fail before any write. */ function readWebSearchPatch(
  params: unknown,
): Partial<WebSearchSettings> {
  const record = (params ?? {}) as Record<string, unknown>;
  const patch: Partial<WebSearchSettings> = {};
  const bad = (message: string) => new RpcError({ code: "BAD_REQUEST", message });
  const enabled: unknown = record.enabled;
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") throw bad("enabled must be a boolean");
    patch.enabled = enabled;
  }
  const apiKeyOverride: unknown = record.apiKeyOverride;
  if (apiKeyOverride !== undefined) {
    if (typeof apiKeyOverride !== "string") throw bad("apiKeyOverride must be a string");
    if (apiKeyOverride.trim().length > WEB_SEARCH_LIMITS.apiKeyOverrideMaxLength)
      throw bad(`apiKeyOverride must be at most ${String(WEB_SEARCH_LIMITS.apiKeyOverrideMaxLength)} characters`);
    patch.apiKeyOverride = apiKeyOverride.trim();
  }
  const maxResults: unknown = record.maxResults;
  if (maxResults !== undefined) {
    const { min, max } = WEB_SEARCH_LIMITS.maxResults;
    if (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < min || maxResults > max)
      throw bad(`maxResults must be an integer between ${String(min)} and ${String(max)}`);
    patch.maxResults = maxResults;
  }
  const timeoutMs: unknown = record.timeoutMs;
  if (timeoutMs !== undefined) {
    const { min, max } = WEB_SEARCH_LIMITS.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < min || timeoutMs > max)
      throw bad(`timeoutMs must be an integer between ${String(min)} and ${String(max)}`);
    patch.timeoutMs = timeoutMs;
  }
  const providerId: unknown = record.providerId;
  if (providerId !== undefined) {
    if (typeof providerId !== "string" || !providerId.trim()) throw bad("providerId must be a non-empty string");
    const id = providerId.trim();
    const runtime = peekWebSearchRuntime();
    if (runtime && !runtime.getProvider(id)) throw bad(`Unknown web search provider: ${id}`);
    patch.providerId = id;
  }
  return normalizeWebSearchSettings({ ...webSearchSettings.get(), ...patch });
}

function writeTextAtomically(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

type ResourceHandlers = {
  getAgentShell: NonNullable<ApiHandler["settings.getAgentShell"]>;
  setAgentShell: NonNullable<ApiHandler["settings.setAgentShell"]>;
  getDefaultToolPreset: NonNullable<ApiHandler["settings.getDefaultToolPreset"]>;
  setDefaultToolPreset: NonNullable<ApiHandler["settings.setDefaultToolPreset"]>;
  getWebSearch: NonNullable<ApiHandler["settings.getWebSearch"]>;
  setWebSearch: NonNullable<ApiHandler["settings.setWebSearch"]>;
  testWebSearch: NonNullable<ApiHandler["settings.testWebSearch"]>;
  toolchain: NonNullable<ApiHandler["host.toolchain"]>;
  getCacheWarming: NonNullable<ApiHandler["settings.getCacheWarming"]>;
  setCacheWarming: NonNullable<ApiHandler["settings.setCacheWarming"]>;
  listSkills: NonNullable<ApiHandler["skills.list"]>;
  searchSkills: NonNullable<ApiHandler["skills.search"]>;
  installSkill: NonNullable<ApiHandler["skills.install"]>;
  setSkill: NonNullable<ApiHandler["skills.set"]>;
  getSkillContent: NonNullable<ApiHandler["skills.getContent"]>;
  listPlugins: NonNullable<ApiHandler["plugins.list"]>;
  setPlugin: NonNullable<ApiHandler["plugins.set"]>;
};
export const resourceHandlers = {
  toolchain: async (params) => {
    const { cwd } = params as { cwd: string };
    if (!cwd || !path.isAbsolute(cwd)) throw new RpcError({ code: "BAD_REQUEST", message: "absolute cwd required" });
    const context = await toolchainRuntime.createExecutionContext({ cwd, intent: "project-command" });
    return {
      inventoryRevision: context.inventoryRevision,
      resolutionId: context.resolutionId,
      codingTools: codingToolAvailability(process.platform, context.commands, agentShellPreferences().get().shell),
      capabilities: Object.fromEntries(
        Object.entries(context.commands).map(([capability, command]) => [
          capability,
          { provider: command.provider, version: command.version },
        ]),
      ),
    };
  },

  getCacheWarming: async () => cacheWarmingSettings.get(),

  getWebSearch: async (): Promise<WebSearchSnapshot> => {
    const settings = webSearchSettings.get();
    // Probe regardless of the switch so the panel can show where a key would come from.
    const source = await probeWebSearchCredential(settings);
    return {
      settings,
      credential: { source, providerId: settings.providerId },
      loadFailed: webSearchSettings.hasLoadFailed(),
    };
  },

  setWebSearch: async (params): Promise<WebSearchSnapshot> => {
    const patch = readWebSearchPatch(params);
    const settings = await webSearchSettings.patch(patch);
    const source = await probeWebSearchCredential(settings);
    return { settings, credential: { source, providerId: settings.providerId }, loadFailed: false };
  },

  testWebSearch: async (params): Promise<TestResult> => {
    // A draft key can be validated without persisting it; otherwise the saved settings are tested.
    const draft = (params as { apiKeyOverride?: unknown } | undefined)?.apiKeyOverride;
    if (draft !== undefined && typeof draft !== "string")
      throw new RpcError({ code: "BAD_REQUEST", message: "apiKeyOverride must be a string" });
    const stored = webSearchSettings.get();
    const settings = draft === undefined ? stored : normalizeWebSearchSettings({ ...stored, apiKeyOverride: draft });
    const runtime = initializeWebSearchRuntime();
    const provider = runtime.getProvider(settings.providerId);
    if (!provider) return { ok: false, error: `Web search provider "${settings.providerId}" is not available.` };
    const startedAt = Date.now();
    try {
      const { apiKey } = await runtime.resolveApiKey(settings);
      const items = await provider.search(
        { query: WEB_SEARCH_TEST_QUERY, count: 1 },
        { apiKey, timeoutMs: settings.timeoutMs },
      );
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        responseText: items[0]?.title ?? "Search completed with no results",
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  getAgentShell: async () => agentShellPreferences().get(),
  setAgentShell: async (params) => {
    if (process.platform !== "win32" || !isAgentShell(params?.shell))
      throw new RpcError({ code: "BAD_REQUEST", message: "Invalid Agent shell selection" });
    return agentShellPreferences().set(params.shell);
  },

  getDefaultToolPreset: async () => toolPresetPreferences().get(),
  setDefaultToolPreset: async (params) => {
    if (!isSelectableToolPreset(params?.preset))
      throw new RpcError({ code: "BAD_REQUEST", message: "Invalid default tool preset selection" });
    return toolPresetPreferences().set(params.preset);
  },

  setCacheWarming: async (params) => {
    const mode = (params as { mode?: unknown } | undefined)?.mode;
    if (!isCacheWarmingMode(mode)) throw new RpcError({ code: "BAD_REQUEST", message: "Invalid cache warming mode" });
    try {
      return await cacheWarmingSettings.set(mode);
    } catch {
      throw new RpcError({ code: "INTERNAL", message: "Global Pi cache warming setting could not be saved" });
    }
  },

  listSkills: async (params) => {
    const cwd = (params as { cwd?: string } | void)?.cwd;
    if (!cwd) throw new RpcError({ code: "BAD_REQUEST", message: "cwd required" });
    const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
    await loader.reload();
    const { skills, diagnostics } = loader.getSkills();
    return { skills, diagnostics };
  },

  searchSkills: async (params) => {
    const { query } = params as { query: string };
    try {
      return await searchSkills(query);
    } catch (e) {
      if (e instanceof ToolchainError) throw e;
      throw new RpcError({
        code: "INTERNAL",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  installSkill: async (params) => {
    try {
      return await installSkill(params);
    } catch (e) {
      if (e instanceof ToolchainError) throw e;
      throw new RpcError({
        code: "INTERNAL",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  setSkill: async (params) => {
    const body = params as {
      cwd: string;
      filePath: string;
      disableModelInvocation?: boolean;
      content?: string;
    };
    const skill = await resolveLoadedSkill(body.cwd, body.filePath);
    const { filePath } = skill;
    const content = body.content ?? readFileSync(filePath, "utf8");
    if (content.length > 2 * 1024 * 1024) {
      throw new RpcError({ code: "BAD_REQUEST", message: "Skill file is too large" });
    }
    const updated =
      body.disableModelInvocation === undefined
        ? content
        : updateSkillModelInvocation(content, body.disableModelInvocation);
    writeTextAtomically(filePath, updated);
    return { ok: true as const };
  },

  getSkillContent: async (params) => {
    const body = params as { cwd: string; filePath: string };
    const skill = await resolveLoadedSkill(body.cwd, body.filePath);
    return { content: readFileSync(skill.filePath, "utf8") };
  },

  listPlugins: async (params) => {
    const cwd = (params as { cwd?: string } | void)?.cwd;
    if (!cwd) throw new RpcError({ code: "BAD_REQUEST", message: "cwd required" });
    return readPlugins(cwd);
  },

  setPlugin: async (params) => {
    return applyPluginAction(params);
  },
} satisfies ResourceHandlers;
