/**
 * Remote Gateway policy — deny-by-default enforcement on the PC side.
 * Mirrors packages/protocol/src/allowlist.ts; the Gateway is enforcement
 * point 1 (the Relay is point 2). Remote plane forbids wildcard
 * subscriptions and every non-allowlisted method / command / topic.
 * Spec: docs/remote-control-plan.md §4.2, §7.3
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

export function isMethodAllowed(method: string): boolean {
  return ALLOWED_REQUEST_METHODS.includes(method);
}

export function isAgentCommandTypeAllowed(type: string): boolean {
  return ALLOWED_AGENT_COMMAND_TYPES.includes(type);
}

export function isTopicAllowed(topic: string): boolean {
  return ALLOWED_STREAM_TOPICS.includes(topic);
}

export function isSubscriptionAllowed(topic: string, key: string): boolean {
  return isTopicAllowed(topic) && key !== "*" && key.trim().length > 0;
}

/** Guard applied to agent.command payloads before forwarding into the RPC. */
export function isAgentCommandPayloadAllowed(params: unknown): boolean {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const body = params as { sessionId?: unknown; command?: unknown };
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0) return false;
  if (!body.command || typeof body.command !== "object" || Array.isArray(body.command)) return false;
  const type = (body.command as { type?: unknown }).type;
  return typeof type === "string" && isAgentCommandTypeAllowed(type);
}
