/// Remote connection: outbound WebSocket to the Relay, hello handshake,
/// request/response correlation, subscription bookkeeping. M1a talks plain
/// JSON envelopes (diagnostic relay mode); E2EE arrives in M1b.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../protocol/wire.dart';

enum LinkState { disconnected, connecting, ready }

class RemoteSessionEvent {
  final String topic;
  final String key;
  final Object? data;
  RemoteSessionEvent(this.topic, this.key, this.data);
}

class RemoteConnection {
  final String relayUrl; // ws://host:port/ws
  final String deviceId;
  final String deviceLabel;

  WebSocketChannel? _channel;
  LinkState state = LinkState.disconnected;
  final _stateController = StreamController<LinkState>.broadcast();
  final _eventsController = StreamController<RemoteSessionEvent>.broadcast();
  final _pending = <String, Completer<Map<String, dynamic>>>{};
  final _random = Random.secure();
  int _requestSeq = 0;

  RemoteConnection({required this.relayUrl, required this.deviceId, required this.deviceLabel});

  Stream<LinkState> get onState => _stateController.stream;
  Stream<RemoteSessionEvent> get onEvent => _eventsController.stream;
  bool get isReady => state == LinkState.ready;

  void _setState(LinkState next) {
    state = next;
    _stateController.add(next);
  }

  Future<void> connect() async {
    if (state == LinkState.ready || state == LinkState.connecting) return;
    _setState(LinkState.connecting);
    final uri = Uri.parse('$relayUrl?role=device');
    final channel = WebSocketChannel.connect(uri);
    _channel = channel;
    try {
      await channel.ready;
    } catch (err) {
      _setState(LinkState.disconnected);
      throw StateError('relay connect failed: $err');
    }
    _setState(LinkState.ready);
    channel.stream.listen(
      (data) => _onFrame(data is String ? data : utf8.decode(data as List<int>)),
      onDone: () => _setState(LinkState.disconnected),
      onError: (_) => _setState(LinkState.disconnected),
    );
    _sendEnvelope(helloPayload(role: 'device', label: deviceLabel));
  }

  void disconnect() {
    _channel?.sink.close();
    _channel = null;
    _setState(LinkState.disconnected);
  }

  String _nextNonce() {
    final bytes = List<int>.generate(12, (_) => _random.nextInt(256));
    return base64UrlEncode(bytes);
  }

  void _sendEnvelope(Object payload) {
    final envelope = RemoteEnvelope(
      traceId: _nextNonce(),
      nonce: _nextNonce(),
      role: 'device',
      deviceId: deviceId,
      payload: payload,
    );
    _channel?.sink.add(envelope.encode());
  }

  void _onFrame(String text) {
    Map<String, dynamic> envelope;
    try {
      envelope = jsonDecode(text) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    if (envelope['v'] != protocolVersion) return;
    final payload = envelope['payload'];
    if (payload is! Map<String, dynamic>) return;
    switch (payload['kind']) {
      case 'hello_ack':
        // Handshake confirmed; nothing further needed in M1a.
        break;
      case 'event':
        final event = WireEvent.fromJson(payload);
        _eventsController.add(RemoteSessionEvent(event.topic, event.key, event.data));
        break;
      case 'response':
        final response = WireResponse.fromJson(payload);
        final completer = _pending.remove(response.id);
        if (completer != null && !completer.isCompleted) {
          if (response.ok) {
            completer.complete(response.result == null ? <String, dynamic>{} : Map<String, dynamic>.from(response.result as Map));
          } else {
            completer.completeError(StateError(response.error?['message'] ?? 'rpc error'));
          }
        }
        break;
      default:
        break;
    }
  }

  /// Allowlist-checked request; denies client-side before anything is sent.
  Future<Map<String, dynamic>> request(String method, Object? params) async {
    if (!isMethodAllowed(method)) {
      throw StateError('method not allowed: $method');
    }
    if (!isReady) throw StateError('not connected');
    final id = 'req-${++_requestSeq}-$_nextNonce';
    final completer = Completer<Map<String, dynamic>>();
    _pending[id] = completer;
    _sendEnvelope(WireRequest(id, method, params).toJson());
    return completer.future.timeout(const Duration(seconds: 30));
  }

  /// agent.command with an allowlist check on the command type.
  Future<Map<String, dynamic>> agentCommand(String sessionId, Map<String, dynamic> command) async {
    final type = command['type'] as String?;
    if (type == null || !isAgentCommandTypeAllowed(type)) {
      throw StateError('agent command type not allowed: $type');
    }
    return request('agent.command', {'sessionId': sessionId, 'command': command});
  }

  /// Subscribe to a session's event stream (explicit key only).
  Future<void> subscribe(String topic, String key) async {
    if (!isSubscriptionAllowed(topic, key)) {
      throw StateError('subscription denied: $topic/$key');
    }
    final id = 'sub-${++_requestSeq}';
    _sendEnvelope({'kind': 'subscribe', 'id': id, 'topic': topic, 'key': key});
  }

  Future<void> unsubscribe(String topic, String key) async {
    final id = 'unsub-${++_requestSeq}';
    _sendEnvelope({'kind': 'unsubscribe', 'id': id, 'topic': topic, 'key': key});
  }
}
