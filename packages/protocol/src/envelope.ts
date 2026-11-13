/**
 * Remote control wire protocol — single source of truth (M0).
 * Spec: docs/remote-protocol.md
 *
 * Envelope carries either a plaintext WireMessage (local/diagnostic mode,
 * never allowed on public relays) or a base64 ciphertext string produced by
 * the E2EE layer (X25519 + AES-GCM). The Relay only ever sees ciphertext.
 */
import { Type, type Static, type TSchema } from "typebox";

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Wire messages — mirrors src/contract/rpc.ts kinds
// ---------------------------------------------------------------------------

export const WireRequest = Type.Object({
  kind: Type.Literal("request"),
  id: Type.String({ minLength: 1 }),
  method: Type.String({ minLength: 1 }),
  params: Type.Unknown(),
});

export const WireResponse = Type.Object({
  kind: Type.Literal("response"),
  id: Type.String({ minLength: 1 }),
  ok: Type.Boolean(),
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(
    Type.Object({
      code: Type.String(),
      message: Type.String(),
      detail: Type.Optional(Type.Unknown()),
    }),
  ),
});

export const WireEvent = Type.Object({
  kind: Type.Literal("event"),
  topic: Type.String({ minLength: 1 }),
  key: Type.String({ minLength: 1 }),
  data: Type.Unknown(),
});

export const WireSubscribe = Type.Object({
  kind: Type.Literal("subscribe"),
  id: Type.String({ minLength: 1 }),
  topic: Type.String({ minLength: 1 }),
  key: Type.String({ minLength: 1 }),
});

export const WireUnsubscribe = Type.Object({
  kind: Type.Literal("unsubscribe"),
  id: Type.String({ minLength: 1 }),
  topic: Type.String({ minLength: 1 }),
  key: Type.String({ minLength: 1 }),
});

export const WireMessage = Type.Union([WireRequest, WireResponse, WireEvent, WireSubscribe, WireUnsubscribe]);

export type WireRequestMessage = Static<typeof WireRequest>;
export type WireResponseMessage = Static<typeof WireResponse>;
export type WireEventMessage = Static<typeof WireEvent>;
export type WireSubscribeMessage = Static<typeof WireSubscribe>;
export type WireUnsubscribeMessage = Static<typeof WireUnsubscribe>;
export type WireMessageValue = Static<typeof WireMessage>;

// ---------------------------------------------------------------------------
// E2EE cipher block — present whenever payload is ciphertext
// ---------------------------------------------------------------------------

export const CipherBlock = Type.Object({
  alg: Type.Literal("x25519-aes-gcm"),
  /** Identifier of the device session key used to encrypt. */
  keyId: Type.String({ minLength: 1 }),
  /** Base64 AES-GCM initialization vector. */
  iv: Type.String({ minLength: 1 }),
  /** Base64 AES-GCM auth tag (appended or separate per implementation). */
  tag: Type.String({ minLength: 1 }),
});

export type CipherBlockValue = Static<typeof CipherBlock>;

// ---------------------------------------------------------------------------
// RemoteEnvelope
// ---------------------------------------------------------------------------

export const RemoteEnvelope = Type.Object({
  v: Type.Integer({ minimum: 1, maximum: 1 }),
  traceId: Type.String({ minLength: 1 }),
  ts: Type.Integer({ minimum: 0 }),
  nonce: Type.String({ minLength: 1 }),
  role: Type.Union([Type.Literal("host"), Type.Literal("device")]),
  deviceId: Type.Optional(Type.String({ minLength: 1 })),
  hostId: Type.Optional(Type.String({ minLength: 1 })),
  /** Sender's base64 X25519 public key — binds the E2EE shared secret. */
  e2eePub: Type.Optional(Type.String({ minLength: 1 })),
  cipher: Type.Optional(CipherBlock),
  payload: Type.Union([WireMessage, Type.String({ minLength: 1 })]),
});

export type RemoteEnvelopeValue = Static<typeof RemoteEnvelope>;

// ---------------------------------------------------------------------------
// Hello / version negotiation (sent as the first plaintext-controlled frame;
// its payload travels inside the envelope like everything else)
// ---------------------------------------------------------------------------

export const HelloPayload = Type.Object({
  kind: Type.Literal("hello"),
  protocolVersion: Type.Integer({ minimum: 1 }),
  role: Type.Union([Type.Literal("host"), Type.Literal("device")]),
  appVersion: Type.String({ minLength: 1 }),
  /** Device display name (device role) or host label (host role). */
  label: Type.Optional(Type.String({ maxLength: 120 })),
  /** Opaque authentication block; interpreted by the Relay auth layer. */
  auth: Type.Record(Type.String(), Type.Unknown()),
});

