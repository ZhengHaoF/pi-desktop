import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "../shared/pi-types";

/**
 * A user abort leaves an assistant turn that produced no content: the SDK wraps
 * the abort through `createErrorMessage()`, which builds
 * `{ content: [], stopReason: "error", errorMessage }`. The model reads such a
 * turn as a reply it never finished, so it re-delivers its previous conclusion
 * at the start of every later answer.
 *
 * Omitting it from the model projection is the same durable mechanism the SDK
 * itself uses for failed retry attempts (`_omitRecoveryAttempt`): a
 * `context_edit` entry with a `null` replacement. The session file keeps the
 * turn, so the UI still renders the aborted message.
 */

type AssistantTurnLike = {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  content?: unknown;
};

/** Provider abort wordings differ: "This/The operation was aborted", "Request was aborted". */
const ABORT_ERROR_PATTERN = /abort/i;

/** How far back from the leaf to look for the just-persisted message. */
const BRANCH_TAIL_SCAN_LIMIT = 64;

/** Content the model could still read; an empty array is a silent turn. */
function hasContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.length > 0;
}

/**
 * Whether an assistant turn is the empty, aborted one that leaves the model
 * with an unfinished reply. A partial answer keeps its content and is left
 * alone — only turns that say nothing are omitted.
 */
export function isEmptyAbortedAssistantTurn(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const turn = message as AssistantTurnLike;
  if (turn.role !== "assistant") return false;
  if (hasContent(turn.content)) return false;
  if (turn.stopReason === "aborted") return true;
  if (turn.stopReason !== "error") return false;
  return typeof turn.errorMessage === "string" && ABORT_ERROR_PATTERN.test(turn.errorMessage);
}

/** The entry holding this exact message object, searched back from the leaf. */
function findEntryForMessage(sessionManager: SessionManager, message: unknown): SessionEntry | undefined {
  let current = sessionManager.getLeafEntry();
  for (let steps = 0; current && steps < BRANCH_TAIL_SCAN_LIMIT; steps += 1) {
    if (current.type === "message" && current.message === message) return current;
    current = current.parentId ? sessionManager.getEntry(current.parentId) : undefined;
  }
  return undefined;
}

/** Whether the branch already carries an edit omitting this entry. */
function hasContextEditTargeting(sessionManager: SessionManager, targetId: string): boolean {
  let current = sessionManager.getLeafEntry();
  for (let steps = 0; current && steps < BRANCH_TAIL_SCAN_LIMIT; steps += 1) {
    if (current.type === "context_edit" && current.targetId === targetId) return true;
    current = current.parentId ? sessionManager.getEntry(current.parentId) : undefined;
  }
  return false;
}

/**
 * Durably omit one empty aborted assistant turn from the model projection.
 *
 * The wrapper observes `message_end` before the SDK persists the message, so
 * callers run this on a later tick. The entry is located by object identity
 * (`appendMessage` stores the message by reference), which keeps the write
 * correct when the SDK changes its persist ordering: a miss simply omits
 * nothing. Returns the appended `context_edit` entry id, or null when there was
 * nothing to omit.
 */
export function omitEmptyAbortedAssistantTurn(sessionManager: SessionManager, message: unknown): string | null {
  const entry = findEntryForMessage(sessionManager, message);
  if (!entry || entry.type !== "message") return null;
  if (!isEmptyAbortedAssistantTurn(entry.message)) return null;
  if (hasContextEditTargeting(sessionManager, entry.id)) return null;
  return sessionManager.appendContextEdit(entry.id, null);
}

/**
 * Omit an aborted assistant turn once the SDK has persisted it.
 *
 * The SDK emits `message_end` before it appends the message, so the write runs
 * after the current synchronous block. `isAlive` lets the caller skip a session
 * that is being torn down — `dispose()` unsubscribes before it aborts, so a
 * teardown never writes an omission for a session that is going away. Failures
 * are logged and swallowed: an omission is best-effort and must never interrupt
 * the Agent.
 */
export function scheduleAbortedTurnOmission(
  session: Pick<AgentSessionLike, "sessionId" | "sessionManager">,
  message: unknown,
  isAlive: () => boolean,
): void {
  if (!isEmptyAbortedAssistantTurn(message)) return;
  queueMicrotask(() => {
    if (!isAlive()) return;
    try {
      omitEmptyAbortedAssistantTurn(session.sessionManager, message);
    } catch (error) {
      console.warn(
        `[pi-desktop] failed to omit the aborted turn for ${session.sessionId}: ${error instanceof Error ? error.message : "UnknownError"}`,
      );
    }
  });
}
