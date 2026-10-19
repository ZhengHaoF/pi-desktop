import type { ContextUsage } from "../../shared/pi-types.ts";

/**
 * Reads the post-compaction projection size out of a compaction result. Both
 * the `compact` command reply and the `compaction_end` event carry it.
 */
export function readCompactionEstimate(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const value = result as { estimatedTokensAfter?: unknown };
  return typeof value.estimatedTokensAfter === "number" ? value.estimatedTokensAfter : null;
}

/**
 * Between a compaction and the first assistant response after it, Pi reports
 * context usage as unknown: usage captured before a compaction no longer
 * describes the projected context. Compaction already measured the projected
 * size, so snapshots taken in that window adopt the estimate instead of
 * leaving the header on the pre-compaction reading. A measured value — which
 * only exists once a post-compaction response has usage — always wins.
 */
export function withCompactionEstimate(
  usage: ContextUsage | null | undefined,
  estimateTokens: number | null,
): ContextUsage | null {
  if (!usage || estimateTokens === null || estimateTokens <= 0) return usage ?? null;
  if (usage.percent !== null || usage.tokens !== null) return usage;
  if (usage.contextWindow <= 0) return usage;
  return { ...usage, tokens: estimateTokens, percent: (estimateTokens / usage.contextWindow) * 100 };
}