export type HelloPayloadValue = Static<typeof HelloPayload>;

export const HelloAckPayload = Type.Object({
  kind: Type.Literal("hello_ack"),
  protocolVersion: Type.Integer({ minimum: 1 }),
  hostId: Type.Optional(Type.String({ minLength: 1 })),
  /** True when the relay enforces E2EE for this connection. */
  cipherRequired: Type.Boolean(),
});

export type HelloAckPayloadValue = Static<typeof HelloAckPayload>;

// ---------------------------------------------------------------------------
// Pending approval mirror (topic "remote.approval")
// ---------------------------------------------------------------------------

/** One selectable answer offered by an ask request. */
export const AskOptionData = Type.Object({
  label: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
});

/** One question carried by an ask request (desktop ask_question tool). */
export const AskQuestionData = Type.Object({
  header: Type.Optional(Type.String()),
  question: Type.String({ minLength: 1 }),
  options: Type.Array(AskOptionData, { minItems: 1 }),
  multiSelect: Type.Optional(Type.Boolean()),
});

export type AskQuestionDataValue = Static<typeof AskQuestionData>;

/** One answered question; `selected` may be empty when only free text was given. */
export const AskAnswerData = Type.Object({
  header: Type.Optional(Type.String()),
  question: Type.String({ minLength: 1 }),
  selected: Type.Array(Type.String()),
  other: Type.Optional(Type.String()),
});

export type AskAnswerDataValue = Static<typeof AskAnswerData>;

/** Dialog methods mirrored from extension/agent UI requests. */
export const ApprovalRequestData = Type.Union([
  Type.Object({
    requestId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    method: Type.Union([
      Type.Literal("confirm"),
      Type.Literal("select"),
      Type.Literal("input"),
      Type.Literal("editor"),
    ]),
    title: Type.String(),
    message: Type.Optional(Type.String()),
    options: Type.Optional(Type.Array(Type.String())),
    prefill: Type.Optional(Type.String()),
    placeholder: Type.Optional(Type.String()),
    /** Present only when the extension supplied its own timeout. */
    expiresAt: Type.Optional(Type.Integer({ minimum: 0 })),
    createdAt: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({
    requestId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    method: Type.Literal("ask"),
    /** The model-supplied question text; each question carries its own wording. */
    title: Type.Optional(Type.String()),
    questions: Type.Array(AskQuestionData, { minItems: 1 }),
    expiresAt: Type.Optional(Type.Integer({ minimum: 0 })),
    createdAt: Type.Integer({ minimum: 0 }),
  }),
]);

export type ApprovalRequestDataValue = Static<typeof ApprovalRequestData>;

export const ApprovalResponseData = Type.Object({
  requestId: Type.String({ minLength: 1 }),
  action: Type.Union([Type.Literal("respond"), Type.Literal("cancel")]),
  /** extension_ui_response body: { value } | { confirmed } | { cancelled } */
  response: Type.Optional(Type.Unknown()),
  /** ask payload; one entry per question, in request order. */
  answers: Type.Optional(Type.Array(AskAnswerData)),
});

export type ApprovalResponseDataValue = Static<typeof ApprovalResponseData>;

/** Sent when a mirrored request settles anywhere (desktop answered, timeout, abort). */
export const ApprovalResolvedData = Type.Object({
  requestId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  resolved: Type.Literal(true),
});

export type ApprovalResolvedDataValue = Static<typeof ApprovalResolvedData>;

// ---------------------------------------------------------------------------
// Reliability constants shared by all three ends
// ---------------------------------------------------------------------------

export const RELIABILITY = {
  /** WS ping/pong interval. */
  heartbeatIntervalMs: 15_000,
  /** Consecutive missed pongs before the peer is considered offline. */
  heartbeatMaxMisses: 3,
  /** Sliding window for request id de-duplication. */
  idempotencyWindowMs: 5 * 60_000,
  /** Max buffered events per connection before backpressure kicks in. */
  bufferMaxMessages: 512,
  /** Max buffered bytes per connection. */
  bufferMaxBytes: 2 * 1024 * 1024,
  /** Client-side render throttle target; matches SessionEventBatcher. */
  renderThrottleHz: 20,
  /** Max envelope timestamp drift tolerated for replay protection. */
  replayWindowMs: 2 * 60_000,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isCipherRequiredEnvelope(envelope: RemoteEnvelopeValue): boolean {
  return typeof envelope.payload === "string" && envelope.cipher !== undefined;
}

export function schemaOf<T extends TSchema>(schema: T): TSchema {
  return schema;
}
