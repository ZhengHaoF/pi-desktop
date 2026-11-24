/// 回归测试：输入区卡片化（模型 chip 移进卡片、圆形发送键空态置灰），
/// 以及模型弹层的大行样式 + 会话级思考强度。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/remote_connection.dart';
import 'package:pi_remote/pages/chat_page.dart';

class FakeConnection extends RemoteConnection {
  FakeConnection({
    required super.relayUrl,
    required super.deviceId,
    required super.deviceLabel,
    this.levels = const ['off', 'low', 'medium', 'high'],
  });

  final List<String> levels;
  final calls = <(String, Object?)>[];

  @override
  bool get isReady => true;

  @override
  Future<void> subscribe(String topic, String key) async {}

  @override
  Future<void> unsubscribe(String topic, String key) async {}

  @override
  Future<Map<String, dynamic>> request(String method, Object? params) async {
    calls.add((method, params));
    switch (method) {
      case 'sessions.get':
        return {
          'context': {'messages': <dynamic>[]},
          'agentState': {
            'model': {'provider': 'deepseek', 'id': 'v4-flash'},
          },
        };
      case 'sessions.list':
        return {'runningSessionIds': <dynamic>[]};
      case 'models.preferences.get':
        return {
          'models': [
            {'id': 'v4-flash', 'name': 'DeepSeek-V4.1-Flash', 'provider': 'deepseek'},
            {'id': 'glm', 'name': 'GLM-5.3', 'provider': 'zhipu'},
          ],
          'defaultModel': {'provider': 'zhipu', 'modelId': 'glm'},
          'thinkingLevels': {'deepseek:v4-flash': levels},
        };
      case 'agent.new':
        return {'sessionId': 'new-session-1'};
      default:
        return <String, dynamic>{};
    }
  }
}

FakeConnection newConnection({List<String> levels = const ['off', 'low', 'medium', 'high']}) =>
    FakeConnection(
      relayUrl: 'ws://relay.example:8788/ws',
      deviceId: 'dev-1',
      deviceLabel: 'phone',
      levels: levels,
    );

Future<void> pumpFrames(WidgetTester tester, Widget child) async {
  await tester.pumpWidget(MaterialApp(home: child));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  testWidgets('空输入时圆形发送键不可点', (tester) async {
    final connection = newConnection();
    await pumpFrames(tester, ChatPage(connection: connection, sessionId: 's1', title: '会话'));

    await tester.tap(find.byKey(const Key('composer-send')));
    await tester.pump();
    expect(connection.calls.map((c) => c.$1), isNot(contains('agent.command')),
        reason: '没有正文时发送键必须是惰性的');

    await tester.enterText(find.byType(TextField), '跑一遍回归');
    await tester.pump();
    await tester.tap(find.byKey(const Key('composer-send')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(connection.calls.map((c) => c.$1), contains('agent.command'));
  });

  testWidgets('模型 chip 在卡片里、弹层是大行并能改思考强度', (tester) async {
    final connection = newConnection();
    await pumpFrames(tester, ChatPage(connection: connection, sessionId: 's1', title: '会话'));

    // 当前模型取会话快照 → chip 显示目录里的名字，且不再占用标题栏。
    expect(find.text('DeepSeek-V4.1-Flash'), findsOneWidget);
    expect(find.text('选择模型'), findsNothing);

    await tester.tap(find.text('DeepSeek-V4.1-Flash'));
    await tester.pumpAndSettle();

    expect(find.text('选择模型'), findsOneWidget);
    expect(find.text('思考强度'), findsOneWidget, reason: '该模型有多档可用');
    expect(find.text('跟随默认'), findsOneWidget, reason: 'get_state 没给档位时如实显示');
    expect(find.text('GLM-5.3'), findsOneWidget);
    expect(find.text('deepseek / v4-flash'), findsOneWidget, reason: '副标题保留 provider/id');
    expect(find.text('默认'), findsOneWidget, reason: 'PC 默认模型要有标记');

    await tester.tap(find.text('高').last);
    await tester.pump();
    final command = connection.calls.last.$2 as Map;
    expect(command['sessionId'], 's1');
    final inner = command['command'] as Map;
    expect(inner['type'], 'set_thinking_level');
    expect(inner['level'], 'high');
  });

  testWidgets('模型只有一个档位时不显示思考强度', (tester) async {
    final connection = newConnection(levels: const ['off']);
    await pumpFrames(tester, ChatPage(connection: connection, sessionId: 's1', title: '会话'));

    await tester.tap(find.text('DeepSeek-V4.1-Flash'));
    await tester.pumpAndSettle();
    expect(find.text('思考强度'), findsNothing);
  });
}
