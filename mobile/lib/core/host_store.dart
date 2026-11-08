/// Multi-PC selector persistence: remember the last chosen host and known
/// hosts so the home page restores the selection across restarts.
library;

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../core/remote_connection.dart';

const _kPreferredHost = 'remote.preferredHostId';
const _kKnownHosts = 'remote.knownHosts';

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
