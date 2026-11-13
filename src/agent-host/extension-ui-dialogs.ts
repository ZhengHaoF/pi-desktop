/**
 * Extension-UI dialog methods (select/confirm/input/editor/ask) for the
 * desktop UI context. Split from rpc-manager to keep that class within its
 * architecture ceiling; the request/response plumbing stays there.
 */
import type { ExtensionUiContextLike } from "../shared/pi-types";
import type { ExtensionUiRequest, ExtensionUiResponse } from "../shared/types";

type RequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

/** Same contract as AgentSessionWrapper.requestExtensionUi, without `this`. */
export type ExtensionUiRequester = <T>(
  request: RequestBody,
  defaultValue: T,
  parseResponse: (response: ExtensionUiResponse) => T,
  timeout?: number,
  signal?: AbortSignal,
) => Promise<T>;

type DialogMethods = Pick<
  ExtensionUiContextLike,
  "select" | "confirm" | "confirmLocalized" | "input" | "editor" | "askQuestions"
>;

const readValue = (response: ExtensionUiResponse) => ("value" in response ? response.value : undefined);
const readConfirmed = (response: ExtensionUiResponse) => ("confirmed" in response ? response.confirmed : false);

export function createExtensionUiDialogs(request: ExtensionUiRequester): DialogMethods {
  return {
    select: (title, options, opts) =>
      request(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        readValue,
        opts?.timeout,
        opts?.signal,
      ),
    confirm: (title, message, opts) =>
      request(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        readConfirmed,
        opts?.timeout,
        opts?.signal,
      ),
    confirmLocalized: (title, message, localization, opts) =>
      request(
        { method: "confirm", title, message, localization, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        readConfirmed,
        opts?.timeout,
        opts?.signal,
      ),
    input: (title, placeholder, opts) =>
      request(
        {
          method: "input",
          title,
          ...(placeholder !== undefined ? { placeholder } : {}),
          ...(opts?.timeout ? { timeout: opts.timeout } : {}),
        },
        undefined,
        readValue,
        opts?.timeout,
        opts?.signal,
      ),
    editor: (title, prefill, opts) =>
      request(
        {
          method: "editor",
          title,
          ...(prefill !== undefined ? { prefill } : {}),
          ...(opts?.timeout ? { timeout: opts.timeout } : {}),
        },
        undefined,
        readValue,
        opts?.timeout,
        opts?.signal,
      ),
    askQuestions: (questions, opts) =>
      request(
        { method: "ask", questions, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => ("answers" in response ? response.answers : undefined),
        opts?.timeout,
        opts?.signal,
      ),
  };
}
