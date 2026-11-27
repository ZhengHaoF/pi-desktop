import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/app_theme.dart';
import 'package:pi_remote/core/remote_connection.dart';
import 'package:pi_remote/pages/files_page.dart';
import 'package:pi_remote/pages/home_page.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _ShellFakeConnection extends RemoteConnection {
  final bool ready;
  final bool offline;
  final List<Map<String, dynamic>> sessions;
  final List<RemoteHostInfo> hosts;
  final List<String> requestedMethods = [];

  _ShellFakeConnection({
    this.ready = true,
    this.offline = false,
    this.sessions = const [],
    this.hosts = const [],
  }) : super(
          relayUrl: 'wss://relay.example.com/ws',
          deviceId: 'dev-shell',
          deviceLabel: 'TestPhone',
        );

  @override
  LinkState get state => ready ? LinkState.ready : LinkState.disconnected;

  @override
  bool get isReady => ready;

  @override
  bool get isTargetHostOffline => offline;

  @override
  String? get hostId => 'host-1';

  @override
  List<RemoteHostInfo> get knownHosts => hosts;

  @override
  void refreshHosts() {}

  @override
  Future<void> subscribe(String topic, String key) async {}

  @override
  Future<void> unsubscribe(String topic, String key) async {}

  @override
  Future<Map<String, dynamic>> request(String method, Object? params) async {
    requestedMethods.add(method);
    if (method == 'sessions.list') {
      return {'sessions': sessions, 'runningSessionIds': <String>[]};
    }
    if (method == 'sessions.get') {
      return {
        'session': {'id': 's1', 'cwd': r'D:\work\carhome', 'name': '调试车机'},
        'messages': <Map<String, dynamic>>[],
        'totalMessages': 0,
      };
    }
    if (method == 'models.preferences.get') {
      return {'default': null, 'enabled': <Map<String, dynamic>>[]};
    }
    if (method == 'files.list') {
      final path = (params as Map?)?['path'] as String? ?? '';
      if (path.endsWith('forbidden')) {
        throw StateError('FORBIDDEN: path not allowed');
      }
      if (path.endsWith('src')) {
        return {
          'entries': [
            {
              'name': 'main.dart',
              'path': r'D:\work\carhome\src\main.dart',
              'isDir': false,
              'type': 'file',
              'size': 256,
            },
          ],
        };
      }
      return {
        'entries': [
          {
            'name': 'src',
            'path': r'D:\work\carhome\src',
            'isDir': true,
            'type': 'directory',
            'size': 0,
          },
          {
            'name': 'README.md',
            'path': r'D:\work\carhome\README.md',
            'isDir': false,
            'type': 'file',
            'size': 128,
          },
        ],
      };
    }
    if (method == 'files.read') {
      return {
        'content': '# CarHome\nHello Workspace',
        'encoding': 'utf8',
        'mime': 'text/markdown',
        'truncated': false,
      };
    }
    return {};
  }
}

void main() {
  testWidgets('HomePage switches between 任务, 文件 (with file preview), and 我的 tabs',
      (tester) async {
    SharedPreferences.setMockInitialValues({});
    final connection = _ShellFakeConnection(
      hosts: [
        RemoteHostInfo(id: 'host-1', label: 'ZHF-WORK', online: true, lastSeenAt: null),
      ],
      sessions: [
        {
          'id': 's1',
          'cwd': r'D:\work\carhome',
          'projectRoot': r'D:\work\carhome',
          'name': '调试车机',
          'firstMessage': 'hello',
          'messageCount': 2,
          'modified': DateTime.now().toIso8601String(),
        },
      ],
    );

    await tester.pumpWidget(
      MaterialApp(theme: buildAppTheme(), home: HomePage(connection: connection)),
    );
    await tester.pumpAndSettle();

    // Tab 0 (任务): shows active conversation with WorkBuddy-style header.
    expect(find.text('调试车机'), findsOneWidget);
    expect(find.text('ZHF-WORK · carhome'), findsOneWidget);

    // Switch to Tab 1 (文件): browse directory & open file preview.
    await tester.tap(find.text('文件'));
    await tester.pumpAndSettle();
    expect(find.text('src'), findsOneWidget);
    expect(find.text('README.md'), findsOneWidget);

    await tester.tap(find.text('src'));
    await tester.pumpAndSettle();
    expect(find.text('main.dart'), findsOneWidget);
    expect(find.text('返回上级目录'), findsOneWidget);

    await tester.tap(find.text('main.dart'));
    await tester.pumpAndSettle();
    expect(find.text('# CarHome\nHello Workspace'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();

    // Switch to Tab 2 (我的): shows multi-PC section and settings.
    await tester.tap(find.text('我的'));
    await tester.pumpAndSettle();
    expect(find.text('我的设备'), findsOneWidget);
    expect(find.text('管理 / 切换电脑'), findsOneWidget);
    expect(find.text('扫码配对'), findsOneWidget);
  });

  testWidgets('HomePage shows non-blocking offline banner when host is offline with cached session',
      (tester) async {
    SharedPreferences.setMockInitialValues({
      'remote.knownHosts': '[{"id":"host-1","label":"ZHF-WORK","online":false}]',
    });
    final connection = _ShellFakeConnection(
      ready: false,
      offline: true,
      hosts: [
        RemoteHostInfo(id: 'host-1', label: 'ZHF-WORK', online: false, lastSeenAt: null),
      ],
      sessions: [
        {
          'id': 's1',
          'cwd': r'D:\work\carhome',
          'projectRoot': r'D:\work\carhome',
          'name': '离线仍可读的任务',
          'firstMessage': 'hello',
          'messageCount': 2,
          'modified': DateTime.now().toIso8601String(),
        },
      ],
    );

    await tester.pumpWidget(
      MaterialApp(theme: buildAppTheme(), home: HomePage(connection: connection)),
    );
    await tester.pumpAndSettle();

    expect(find.text('离线仍可读的任务'), findsOneWidget);
    expect(find.text('电脑设备已离线'), findsOneWidget);
    expect(find.text('切换'), findsOneWidget);
    expect(find.text('重试'), findsOneWidget);
  });

  testWidgets('FilesPage shows friendly FORBIDDEN guidance', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final connection = _ShellFakeConnection();

    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: FilesPage(
          connection: connection,
          projectRoots: const [r'D:\work\forbidden'],
          activeRoot: r'D:\work\forbidden',
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('未对手机端授权读取'), findsOneWidget);
  });
}
