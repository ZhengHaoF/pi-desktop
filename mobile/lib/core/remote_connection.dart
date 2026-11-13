/// Remote connection: outbound WebSocket to the Relay, hello handshake,
/// request/response correlation, subscription bookkeeping. Routed payloads
/// are E2EE-sealed whenever the relay reports cipherRequired (hello/auth
/// stays plaintext by design — it carries no session content).
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:meta/meta.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../protocol/wire.dart';
import 'e2ee.dart';
import 'host_store.dart';

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
  /// Host's static X25519 public key (E2EE); null on older relays/PCs.
  final String? e2eePub;
  RemoteHostInfo({
    required this.id,
    required this.label,
    required this.online,
    required this.lastSeenAt,
    this.e2eePub,
  });

  String get displayName => (label != null && label!.trim().isNotEmpty) ? label! : id;
}

class RemoteConnection {
  final String relayUrl; // ws://host:port/ws
  final String deviceId;
  final String deviceLabel;
  /// 扫码带入的一次性配对令牌（首次配对用，成功后不再携带）。
  final String? pairingToken;
  /// hello_ack 之后令牌必然已被 relay 消费（或已无意义）：之后的重连不再
  /// 重放它——重放只会换来 4003 "pairing token rejected"，还会喂远端的
  /// 失败锁计数。长期凭证（deviceSecret）照常携带，重连靠它免扫码。
  @visibleForTesting
  bool pairingTokenSpent = false;
  /// 扫码载荷指定的目标 PC；hello 阶段即携带，配对绑定依赖它。
  final String? targetHostId;

  WebSocketChannel? _channel;
  String? _hostId;
  /// 已配对设备的长期凭证（relay 签发、本地持久化）。
  String? _deviceSecret;
  /// E2EE：本次连接的临时密钥对（每次 connect 重新生成，不落盘）。
  E2eeKeyPair? _deviceKeys;
  E2eeSeal? _seal;
  E2eeOpen? _open;
  /// hello_ack 要求密文且密钥就绪：之后的路由帧全部 E2EE。
  bool _cipherMode = false;
  String? _handshakeError;
  /// 服务器主动断链时的关闭码/原因（如 4003 "pairing required"）；用于在
  /// UI 呈现真实失败原因，而不是笼统的 "not connected"。
  int? _lastCloseCode;
  String? _lastCloseReason;
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

  RemoteConnection({
    required this.relayUrl,
    required this.deviceId,
    required this.deviceLabel,
    this.pairingToken,
    this.targetHostId,
  }) : _hostId = targetHostId;

  Stream<LinkState> get onState => _stateController.stream;
  Stream<RemoteSessionEvent> get onEvent => _eventsController.stream;
  bool get isReady => state == LinkState.ready;
  String? get hostId => _hostId;
  List<RemoteHostInfo> get knownHosts => List.unmodifiable(_knownHosts);
  String? get preferredHostId => _preferredHostId;
  /// E2EE 握手错误（如主机公钥与钉扎不符）；非 null 时链路已拒绝。
  String? get handshakeError => _handshakeError;
  /// 最近一次断链的 WebSocket 关闭码/原因（服务器拒绝时非 null）。
  int? get lastCloseCode => _lastCloseCode;
  String? get lastCloseReason => _lastCloseReason;

  /// 面向用户的最近一次失败原因：优先握手拒绝（E2EE/钉扎），其次服务器
  /// 主动断链（配对被拒、协议违规等），兜底 null。请求超时类错误不在此列。
  String? describeLastFailure() {
    if (_handshakeError != null) return _handshakeError;
    final reason = _lastCloseReason;
    if (_lastCloseCode == null) return null;
    switch (_lastCloseCode) {
      case 4003:
        return '配对失败：设备尚未配对或凭证已失效，请在电脑上重新扫码配对'
            '${reason == null || reason.isEmpty ? '' : '（$reason）'}';
      case 4002:
        return '连接被中继拒绝（协议违规）${reason == null || reason.isEmpty ? '' : '：$reason'}';
      case 4000:
        return '连接被中继拒绝（协议版本不匹配）：请更新手机端与电脑端到相同版本';
      case 4001:
        return '连接被中继拒绝（缺少设备标识）：请清除应用数据后重试';
      case 1008:
        return '连接被中继拒绝（请求频率超限），请稍后重试';
      default:
        return reason == null || reason.isEmpty ? null : '连接关闭（$_lastCloseCode）：$reason';
    }
  }

