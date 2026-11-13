/**
 * Pure helpers for the extension-UI request/response wire shapes. Kept out of
 * rpc-manager so the class stays within its architecture ceiling.
 */
import type { ExtensionUiRequest, ExtensionUiResponse } from "../shared/types";

/**
 * Remote clients wrap the response body in `response` (`{type, id, response}`),
 * the local renderer sends it flat. Accept both so older app builds still
 * resolve approvals; the wrapper's id always wins.
 */
export function normalizeExtensionUiResponse(command: Record<string, unknown>): ExtensionUiResponse {
  const nested = command.response;
  if (nested && typeof nested === "object" && !Array.isArray(nested))
    return {
      ...(nested as Record<string, unknown>),
      type: "extension_ui_response",
      id: command.id,
    } as ExtensionUiResponse;
  return command as ExtensionUiResponse;
}

/**
 * Broadcast that a dialog settled anywhere (answered here or on a phone,
 * timed out, or the turn aborted) so every client closes its copy.
 */
export function extensionUiResolvedRequest(id: string, requestId: string): ExtensionUiRequest {
  return { type: "extension_ui_request", id, method: "resolved", requestId };
}
