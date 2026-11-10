/// Multi-PC selector persistence: remember the last chosen host and known
/// hosts so the home page restores the selection across restarts.
library;

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../core/remote_connection.dart';
import '../widgets/session_models.dart';

const _kPreferredHost = 'remote.preferredHostId';
const _kKnownHosts = 'remote.knownHosts';
const _kSessionsCachePrefix = 'remote.sessionsCache.';
const _kDeviceId = 'remote.deviceId';
const _kLastRelayUrl = 'remote.lastRelayUrl';
const _kDeviceSecretPrefix = 'remote.deviceSecret.';
const _kHostPubPrefix = 'remote.hostE2eePub.';

/// 凭证/钉扎的存储作用域：按 relay 主机隔离（host[:port]），同一台手机对
/// 电脑内置 relay 与 VPS relay 各自持有独立凭证，互不覆盖、互不误用。
/// 协议默认端口（ws:80 / wss:443）视为省略，便于等价地址归一到同一作用域。
String relayScope(String relayUrl) {
  final uri = Uri.tryParse(relayUrl);
  if (uri == null || uri.host.isEmpty) return relayUrl;
  final scheme = uri.scheme.toLowerCase();
  final defaultPort = scheme == 'wss' || scheme == 'https' ? 443 : 80;
  final explicitPort = uri.hasPort ? uri.port : null;
  if (explicitPort == null || explicitPort == defaultPort) return uri.host;
  return '${uri.host}:$explicitPort';
}

/// 稳定的设备标识：首次生成后持久化，配对绑定与重连凭证都依赖它。
Future<String> loadOrCreateDeviceId() async {
  final prefs = await SharedPreferences.getInstance();
  final existing = prefs.getString(_kDeviceId);
  if (existing != null && existing.isNotEmpty) return existing;
  final id = 'android-${DateTime.now().millisecondsSinceEpoch % 100000}';
  await prefs.setString(_kDeviceId, id);
  return id;
}

/// 上次成功连接的 relay 地址：连接页冷启动时回填，免去重新输入或扫码。
/// 只记录连接成功的地址，失败的尝试不会覆盖上一次可用的配置。
Future<void> saveLastRelayUrl(String relayUrl) async {
  final value = relayUrl.trim();
  if (value.isEmpty) return;
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString(_kLastRelayUrl, value);
}

Future<String?> loadLastRelayUrl() async {
  final prefs = await SharedPreferences.getInstance();
  final value = prefs.getString(_kLastRelayUrl);
  return (value == null || value.isEmpty) ? null : value;
}

/// 设备凭证按 relay 作用域隔离：scope 用 [relayScope] 从 relay 地址派生。
Future<void> saveDeviceSecret(String deviceId, String secret, {required String relayUrl}) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString('$_kDeviceSecretPrefix${relayScope(relayUrl)}.$deviceId', secret);
}

Future<String?> loadDeviceSecret(String deviceId, {required String relayUrl}) async {
  final prefs = await SharedPreferences.getInstance();
  final value = prefs.getString('$_kDeviceSecretPrefix${relayScope(relayUrl)}.$deviceId');
  return (value == null || value.isEmpty) ? null : value;
}

/// E2EE host key pinning (TOFU): the first-seen X25519 public key of a host
/// is stored; any later mismatch means the relay (or network) swapped keys
/// and the connection must be refused. 同一 hostId 在不同 relay 下各自钉扎，
/// 避免 LAN 与公网 relay 混用同一份记录。
Future<void> savePinnedHostPub(String hostId, String publicKey, {required String relayUrl}) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString('$_kHostPubPrefix${relayScope(relayUrl)}.$hostId', publicKey);
}

Future<String?> loadPinnedHostPub(String hostId, {required String relayUrl}) async {
  final prefs = await SharedPreferences.getInstance();
  final value = prefs.getString('$_kHostPubPrefix${relayScope(relayUrl)}.$hostId');
  return (value == null || value.isEmpty) ? null : value;
}

Future<void> savePreferredHost(String hostId) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString(_kPreferredHost, hostId);
}

Future<String?> loadPreferredHost() async {
  final prefs = await SharedPreferences.getInstance();
  return prefs.getString(_kPreferredHost);
}

Future<void> saveKnownHosts(List<RemoteHostInfo> hosts) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString(
    _kKnownHosts,
    jsonEncode([
      for (final h in hosts)
        {'id': h.id, 'label': h.label, 'online': h.online, 'lastSeenAt': h.lastSeenAt},
    ]),
  );
}

Future<List<RemoteHostInfo>> loadKnownHosts() async {
  final prefs = await SharedPreferences.getInstance();
  final raw = prefs.getString(_kKnownHosts);
  if (raw == null) return const [];
  try {
    final list = jsonDecode(raw) as List;
    return [
      for (final item in list)
        if (item is Map)
          RemoteHostInfo(
            id: item['id'] as String? ?? '',
            label: item['label'] as String?,
            online: item['online'] == true,
            lastSeenAt: item['lastSeenAt'] as int?,
          ),
    ];
  } catch (_) {
    return const [];
  }
}

/// Per-host session list snapshot: rendered immediately on entry/reconnect,
/// then silently refreshed from the live sessions.list. Running-state dots are
/// never cached — they always come from the fresh response.
Future<void> saveCachedSessions(String hostId, List<SessionSummary> sessions) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString(
    _kSessionsCachePrefix + hostId,
    jsonEncode([
      for (final s in sessions)
        {
          'id': s.id,
          'cwd': s.cwd,
          'name': s.name,
          'firstMessage': s.firstMessage,
          'messageCount': s.messageCount,
          'modified': s.modified.toIso8601String(),
          'projectRoot': s.projectRoot,
        },
    ]),
  );
}

Future<List<SessionSummary>> loadCachedSessions(String hostId) async {
  final prefs = await SharedPreferences.getInstance();
  final raw = prefs.getString(_kSessionsCachePrefix + hostId);
  if (raw == null || raw.isEmpty) return const [];
  try {
    final list = jsonDecode(raw) as List;
    final sessions = [
      for (final item in list)
        if (item is Map) SessionSummary.fromMap(Map<String, dynamic>.from(item)),
    ];
    sessions.sort((a, b) => b.modified.compareTo(a.modified));
    return sessions;
  } catch (_) {
    return const [];
  }
}
