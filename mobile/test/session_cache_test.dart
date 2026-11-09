import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/host_store.dart';
import 'package:pi_remote/widgets/session_models.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('session cache round-trips per host and sorts by recency', () async {
    const hostA = 'host-aaa';
    await saveCachedSessions(hostA, [
      SessionSummary(
        id: 's-old',
        cwd: 'D:/work/x',
        name: null,
        firstMessage: 'older session',
        messageCount: 3,
        modified: DateTime.parse('2026-11-01T10:00:00Z'),
        projectRoot: 'D:/work/x',
      ),
      SessionSummary(
        id: 's-new',
        cwd: 'D:/work/x',
        name: 'Named session',
        firstMessage: 'newer session',
        messageCount: 9,
        modified: DateTime.parse('2026-11-09T10:00:00Z'),
        projectRoot: 'D:/work/x',
      ),
    ]);

    final loaded = await loadCachedSessions(hostA);
    expect(loaded.length, 2);
    // 缓存读取按 modified 降序，进页首项即最近项目。
    expect(loaded.first.id, 's-new');
    expect(loaded.first.name, 'Named session');
    expect(loaded.last.messageCount, 3);
  });

  test('session cache is isolated per hostId', () async {
    await saveCachedSessions('host-1', [
      SessionSummary(
        id: 's-1',
        cwd: 'D:/work/one',
        name: null,
        firstMessage: 'host one session',
        messageCount: 1,
        modified: DateTime.parse('2026-11-09T09:00:00Z'),
        projectRoot: 'D:/work/one',
      ),
    ]);
    await saveCachedSessions('host-2', [
      SessionSummary(
        id: 's-2',
        cwd: 'D:/work/two',
        name: null,
        firstMessage: 'host two session',
        messageCount: 2,
        modified: DateTime.parse('2026-11-09T09:30:00Z'),
        projectRoot: 'D:/work/two',
      ),
    ]);

    expect((await loadCachedSessions('host-1')).single.id, 's-1');
    expect((await loadCachedSessions('host-2')).single.id, 's-2');
    expect(await loadCachedSessions('host-unknown'), isEmpty);
  });

  test('corrupt cache payload is tolerated as empty', () async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('remote.sessionsCache.host-bad', 'not-json{');
    expect(await loadCachedSessions('host-bad'), isEmpty);
  });
}
