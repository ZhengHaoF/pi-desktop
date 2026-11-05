/**
 * Append-only metadata audit log. Never records message payloads — only
 * actor, action, outcome and an HMAC digest of the target identifiers.
 */
import { createHmac, randomBytes } from "node:crypto";

export type AuditAction =
  | "hello.accept"
  | "hello.reject"
  | "pair.request"
  | "pair.approve"
  | "pair.reject"
  | "device.revoke"
  | "route.forward"
  | "policy.deny"
  | "rate.limit"
  | "replay.deny"
  | "cipher.violation";

export interface AuditEvent {
  id: string;
  ts: number;
  actor: string;
  action: AuditAction;
  targetDigest: string;
  outcome: "ok" | "denied" | "error";
  traceId: string;
}

export class AuditLog {
  private readonly key: Buffer;
  readonly events: AuditEvent[] = [];

  constructor(key = randomBytes(32)) {
    this.key = key;
  }

  digest(...parts: (string | undefined)[]): string {
    return createHmac("sha256", this.key).update(parts.filter(Boolean).join("\u0000")).digest("hex").slice(0, 24);
  }

  append(event: Omit<AuditEvent, "id" | "ts">): AuditEvent {
    const full: AuditEvent = { ...event, id: randomBytes(12).toString("hex"), ts: Date.now() };
    this.events.push(full);
    if (this.events.length > 5_000) this.events.shift();
    return full;
  }
}
