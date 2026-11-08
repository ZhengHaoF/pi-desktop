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

/// One entry of the relay's host directory (multi-PC selector).
class RemoteHostInfo {
  final String id;
  final String? label;
  final bool online;
  final int? lastSeenAt;
  RemoteHostInfo({required this.id, required this.label, required this.online, required this.lastSeenAt});

  String get displayName => (label != null && label!.trim().isNotEmpty) ? label! : id;
}

class RemoteConnection {
  final String relayUrl; // ws://host:port/ws
  final String deviceId;
  final String deviceLabel;

  WebSocketChannel? _channel;
  String? _hostId;
  /// Device-chosen target host (multi-PC); falls back to the relay's first
  /// online host when null.
  String? _preferredHostId;
  List<RemoteHostInfo> _knownHosts = const [];
  LinkState state = LinkState.disconnected;
  /// hello_ack received? Until then only `hello` may leave; routed payloads
  /// (request/subscribe) queue — the relay drops frames without hostId.
  bool _helloAcked = false;
  bool _userDisconnected = false;
  Timer? _reconnectTimer;
  final _outbox = <Object>[];
  final _stateController = StreamController<LinkState>.broadcast();
  final _eventsController = StreamController<RemoteSessionEvent>.broadcast();
  final _pending = <String, Completer<Map<String, dynamic>>>{};
  final _random = Random.secure();
  int _requestSeq = 0;

  RemoteConnection({required this.relayUrl, required this.deviceId, required this.deviceLabel});

  Stream<LinkState> get onState => _stateController.stream;
  Stream<RemoteSessionEvent> get onEvent => _eventsController.stream;
  bool get isReady => state == LinkState.ready;
  String? get hostId => _hostId;
  List<RemoteHostInfo> get knownHosts => List.unmodifiable(_knownHosts);
  String? get preferredHostId => _preferredHostId;

  /// 当前目标主机是否已知且离线（离线时请求会直接失败，不再等 30s 超时）。
  bool get isTargetHostOffline {
    final id = _hostId;
    if (id == null || _knownHosts.isEmpty) return false;
    for (final host in _knownHosts) {
      if (host.id == id) return !host.online;
    }
    return false;
  }

  /// Manual reconnect (settings page): drop the link and dial again.
  Future<void> reconnect() async {
    disconnect();
    _userDisconnected = false;
    await connect();
  }

  /// 多 PC：切换目标主机并刷新 hello_ack（后续 RPC 自动路由到新 host）。
  Future<void> selectHost(String hostId) async {
    _preferredHostId = hostId;
    // Re-handshake: hello_ack re-resolves hostId, including offline targets
    // (frames route-drop until that PC comes back online).
    await reconnect();
  }

