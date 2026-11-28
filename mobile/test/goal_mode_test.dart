import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/app_theme.dart';
import 'package:pi_remote/core/remote_connection.dart';
import 'package:pi_remote/pages/chat_page.dart';

class _GoalFakeConnection extends RemoteConnection {
  final events = StreamController<RemoteSessionEvent>.broadcast();
  final commands = <Map<String, dynamic>>[];
  Map<String, dynamic>? goalStatePayload;

  _GoalFakeConnection({this.goalStatePayload})
      : super(
          relayUrl: 'ws://relay.example.com/ws',
          deviceId: 'dev-goal',
          deviceLabel: 'phone',
        );

  @override
  bool get isReady => true;

  @override
  Stream<RemoteSessionEvent> get onEvent => events.stream;

  @override
  Future<void> subscribe(String topic, String key) async {}

  @override
  Future<void> unsubscribe(String topic, String key) async {}

  @override
  Future<Map<String, dynamic>> agentCommand(
    String sessionId,
    Map<String, dynamic> command,
  ) async {
    commands.add({'sessionId': sessionId, ...command});
    return <String, dynamic>{};
  }

  @override
  Future<Map<String, dynamic>> request(String method, Object? params) async {
    switch (method) {
      case 'sessions.get':
        return {
          'info': {'cwd': r'D:\work\carhome'},
          'context': {'messages': <dynamic>[]},
          'agentState': {
            'running': true,
            'state': {
              'isStreaming': false,
              if (goalStatePayload != null) 'goalState': goalStatePayload,
            },
          },
        };
      case 'agent.state':
        return {
          'running': true,
          'state': {
            'queuedMessages': {'steering': <dynamic>[], 'followUp': <dynamic>[]},
            'goalState': goalStatePayload,
          },
        };
      case 'sessions.list':
        return {'runningSessionIds': <dynamic>[]};
      case 'skills.list':
        return {'skills': <dynamic>[], 'diagnostics': <dynamic>[]};
      case 'models.preferences.get':
        return {'models': <dynamic>[]};
      default:
        return <String, dynamic>{};
    }
  }
}

void main() {
  testWidgets('bare /goal shows usage guidance without sending empty goal', (tester) async {
    final connection = _GoalFakeConnection();
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: ChatPage(connection: connection, sessionId: 's1', title: 'Goal测试'),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), '/goal');
    await tester.pump();
    await tester.tap(find.byKey(const Key('composer-send')));
    await tester.pump();

    expect(find.textContaining('请输入目标内容'), findsOneWidget);
    expect(connection.commands, isEmpty);
  });

  testWidgets('remote editor and select requests render proper UI cards and reply with value/cancelled',
      (tester) async {
    final connection = _GoalFakeConnection();
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: ChatPage(connection: connection, sessionId: 's1', title: 'Goal测试'),
      ),
    );
    await tester.pumpAndSettle();

    // 1. PC asks for optional acceptance criteria via method: editor
    connection.events.add(
      RemoteSessionEvent('remote.approval', 's1', {
        'requestId': 'req-editor-1',
        'sessionId': 's1',
        'method': 'editor',
        'title': 'Acceptance criteria (optional, one per line)',
      }),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('extension-ui-editor-card')), findsOneWidget);
    expect(find.text('可选：填写验收标准（每行一条）'), findsOneWidget);

    await tester.enterText(
      find.descendant(
        of: find.byKey(const Key('extension-ui-editor-card')),
        matching: find.byType(TextField),
      ),
      '单测全部通过',
    );
    await tester.tap(find.text('确认并开始'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('extension-ui-editor-card')), findsNothing);
    expect(
      connection.commands.any((c) =>
          c['type'] == 'extension_ui_response' &&
          c['id'] == 'req-editor-1' &&
          c['value'] == '单测全部通过'),
      isTrue,
    );

    // 2. Skipping editor sends cancelled: true
    connection.events.add(
      RemoteSessionEvent('remote.approval', 's1', {
        'requestId': 'req-editor-2',
        'sessionId': 's1',
        'method': 'editor',
        'title': 'Acceptance criteria (optional, one per line)',
      }),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('跳过并开始'));
    await tester.pumpAndSettle();
    expect(
      connection.commands.any((c) =>
          c['type'] == 'extension_ui_response' &&
          c['id'] == 'req-editor-2' &&
          c['cancelled'] == true),
      isTrue,
    );
  });

  testWidgets('GoalPanel renders awaiting_acceptance report and dispatches accept / reject actions',
      (tester) async {
    final connection = _GoalFakeConnection(
      goalStatePayload: {
        'goal': '修复手机端 /goal 模式并补齐验收面板',
        'criteria': ['输入 /goal 不卡死', '支持验收通过与打回'],
        'status': 'awaiting_acceptance',
        'continuations': 2,
        'maxContinuations': 8,
        'checkpointEvery': 4,
        'report': {
          'summary': '已完成移动端编辑器与目标面板适配',
          'criteria': [
            {'criterion': '输入 /goal 不卡死', 'met': true, 'evidence': 'widget test passed'},
            {'criterion': '支持验收通过与打回', 'met': true, 'evidence': 'goal_resolve allowed'},
          ],
        },
        'feedback': null,
      },
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: ChatPage(connection: connection, sessionId: 's1', title: 'Goal测试'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('goal-panel')), findsOneWidget);
    expect(find.text('待验收'), findsOneWidget);
    expect(find.text('已完成移动端编辑器与目标面板适配'), findsOneWidget);
    expect(find.text('2/8 次自动续跑'), findsOneWidget);
    // Header shows the criteria progress count; criteria render as a rail
    // with filled nodes for met items and hollow ones for unmet.
    expect(find.text('2/2 项达成'), findsOneWidget);
    expect(find.byIcon(Icons.check_rounded), findsNWidgets(2));
    expect(find.byIcon(Icons.radio_button_unchecked_rounded), findsNothing);

    // Send back with feedback
    await tester.tap(find.text('打回修改'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.descendant(
        of: find.byKey(const Key('goal-panel')),
        matching: find.byType(TextField),
      ),
      '再补一条单测',
    );
    await tester.tap(find.text('确认打回'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(
      connection.commands.any((c) =>
          c['type'] == 'goal_resolve' &&
          c['action'] == 'reject' &&
          c['feedback'] == '再补一条单测'),
      isTrue,
    );
    expect(find.text('正在回复…'), findsOneWidget);

    // Clear awaiting state as when turn ends with next awaiting_acceptance, then accept goal
    connection.events.add(RemoteSessionEvent('agent.running', 'global', {
      'runningSessionIds': ['s1'],
    }));
    await tester.pump();
    connection.events.add(RemoteSessionEvent('agent.running', 'global', {
      'runningSessionIds': <String>[],
    }));
    await tester.pumpAndSettle();

    await tester.tap(find.text('验收通过'));
    await tester.pumpAndSettle();
    expect(
      connection.commands.any((c) => c['type'] == 'goal_resolve' && c['action'] == 'accept'),
      isTrue,
    );
  });
}