  /// 最近一次断链是否为配对被拒（4003）：首页据此给出"重新扫码"直达入口，
  /// 而不是让用户对着一成不变的红色横幅干等。
  bool get lastFailureWasPairingReject => _lastCloseCode == 4003;

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
    // Selecting the host we already target must NOT drop the in-memory
    // credential: right after a scan, the pairing hello_ack races the home
    // page's restore-selection call into here — clearing _deviceSecret (and
    // reconnecting before the async saveDeviceSecret lands on disk) discards
    // a just-issued secret. That 220ms re-hello replaying a consumed token
    // came from exactly this window.
    if (hostId == _hostId) return;
    // The credential is per host: point hello at the new target and reload
    // its own deviceSecret before re-handshaking.
    _hostId = hostId;
    _deviceSecret = null;
    await reconnect();
  }

  /// 多 PC：向 relay 请求最新主机目录。
  void refreshHosts() {
    _sendEnvelopeWithControl('hosts.list', {'kind': 'hosts.list'});
  }

  /// 让 relay 删掉本设备与某台电脑的配对绑定。手机端随后清本地凭证；
  /// 其他电脑的绑定不受影响。控制帧为明文元数据，在 cipher gate 之前处理。
  void unbindHost(String hostId) {
    _sendEnvelopeWithControl('pair.unbind', {'kind': 'pair.unbind', 'hostId': hostId});
  }

  void _setState(LinkState next) {
    state = next;
    _stateController.add(next);
  }

  Future<void> connect() async {
    if (state == LinkState.ready || state == LinkState.connecting) return;
    _setState(LinkState.connecting);
    final uri = Uri.parse('$relayUrl?role=device');
    // 30s 应用层心跳：dart:io 的 ping 无应答会主动断链并触发 onError——
    // 否则 NAT 超时/对端消失时 socket 半开，重连循环永远等不到 close 事件。
    final channel = IOWebSocketChannel.connect(uri, pingInterval: const Duration(seconds: 30));
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
    // Resolve the target before hello: the credential is scoped to
    // (device, host) and the relay validates it against the same hostId.
    // No legacy fallback — an upgraded phone must re-scan each PC once.
    _hostId ??= targetHostId ?? _preferredHostId ?? await loadPreferredHost();
    _deviceSecret = await loadDeviceSecret(
      deviceId,
      relayUrl: relayUrl,
      hostId: _hostId ?? '',
    );
    // E2EE: ephemeral X25519 key pair per connection; the host derives the
    // shared secret from our public key + its static key.
    _deviceKeys = await E2eeKeyPair.generate();
    _seal = null;
    _open = null;
    _cipherMode = false;
    _handshakeError = null;
    _lastCloseCode = null;
    _lastCloseReason = null;
    final auth = buildAuth(_deviceSecret);
    // Ready only after the relay confirms the hello and hands us a hostId;
    // queued payloads flush then (see _onFrame / _sendEnvelope).
    _sendEnvelope(helloPayload(role: 'device', label: deviceLabel, auth: auth, e2eePub: _deviceKeys!.publicKey));
  }

  /// PC host restarts change the hostId; a stale id makes the relay drop
  /// every routed frame, so reconnect (fresh hello → fresh hostId) on any
  /// link loss unless the user disconnected on purpose.
  void _onLinkDown(String reason) {
    // 服务器主动断链时 adapter 已收到 Close 帧：把关闭码/原因留在连接对象
    // 上（_lastCloseCode/_lastCloseReason），供 UI 呈现真实原因。注意
    // connect() 会在下次拨号时清空它们，所以这是"最近一次失败"的快照。
    _lastCloseCode = _channel?.closeCode;
    _lastCloseReason = _channel?.closeReason;
    // 带着一次性 token 被 4003 拒：该 token 已被消费/过期/不属于本
    // relay，重试永远不会成功，还会喂远端的失败锁计数——立即停用。
    if (shouldRetirePairingToken(_lastCloseCode, _lastCloseReason, pairingTokenSpent)) {
      pairingTokenSpent = true;
    }
    _helloAcked = false;
    _outbox.clear();
    _failPending(reason);
    _resetCipher();
    _setState(LinkState.disconnected);
    _scheduleReconnect();
  }

  void _resetCipher() {
    _seal = null;
    _open = null;
    _cipherMode = false;
    _deviceKeys = null;
    _sendChain = Future<void>.value();
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
    // 指数退避：relay 拒绝（如配对失败）时 2s 热循环只会空转并喂远端
    // 失败锁计数；握手成功后归零（见 hello_ack）。
    final delay = Duration(milliseconds: reconnectDelayMs(_reconnectAttempts));
    _reconnectAttempts += 1;
    _reconnectTimer = Timer(delay, () {
      if (_userDisconnected) return;
      connect().catchError((_) {});
    });
  }

  static const _reconnectBaseMs = 2000;
  static const _reconnectMaxMs = 60000;
  int _reconnectAttempts = 0;

  /// 重连退避曲线：2s、4s、8s、16s、32s，60s 封顶（attempt = 连续失败次数）。
  @visibleForTesting
  static int reconnectDelayMs(int attempt) {
    final step = attempt < 0 ? 0 : (attempt > 5 ? 5 : attempt);
    final ms = _reconnectBaseMs * (1 << step);
    return ms > _reconnectMaxMs ? _reconnectMaxMs : ms;
  }

  /// hello 的 auth 材料：长期凭证始终携带；一次性配对令牌只在未消费时带上。
  @visibleForTesting
  Map<String, dynamic> buildAuth(String? deviceSecret) => <String, dynamic>{
    if (deviceSecret != null && deviceSecret.isNotEmpty) 'deviceSecret': deviceSecret,
    if (!pairingTokenSpent && pairingToken != null && pairingToken!.isNotEmpty)
      'pairingToken': pairingToken,
  };

  /// 断链后是否应停用一次性配对令牌：只有"带着 token 被 4003 以
  /// `pairing token rejected` 拒绝"才算——token 已消费/过期/不属于本
  /// relay，再无重试价值。纯判定便于单测。
  @visibleForTesting
  static bool shouldRetirePairingToken(int? closeCode, String? closeReason, bool alreadySpent) {
    if (alreadySpent) return false;
    if (closeCode != 4003) return false;
    return closeReason != null && closeReason.startsWith('pairing token rejected');
  }

  void disconnect() {
    _userDisconnected = true;
    _reconnectTimer?.cancel();
    _channel?.sink.close();
    _channel = null;
    _helloAcked = false;
    _outbox.clear();
    _failPending('disconnected');
    _resetCipher();
    // 主动断链不算失败：清掉上一次的快照，避免 UI 呈现过时原因。
    _lastCloseCode = null;
    _lastCloseReason = null;
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
    _emitEnvelope(payload, deviceId: deviceId, hostId: _hostId);
  }

  /// Frame writer shared by the outbox flush and direct sends. In cipherMode
  /// every routed payload is sealed (header fields go into the AAD, so the
  /// envelope we send is exactly the envelope the receiver authenticates).
  void _emitEnvelope(Object payload, {String? deviceId, String? hostId, String? control}) {
    final seal = _seal;
    if (_cipherMode && seal != null && payload is! Map) {
      // Ciphertext payloads are built by seal() — only WireMessage maps are
      // routed here; anything else is a protocol bug.
      return;
    }
    if (_cipherMode && seal != null && payload is Map && (payload['kind'] != 'hello')) {
      final header = <String, dynamic>{
        'v': protocolVersion,
        'traceId': _nextNonce(),
        'ts': DateTime.now().millisecondsSinceEpoch,
        'nonce': _nextNonce(),
        'role': 'device',
        'deviceId': ?deviceId,
        'hostId': ?hostId,
      };
      _enqueueSealed(seal, header, payload, control: control);
      return;
    }
    final envelope = RemoteEnvelope(
      traceId: _nextNonce(),
      nonce: _nextNonce(),
      role: 'device',
      deviceId: deviceId,
      hostId: hostId,
      control: control,
      payload: payload,
    );
    _channel?.sink.add(envelope.encode());
  }

  /// Serialize sealed sends so concurrent seals (e.g. an outbox flush) keep
  /// their enqueue order on the wire.
  Future<void> _sendChain = Future<void>.value();

  void _enqueueSealed(E2eeSeal seal, Map<String, dynamic> header, Object payload, {String? control}) {
    _sendChain = _sendChain
        .then((_) => _sendSealed(seal, header, payload, control: control))
        .catchError((_) {});
  }

  Future<void> _sendSealed(E2eeSeal seal, Map<String, dynamic> header, Object payload, {String? control}) async {
    final parts = await seal.seal(payload, header);
    final envelope = RemoteEnvelope(
      traceId: header['traceId'] as String,
      nonce: header['nonce'] as String,
      role: 'device',
      deviceId: header['deviceId'] as String?,
      hostId: header['hostId'] as String?,
      e2eePub: parts.e2eePub,
      cipher: parts.cipher,
      control: control,
      payload: parts.payload,
      ts: header['ts'] as int,
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
    Map<String, dynamic> envelopeMap;
    try {
      envelopeMap = jsonDecode(text) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    if (envelopeMap['v'] != protocolVersion) return;
    final payload = envelopeMap['payload'];

    // E2EE routed frame: decrypt asynchronously before dispatch. Failures are
    // silent drops (tamper/replay) — the link stays up, matching the gateway.
    if (payload is String && envelopeMap['cipher'] is Map) {
      unawaited(_onEncryptedFrame(envelopeMap, payload));
      return;
    }
    if (payload is! Map<String, dynamic>) return;
    _dispatchPayload(payload);
  }

  Future<void> _onEncryptedFrame(Map<String, dynamic> envelopeMap, String ciphertext) async {
    final opened = _open;
    if (opened == null) return;
    try {
      final envelope = RemoteEnvelope.fromJson(envelopeMap);
      final clear = await opened.open(
        cipher: (envelopeMap['cipher'] as Map).cast<String, String>(),
        payload: ciphertext,
        header: envelope.aadHeader(),
      );
      if (clear is Map<String, dynamic>) _dispatchPayload(clear);
    } catch (_) {
      return;
    }
  }

  void _dispatchPayload(Map<String, dynamic> payload) {
    switch (payload['kind']) {
      case 'hello_ack':
        // 握手被 relay 接受：令牌已消费（或已被凭证回退取代），重连退避
        // 归零。此后的重连只带 deviceSecret，不再重放一次性 token。
        pairingTokenSpent = true;
        _reconnectAttempts = 0;
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
                  e2eePub: h['e2eePub'] as String?,
                ),
          ];
        }
        final hid = payload['hostId'];
        String? resolved = hid is String && hid.isNotEmpty ? hid : null;
        // 配对成功：凭证按二维码指定的电脑分别保存，后续连接免扫码。
        // 必须绑定 targetHostId（relay 的 pairDevice 用的就是它），不能用
        // hello_ack 里「第一台在线主机」的 id，否则会存错主机。
        final issuedSecret = payload['deviceSecret'];
        if (issuedSecret is String && issuedSecret.isNotEmpty) {
          final pairedHostId = targetHostId ?? _hostId ?? '';
          _deviceSecret = issuedSecret;
          _hostId = pairedHostId;
          _preferredHostId = pairedHostId;
          unawaited(saveDeviceSecret(
            deviceId,
            issuedSecret,
            relayUrl: relayUrl,
            hostId: pairedHostId,
          ));
          unawaited(savePreferredHost(pairedHostId));
        }
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
          unawaited(_finishHandshake(payload));
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
                  e2eePub: h['e2eePub'] as String?,
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

  /// hello_ack 收尾：E2EE 主机密钥钉扎/校验 → 建立会话密钥 → ready。
  /// cipherRequired 而拿不到主机公钥时拒绝连接（绝不降级明文）。
  Future<void> _finishHandshake(Map<String, dynamic> ackPayload) async {
    final hostId = _hostId;
    final cipherRequired = ackPayload['cipherRequired'] == true;
    String? hostPub;
    if (hostId != null) {
      for (final h in _knownHosts) {
        if (h.id == hostId) {
          hostPub = h.e2eePub;
          break;
        }
      }
    }
    if (hostId != null && hostPub != null) {
      final pinned = await loadPinnedHostPub(hostId, relayUrl: relayUrl);
      if (pinned != null && pinned != hostPub) {
        // Key rotation is only trusted through a fresh pairing scan; a silent
        // swap over the wire is a relay/network MITM signal — refuse.
        _handshakeError = '主机密钥与已配对记录不符，已拒绝连接（可能遭遇中间人）。请在电脑上重新扫码配对。';
        _cipherMode = false;
        _seal = null;
        _open = null;
        _userDisconnected = true; // no reconnect storm on a refused handshake
        _channel?.sink.close();
        _setState(LinkState.disconnected);
        return;
      }
      if (pinned == null) await savePinnedHostPub(hostId, hostPub, relayUrl: relayUrl);
    }
    if (cipherRequired) {
      final deviceKeys = _deviceKeys;
      if (hostPub == null || deviceKeys == null) {
        _handshakeError = 'relay 要求端到端加密，但未取得主机公钥。';
        _channel?.sink.close();
        _setState(LinkState.disconnected);
        return;
      }
      _seal = await E2eeSeal.create(own: deviceKeys, peerPublicKey: hostPub, isDevice: true);
      _open = await E2eeOpen.create(own: deviceKeys, peerPublicKey: hostPub, isDevice: true);
      _cipherMode = true;
    } else {
      _cipherMode = false;
      _seal = null;
      _open = null;
    }
    _setState(LinkState.ready);
    // 握手成功才记住地址：失败的尝试不覆盖上一次可用配置。
    unawaited(saveLastRelayUrl(relayUrl));
    _flushOutbox();
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
