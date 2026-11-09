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
const _kDeviceSecretPrefix = 'remote.deviceSecret.';
const _kHostPubPrefix = 'remote.hostE2eePub.';

/// 稳定的设备标识：首次生成后持久化，配对绑定与重连凭证都依赖它。
Future<String> loadOrCreateDeviceId() async {
  final prefs = await SharedPreferences.getInstance();
  final existing = prefs.getString(_kDeviceId);
  if (existing != null && existing.isNotEmpty) return existing;
  final id = 'android-${DateTime.now().millisecondsSinceEpoch % 100000}';
  await prefs.setString(_kDeviceId, id);
  return id;
}

Future<void> saveDeviceSecret(String deviceId, String secret) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString(_kDeviceSecretPrefix + deviceId, secret);
}

/// E2EE host key pinning (TOFU): the first-seen X25519 public key of a host
/// is stored; any later mismatch means the relay (or network) swapped keys
/// and the connection must be refused.
Future<void> savePinnedHostPub(String hostId, String publicKey) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString(_kHostPubPrefix + hostId, publicKey);
}

Future<String?> loadPinnedHostPub(String hostId) async {
  final prefs = await SharedPreferences.getInstance();
  final value = prefs.getString(_kHostPubPrefix + hostId);
  return (value == null || value.isEmpty) ? null : value;
}

Future<String?> loadDeviceSecret(String deviceId) async {
  final prefs = await SharedPreferences.getInstance();
  return prefs.getString(_kDeviceSecretPrefix + deviceId);
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
