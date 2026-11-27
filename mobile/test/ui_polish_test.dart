/// Widget tests for the P0+P1 mobile UI polish across MarkdownText,
/// HomePage, ConnectPage, and SettingsPage.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/app_theme.dart';
import 'package:pi_remote/core/host_store.dart';
import 'package:pi_remote/core/remote_connection.dart';
import 'package:pi_remote/pages/connect_page.dart';
import 'package:pi_remote/pages/home_page.dart';
import 'package:pi_remote/pages/settings_page.dart';
import 'package:pi_remote/widgets/markdown_text.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeHomeConnection extends RemoteConnection {
  final List<Map<String, dynamic>> sessions;
  final List<String> runningIds;
  final Object? listError;
  final bool pairingRejected;
  final String? failureText;

  _FakeHomeConnection({
    this.sessions = const [],
    this.runningIds = const [],
    this.listError,
    this.pairingRejected = false,
    this.failureText,
  }) : super(
          relayUrl: 'ws://relay.example:8788/ws',
          deviceId: 'dev-1',
          deviceLabel: 'phone',
          targetHostId: 'host-1',
        );

  @override
  bool get lastFailureWasPairingReject => pairingRejected;

  @override
  bool get isTerminalFailure => pairingRejected;

  @override
  String? describeLastFailure() => failureText;

  @override
  Future<Map<String, dynamic>> request(String method, Object? params) async {
    if (method == 'sessions.list') {
      if (listError != null) throw listError!;
      return {'sessions': sessions, 'runningSessionIds': runningIds};
    }
    return <String, dynamic>{};
  }
}

class _RejectedConnectConnection extends RemoteConnection {
  _RejectedConnectConnection({
    required super.relayUrl,
    required super.deviceId,
    required super.deviceLabel,
    super.pairingToken,
    super.targetHostId,
  });

  @override
  String? get hostId => 'host-1';

  @override
  bool get lastFailureWasPairingReject => true;

  @override
  String? describeLastFailure() => '配对已失效，可能已在电脑端移除了此设备，请重新扫描电脑端二维码';

  @override
  Future<bool> connectAndWaitHandshake({Duration timeout = const Duration(seconds: 10)}) async => false;

