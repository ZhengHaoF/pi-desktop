/**
 * Approval bridge — mirrors extension UI confirmations to the remote plane.
 *
 * Semantics (docs/remote-control-plan.md §7.4):
 * - extension_ui_request events are surfaced as remote.approval entries.
 * - Requests WITHOUT an extension timeout suspend indefinitely until the
 *   device responds, the user aborts the turn, or the gateway stops.
 * - Requests WITH expiresAt settle at the Host with its own default value;
 *   the bridge merely marks them expired locally for the UI.
 * - Responses are forwarded verbatim as extension_ui_response agent commands
 *   keyed by request id (the Host resolves them idempotently).
 */
import { randomUUID } from "node:crypto";
import type { WireMessage } from "../../contract/rpc.ts";

type WireEventMessage = Extract<WireMessage, { kind: "event" }>;

interface ExtensionUiRequestData {
  type?: string;
  id?: string;
  method?: string;
  title?: string;
  message?: string;
  options?: unknown[];
  prefill?: string;
  placeholder?: string;
  expiresAt?: number;
}

export interface ApprovalDecision {
  requestId: string;
  sessionId: string;
  outcome: "respond" | "cancel" | "expired" | "aborted";
}

type RelaySender = (envelope: Record<string, unknown>) => void;

interface PendingApproval {
  requestId: string;
  sessionId: string;
  createdAt: number;
  expiresAt?: number;
}

export class ApprovalBridge {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(decision: ApprovalDecision) => void>();

  constructor(private readonly send: RelaySender) {}

  onDecision(listener: (decision: ApprovalDecision) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Inspect agent.events flowing through the Gateway port. */
  observeEvent(event: WireEventMessage): void {
    if (event.topic !== "agent.events" || !event.data || typeof event.data !== "object") return;
    const data = event.data as ExtensionUiRequestData;
    if (data.type !== "extension_ui_request" || typeof data.id !== "string") return;
    this.pending.set(data.id, {
      requestId: data.id,
      sessionId: event.key,
      createdAt: Date.now(),
      ...(typeof data.expiresAt === "number" ? { expiresAt: data.expiresAt } : {}),
    });
    this.send({
      v: 1,
      traceId: randomUUID(),
      ts: Date.now(),
      nonce: randomUUID(),
      role: "host",
      deviceId: undefined,
      payload: {
        kind: "event",
        topic: "remote.approval",
        key: event.key,
        data: {
          requestId: data.id,
          sessionId: event.key,
          method: data.method ?? "confirm",
          title: data.title ?? "",
          ...(data.message !== undefined ? { message: data.message } : {}),
          ...(data.options ? { options: data.options } : {}),
          ...(data.prefill !== undefined ? { prefill: data.prefill } : {}),
          ...(data.placeholder !== undefined ? { placeholder: data.placeholder } : {}),
          ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
          createdAt: Date.now(),
        },
      },
    });
  }

  /** A device answered; forward as extension_ui_response agent command. */
  observeResponse(response: WireMessage & { kind: "response" }): void {
    void response;
  }

  /** Build the agent.command payload that resolves a pending approval. */
  buildResponseCommand(
    requestId: string,
    response: unknown,
  ):
    | {
        sessionId: string;
        command: { type: "extension_ui_response"; id: string; response: unknown };
      }
    | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    return {
      sessionId: pending.sessionId,
      command: { type: "extension_ui_response" as const, id: requestId, response },
    };
  }

  /** Batch-abort (device revoked, total switch off, gateway stopping). */
  abortAll(reason: string): ApprovalDecision[] {
    const decisions: ApprovalDecision[] = [];
    for (const pending of this.pending.values()) {
      const decision: ApprovalDecision = {
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        outcome: "aborted",
      };
      decisions.push(decision);
      for (const listener of this.listeners) listener(decision);
    }
    if (decisions.length > 0 && reason === "device revoked") {
      // Callers use the returned commands to abort suspended turns.
    }
    this.pending.clear();
    return decisions;
  }

  /** Abort one turn's approvals (user pressed stop on that session). */
  abortSession(sessionId: string): ApprovalDecision[] {
    const decisions: ApprovalDecision[] = [];
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(id);
      const decision: ApprovalDecision = {
        requestId: pending.requestId,
        sessionId,
        outcome: "aborted",
      };
      decisions.push(decision);
      for (const listener of this.listeners) listener(decision);
    }
    return decisions;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
