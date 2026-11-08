/// Wire protocol mirrors of packages/protocol/src/envelope.ts (M1a subset).
/// Kept hand-written with contract tests in test/protocol_test.dart; the
/// golden JSON fixtures match the TypeScript side.
library;

import 'dart:convert';

const int protocolVersion = 1;

class WireRequest {
  final String id;
  final String method;
  final Object? params;
  WireRequest(this.id, this.method, this.params);

  Map<String, dynamic> toJson() => {'kind': 'request', 'id': id, 'method': method, 'params': params};
}

class WireResponse {
  final String id;
  final bool ok;
  final Object? result;
  final Map<String, dynamic>? error;
  WireResponse(this.id, this.ok, {this.result, this.error});

  factory WireResponse.fromJson(Map<String, dynamic> json) => WireResponse(
        json['id'] as String,
        json['ok'] as bool,
        result: json['result'],
        error: json['error'] == null ? null : Map<String, dynamic>.from(json['error'] as Map),
      );
}

class WireEvent {
  final String topic;
  final String key;
  final Object? data;
  WireEvent(this.topic, this.key, this.data);

  factory WireEvent.fromJson(Map<String, dynamic> json) => WireEvent(
        json['topic'] as String,
        json['key'] as String,
        json['data'],
      );
}

/// RemoteEnvelope minus the cipher block — M1a talks to a local/plain relay
/// (diagnostic mode); E2EE arrives with the gateway cipher layer in M1b.
class RemoteEnvelope {
  final int v;
  final String traceId;
  final int ts;
  final String nonce;
  final String role; // host | device | relay
  final String? deviceId;
  final String? hostId;
  /// Envelope-level control kind (e.g. "hosts.list") — relay-local, no payload.
  final String? control;
  final Object? payload; // WireMessage or hello map

  RemoteEnvelope({
    required this.traceId,
    required this.nonce,
    required this.role,
    required this.payload,
    this.deviceId,
    this.hostId,
    this.control,
    this.v = protocolVersion,
    int? ts,
  }) : ts = ts ?? DateTime.now().millisecondsSinceEpoch;

  Map<String, dynamic> toJson() => {
        'v': v,
        'traceId': traceId,
        'ts': ts,
        'nonce': nonce,
        'role': role,
        if (deviceId != null) 'deviceId': deviceId,
        if (hostId != null) 'hostId': hostId,
        if (control != null) 'control': control,
        'payload': payload,
      };

  static RemoteEnvelope fromJson(Map<String, dynamic> json) => RemoteEnvelope(
        traceId: json['traceId'] as String,
        nonce: json['nonce'] as String,
        role: json['role'] as String,
        payload: json['payload'],
        deviceId: json['deviceId'] as String?,
        hostId: json['hostId'] as String?,
        v: json['v'] as int? ?? protocolVersion,
        ts: json['ts'] as int?,
      );

  String encode() => jsonEncode(toJson());
}

Map<String, dynamic> helloPayload({required String role, required String label}) => {
      'kind': 'hello',
      'protocolVersion': protocolVersion,
      'role': role,
      'appVersion': '0.1.0',
      'label': label,
      'auth': <String, dynamic>{},
    };

/// Deny-by-default mirror of packages/protocol/src/allowlist.ts (client side).
const List<String> allowedRequestMethods = [
  'sessions.list',
  'sessions.get',
  'sessions.context',
  'sessions.contextPage',
  'sessions.entryContent',
  'sessions.executions',
  'sessions.executionContent',
  'agent.new',
  'agent.command',
  'agent.state',
  'files.list',
  'files.meta',
  'files.read',
  'files.preview',
  'system.runningCount',
  // Read-only model preferences for the set_model picker; mirrors
  // packages/protocol/src/allowlist.ts (mutating models.* stays forbidden).
  'models.preferences.get',
  // Read-only skill catalog for the "/" palette; session management parity.
  'skills.list',
  'sessions.rename',
  'sessions.delete',
];

const List<String> allowedAgentCommandTypes = [
  'prompt',
  'steer',
  'follow_up',
  'abort',
  'get_state',
  'clear_queue',
  'set_model',
  'set_thinking_level',
  'extension_ui_response',
  'extension_ui_input',
  'compact',
];

const List<String> allowedStreamTopics = [
  'agent.events',
  'agent.running',
  'sessions.changed',
  'files.changed',
  'remote.approval',
];

bool isMethodAllowed(String method) => allowedRequestMethods.contains(method);

bool isAgentCommandTypeAllowed(String type) => allowedAgentCommandTypes.contains(type);

bool isTopicAllowed(String topic) => allowedStreamTopics.contains(topic);

/// Devices must subscribe with an explicit sessionId; wildcards are denied.
bool isSubscriptionAllowed(String topic, String key) =>
    isTopicAllowed(topic) && key != '*' && key.trim().isNotEmpty;