  @override
  void disconnect() {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('MarkdownText renders code block language header, copy button, quote, and divider',
      (tester) async {
    String? copiedText;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copiedText = (call.arguments as Map)['text'] as String?;
        }
        return null;
      },
    );
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));

    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: const Scaffold(
          body: MarkdownText(
            data: '> 引用提示\n\n---\n\n```dart\nprint("hello");\n```',
            baseStyle: TextStyle(fontSize: 13.5),
          ),
        ),
      ),
    );

    expect(find.textContaining('引用提示', findRichText: true), findsOneWidget);
    expect(find.byType(Divider), findsOneWidget);
    expect(find.text('dart'), findsOneWidget);
    expect(find.text('复制'), findsOneWidget);

    await tester.tap(find.text('复制'));
    await tester.pump();
    expect(copiedText, 'print("hello");');
    expect(find.text('已复制'), findsOneWidget);
  });

  testWidgets('HomePage displays project display name above full path', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final connection = _FakeHomeConnection(
      sessions: [
        {
          'id': 's1',
          'cwd': r'D:\work\carhome',
          'projectRoot': r'D:\work\carhome',
          'name': '修复图标',
          'firstMessage': 'hello',
          'messageCount': 3,
          'modified': DateTime.now().toIso8601String(),
        },
      ],
      runningIds: const ['s1'],
    );

    await tester.pumpWidget(MaterialApp(theme: buildAppTheme(), home: HomePage(connection: connection)));
    await tester.pumpAndSettle();

    // Default landing opens the active session directly in the Tasks tab.
    expect(find.text('修复图标'), findsOneWidget);
    expect(find.textContaining('carhome'), findsOneWidget);
    expect(find.text('任务'), findsOneWidget);
    expect(find.text('文件'), findsOneWidget);
    expect(find.text('我的'), findsOneWidget);

    // Open WorkBuddy-style left drawer to browse all projects and sessions.
    await tester.tap(find.byTooltip('打开工作区侧栏').first);
    await tester.pumpAndSettle();

    expect(find.text('最近任务'), findsOneWidget);
    expect(find.text('空间 (1)'), findsOneWidget);
    expect(find.text('carhome'), findsOneWidget);
    expect(find.text(r'D:\work\carhome'), findsOneWidget);
    expect(find.text('新建任务'), findsOneWidget);
  });

  testWidgets('ConnectPage shows quick reconnect when a saved relay exists and collapses manual fields',
      (tester) async {
    SharedPreferences.setMockInitialValues({
      'remote.deviceId': 'dev-1',
      'remote.lastRelayUrl': 'wss://relay.example.com/ws',
      'remote.preferredHostId': 'host-1',
      'remote.knownHosts': '[{"id":"host-1","label":"Work-PC","online":true}]',
      'remote.deviceSecret.relay.example.com.dev-1.host-1': 'secret-1',
    });

    await tester.pumpWidget(MaterialApp(theme: buildAppTheme(), home: const ConnectPage()));
    await tester.pumpAndSettle();

    expect(find.text('Pi Go'), findsOneWidget);
    expect(find.textContaining('快速重连 Work-PC'), findsOneWidget);
    expect(find.text('Relay 地址'), findsNothing);

    await tester.tap(find.text('手动配置与设备标识'));
    await tester.pumpAndSettle();
    expect(find.text('Relay 地址'), findsOneWidget);
  });

  testWidgets('ConnectPage stays on page and clears stale secret when quick reconnect is rejected (4003)',
      (tester) async {
    SharedPreferences.setMockInitialValues({
      'remote.deviceId': 'dev-1',
      'remote.lastRelayUrl': 'wss://relay.example.com/ws',
      'remote.preferredHostId': 'host-1',
      'remote.knownHosts': '[{"id":"host-1","label":"Work-PC","online":true}]',
      'remote.deviceSecret.relay.example.com.dev-1.host-1': 'stale-secret',
    });

    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: ConnectPage(
          connectionFactory: ({
            required String relayUrl,
            required String deviceId,
            required String deviceLabel,
            String? pairingToken,
            String? targetHostId,
          }) =>
              _RejectedConnectConnection(
            relayUrl: relayUrl,
            deviceId: deviceId,
            deviceLabel: deviceLabel,
            pairingToken: pairingToken,
            targetHostId: targetHostId,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.textContaining('快速重连 Work-PC'));
    await tester.pump();
    for (var i = 0; i < 6; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }

    // Never jumped to HomePage; friendly explanation shown right on ConnectPage.
    expect(find.text('Pi Go — 连接'), findsOneWidget);
    expect(find.textContaining('可能已在电脑端移除了此设备'), findsOneWidget);
    expect(find.textContaining('快速重连 Work-PC'), findsNothing);
    expect(
      await loadDeviceSecret('dev-1', relayUrl: 'wss://relay.example.com/ws', hostId: 'host-1'),
      isNull,
    );
  });

  testWidgets('HomePage pairing-expired state shows primary rescan action without retry and keeps cached host name',
      (tester) async {
    SharedPreferences.setMockInitialValues({
      'remote.knownHosts': '[{"id":"host-1","label":"Work-PC","online":false}]',
    });
    final connection = _FakeHomeConnection(
      listError: StateError('not connected: link closed'),
      pairingRejected: true,
      failureText: '配对已失效，可能已在电脑端移除了此设备，请重新扫描电脑端二维码',
    );

    await tester.pumpWidget(MaterialApp(theme: buildAppTheme(), home: HomePage(connection: connection)));
    await tester.pumpAndSettle();

    expect(find.text('Work-PC'), findsOneWidget);
    expect(find.text('设备配对已失效'), findsOneWidget);
    expect(find.text('重新扫码配对'), findsOneWidget);
    expect(find.text('重试'), findsNothing);
  });

  testWidgets('SettingsPage displays current E2EE copy and app version', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final connection = _FakeHomeConnection();

    await tester.pumpWidget(MaterialApp(theme: buildAppTheme(), home: SettingsPage(connection: connection)));
    await tester.pump();

    expect(find.text('安全与配对说明'), findsOneWidget);
    expect(find.textContaining('诊断模式'), findsNothing);
    expect(find.text(appDisplayVersion), findsOneWidget);
  });
}
