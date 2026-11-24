/// 回归测试：手机端「新建任务」页不能一进去就替用户发一条空消息。
///
/// 修复前 home_page 直接调 `agent.new {cwd}`，服务端在缺少 type 时兜底成
/// `{type:'prompt', message:''}`，于是进页面就凭空跑一轮只有项目上下文的
/// 回合，模型只能回一句「已加载这个项目…还没收到具体任务」，还会落盘。
/// 现在与桌面端一致：先进空对话页，首条消息才 ensure_session + prompt。
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
  });

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
      case 'agent.new':
        return {'sessionId': 'new-session-1'};
      case 'models.preferences.get':
        return {'models': <dynamic>[]};
      default:
        return <String, dynamic>{};
    }
  }
}

FakeConnection newConnection() => FakeConnection(
      relayUrl: 'ws://relay.example:8788/ws',
      deviceId: 'dev-1',
      deviceLabel: 'phone',
    );

Future<void> pumpFrames(WidgetTester tester, Widget child) async {
  await tester.pumpWidget(MaterialApp(home: child));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  testWidgets('新建任务页不建会话、不发回合', (tester) async {
    final connection = newConnection();

    await pumpFrames(
      tester,
      ChatPage(
        connection: connection,
        title: 'carhome · 新任务',
        newTaskCwd: 'D:/work/carhome',
      ),
    );

    expect(connection.calls.map((c) => c.$1), isNot(contains('agent.new')),
        reason: '进页面就调 agent.new 会触发一次空 prompt 回合');
    expect(connection.calls.map((c) => c.$1), isNot(contains('agent.command')));
    expect(find.text('向 PC 上的 agent 发送第一条指令…'), findsOneWidget);
  });

  testWidgets('首条消息才 ensure_session，且 prompt 带正文', (tester) async {
    final connection = newConnection();

    await pumpFrames(
      tester,
      ChatPage(
        connection: connection,
        title: 'carhome · 新任务',
        newTaskCwd: 'D:/work/carhome',
      ),
    );

    await tester.enterText(find.byType(TextField), '看看转向灯为什么闪得快');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.send));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    final newIndex = connection.calls.indexWhere((c) => c.$1 == 'agent.new');
    final commandIndex = connection.calls.indexWhere((c) => c.$1 == 'agent.command');
    expect(newIndex, isNonNegative, reason: '首条消息应创建会话');
    expect(commandIndex, greaterThan(newIndex), reason: '先建会话再发 prompt');

    final newParams = connection.calls[newIndex].$2 as Map;
    expect(newParams['type'], 'ensure_session', reason: '建会话只能是 ensure_session，绝不能是空 prompt');
    expect(newParams['cwd'], 'D:/work/carhome');
    expect(newParams.containsKey('message'), isFalse);

    final commandParams = connection.calls[commandIndex].$2 as Map;
    expect(commandParams['sessionId'], 'new-session-1');
    final command = commandParams['command'] as Map;
    expect(command['type'], 'prompt');
    expect(command['message'], '看看转向灯为什么闪得快');
  });
}