  /// 多 PC：向 relay 请求最新主机目录。
  void refreshHosts() {
    _sendEnvelopeWithControl('hosts.list', {'kind': 'hosts.list'});
  }

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
      _scheduleReconnect();
      throw StateError('relay connect failed: $err');
    }
    channel.stream.listen(
      (data) => _onFrame(data is String ? data : utf8.decode(data as List<int>)),
      onDone: () => _onLinkDown('link closed'),
      onError: (_) => _onLinkDown('link error'),
    );
    // Ready only after the relay confirms the hello and hands us a hostId;
    // queued payloads flush then (see _onFrame / _sendEnvelope).
    _sendEnvelope(helloPayload(role: 'device', label: deviceLabel));
  }

  /// PC host restarts change the hostId; a stale id makes the relay drop
  /// every routed frame, so reconnect (fresh hello → fresh hostId) on any
  /// link loss unless the user disconnected on purpose.
  void _onLinkDown(String reason) {
    _helloAcked = false;
    _outbox.clear();
    _failPending(reason);
    _setState(LinkState.disconnected);
    _scheduleReconnect();
  }

  void _failPending(String reason) {
    for (final completer in _pending.values) {
      if (!completer.isCompleted) completer.completeError(StateError('not connected: $reason'));
    }
    _pending.clear();
  }

  void _scheduleReconnect() {
    if (_userDisconnected) return;
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(const Duration(seconds: 2), () {
      if (_userDisconnected) return;
      connect().catchError((_) {});
    });
  }

  void disconnect() {
    _userDisconnected = true;
    _reconnectTimer?.cancel();
    _channel?.sink.close();
    _channel = null;
    _helloAcked = false;
    _outbox.clear();
    _failPending('disconnected');
    _setState(LinkState.disconnected);
  }

  String _nextNonce() {
    final bytes = List<int>.generate(12, (_) => _random.nextInt(256));
    return base64UrlEncode(bytes);
  }

  void _sendEnvelope(Object payload) {
    final isHello = payload is Map && payload['kind'] == 'hello';
    if (!_helloAcked && !isHello) {
      // Relay drops routed frames lacking hostId; hold them until the
      // handshake completes.
      _outbox.add(payload);
      return;
    }
    final envelope = RemoteEnvelope(
      traceId: _nextNonce(),
      nonce: _nextNonce(),
      role: 'device',
      deviceId: deviceId,
      hostId: _hostId,
      payload: payload,
    );
    _channel?.sink.add(envelope.encode());
  }

  /// Envelope-level control frame (e.g. hosts.list): no payload routing, so
  /// it may leave before hello completes.
  void _sendEnvelopeWithControl(String control, Object payload) {
    final envelope = RemoteEnvelope(
      traceId: _nextNonce(),
      nonce: _nextNonce(),
      role: 'device',
      deviceId: deviceId,
      control: control,
      payload: payload,
    );
    _channel?.sink.add(envelope.encode());
  }

  void _flushOutbox() {
    if (_outbox.isEmpty) return;
    final queued = List<Object>.of(_outbox);
    _outbox.clear();
    for (final payload in queued) {
      _sendEnvelope(payload);
    }
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
        // Handshake confirmed. The relay tells us which host to address
        // (spec §4); every routed envelope must carry this hostId or the
        // relay closes the link with "missing target id". 多 PC：ack 还带
        // 已知主机目录（在线+离线），供设备选择器展示/切换；设备已指定的
        // preferredHostId 优先于 relay 的第一台在线主机。
        final hosts = payload['hosts'];
        if (hosts is List) {
          _knownHosts = [
            for (final h in hosts)
              if (h is Map)
                RemoteHostInfo(
                  id: h['id'] as String? ?? '',
                  label: h['label'] as String?,
                  online: h['online'] == true,
                  lastSeenAt: h['lastSeenAt'] as int?,
                ),
          ];
        }
        final hid = payload['hostId'];
        String? resolved = hid is String && hid.isNotEmpty ? hid : null;
        if (_preferredHostId != null &&
            _knownHosts.any((h) => h.id == _preferredHostId) &&
            resolved != _preferredHostId) {
          resolved = _preferredHostId;
        }
        if (resolved != null && resolved.isNotEmpty && resolved != _hostId) {
          _hostId = resolved;
        }
        if (!_helloAcked) {
          _helloAcked = true;
          _setState(LinkState.ready);
          _flushOutbox();
        }
        break;
      case 'hosts.list.result':
        final hosts = payload['hosts'];
        if (hosts is List) {
          _knownHosts = [
            for (final h in hosts)
              if (h is Map)
                RemoteHostInfo(
                  id: h['id'] as String? ?? '',
                  label: h['label'] as String?,
                  online: h['online'] == true,
                  lastSeenAt: h['lastSeenAt'] as int?,
                ),
          ];
        }
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
  /// While the handshake is still in flight the frame queues (flushed on
  /// hello_ack), so callers may fire immediately after connect().
  Future<Map<String, dynamic>> request(String method, Object? params) async {
    if (!isMethodAllowed(method)) {
      throw StateError('method not allowed: $method');
    }
    if (state == LinkState.disconnected) throw StateError('not connected');
    // 目标电脑离线：relay 会丢弃路由帧，等 30s 超时对用户毫无意义。
    if (isTargetHostOffline) throw StateError('所选电脑当前离线，等待它重新上线');
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

  /// Subscribe to a session's event stream (explicit key only). Queues while
  /// the handshake is in flight, like request().
  Future<void> subscribe(String topic, String key) async {
    if (!isSubscriptionAllowed(topic, key)) {
      throw StateError('subscription denied: $topic/$key');
    }
    if (state == LinkState.disconnected) throw StateError('not connected');
    final id = 'sub-${++_requestSeq}';
    _sendEnvelope({'kind': 'subscribe', 'id': id, 'topic': topic, 'key': key});
  }

  Future<void> unsubscribe(String topic, String key) async {
    final id = 'unsub-${++_requestSeq}';
    _sendEnvelope({'kind': 'unsubscribe', 'id': id, 'topic': topic, 'key': key});
  }
}
