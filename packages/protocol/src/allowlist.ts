/**
 * Method / topic / command allowlist — the deny-by-default policy surface.
 * Shared by Gateway (enforcement point 1) and Relay (enforcement point 2).
 * Spec: docs/remote-control-plan.md §4.2
 */

export const ALLOWED_REQUEST_METHODS: readonly string[] = [
  "sessions.list",
  "sessions.get",
  "sessions.context",
  "sessions.contextPage",
  "sessions.entryContent",
  "sessions.executions",
  "sessions.executionContent",
  "agent.new",
  "agent.command",
  "files.list",
  "files.meta",
  "files.read",
  "files.preview",
  "system.runningCount",
];

export const ALLOWED_AGENT_COMMAND_TYPES: readonly string[] = [
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "get_state",
  "clear_queue",
  "set_model",
  "set_thinking_level",
  "extension_ui_response",
  "extension_ui_input",
  "compact",
];

export const ALLOWED_STREAM_TOPICS: readonly string[] = [
  "agent.events",
  "agent.running",
  "sessions.changed",
  "files.changed",
  "remote.approval",
];

export const FORBIDDEN_METHOD_PREFIXES: readonly string[] = [
  "mcp.oauth",
  "channelSecrets",
  "channels.",
  "herdr.",
  "managedProcesses.",
  "desktop.",
  "updates.",
  "auth.",
  "models.",
  "settings.",
  "skills.",
  "plugins.",
  "worktrees.",
  "browser.",
];

export const FORBIDDEN_REQUEST_METHODS: readonly string[] = [
  "sessions.delete",
  "sessions.rename",
  "sessions.export",
  "files.download",
  "files.write",
  "agent.delete",
  "system.allowRoot",
  "system.validateCwd",
];

export function isMethodAllowed(method: string): boolean {
  if (FORBIDDEN_REQUEST_METHODS.includes(method)) return false;
  if (FORBIDDEN_METHOD_PREFIXES.some((prefix) => method === prefix || method.startsWith(prefix))) {
    return false;
  }
  return ALLOWED_REQUEST_METHODS.includes(method);
}

export function isAgentCommandTypeAllowed(type: string): boolean {
  return ALLOWED_AGENT_COMMAND_TYPES.includes(type);
}

export function isTopicAllowed(topic: string): boolean {
  return ALLOWED_STREAM_TOPICS.includes(topic);
}

/**
 * Wildcard subscriptions are forbidden on the remote plane: a device must
 * subscribe with an explicit sessionId key. The desktop renderer may use "*"
 * for its own global topics; the Gateway must reject any remote subscribe
 * whose key is "*".
 */
export function isSubscriptionAllowed(topic: string, key: string): boolean {
  return isTopicAllowed(topic) && key !== "*" && key.trim().length > 0;
}

/** Guard applied to agent.command payloads before forwarding. */
export function isAgentCommandPayloadAllowed(params: unknown): boolean {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const body = params as { sessionId?: unknown; command?: unknown };
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0) return false;
  if (!body.command || typeof body.command !== "object" || Array.isArray(body.command)) return false;
  const type = (body.command as { type?: unknown }).type;
  return typeof type === "string" && isAgentCommandTypeAllowed(type);
}
