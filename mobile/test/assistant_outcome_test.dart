import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/app_theme.dart';
import 'package:pi_remote/core/remote_connection.dart';
import 'package:pi_remote/pages/chat_page.dart';
import 'package:pi_remote/widgets/session_models.dart';
import 'package:pi_remote/widgets/transcript_groups.dart';

/// Failed/stopped assistant messages have no displayable content block, only
/// `stopReason` + `errorMessage`. The desktop renders them as outcome cards
/// (AssistantOutcome); without the mobile mirror a PC-side model failure leaves
/// the phone transcript blank, looking like it is still processing.
void main() {
  group('assistantOutcomeLine', () {
    test('error stopReason becomes a failure card with the provider detail', () {
      final line = assistantOutcomeLine({
        'role': 'assistant',
        'content': [
          {'type': 'text', 'text': ''},
        ],
        'stopReason': 'error',
        'errorMessage': '白鸽免费: 上游响应超时 (HTTP 504, upstream_timeout)',
      });

      expect(line, isNotNull);
      expect(line!.kind, 'outcome');
      expect(line.stopped, isFalse);
      expect(line.done, isTrue);
      expect(line.text, '白鸽免费: 上游响应超时 (HTTP 504, upstream_timeout)');
    });

    test('error without a usable errorMessage falls back to a hint', () {
      for (final message in [
        {'role': 'assistant', 'content': [], 'stopReason': 'error'},
        {'role': 'assistant', 'content': [], 'stopReason': 'error', 'errorMessage': '   '},
        {'role': 'assistant', 'content': [], 'stopReason': 'error', 'errorMessage': 42},
      ]) {
        final line = assistantOutcomeLine(message);
        expect(line, isNotNull);
        expect(line!.stopped, isFalse);
        expect(line.text, '模型服务未返回错误详情，请检查 API 密钥、服务地址和模型配置。');
      }
    });

    test('aborted stopReason becomes a muted stopped card without detail', () {
      final line = assistantOutcomeLine({
        'role': 'assistant',
        'content': [
          {'type': 'text', 'text': ''},
        ],
        'stopReason': 'aborted',
        'errorMessage': 'This operation was aborted',
      });

      expect(line, isNotNull);
      expect(line!.kind, 'outcome');
      expect(line.stopped, isTrue);
      // Desktop ignores errorMessage for aborts — the card only says 已停止.
      expect(line.text, isEmpty);
    });

    test('ordinary messages produce no outcome line', () {
      expect(
        assistantOutcomeLine({
          'role': 'assistant',
          'content': [
            {'type': 'text', 'text': '你好'},
          ],
          'stopReason': 'stop',
        }),
        isNull,
      );
      expect(assistantOutcomeLine({'role': 'assistant', 'content': []}), isNull);
      // The live stream echoes the user message with message_end; role guard.
      expect(assistantOutcomeLine({'role': 'user', 'content': '好', 'stopReason': 'error'}), isNull);
    });
  });

  group('historyLinesFromDetail outcome', () {
    test('a failed turn renders the outcome card after the user message', () {
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {'role': 'user', 'content': '好，这个提交并 push 吧'},
            {
              'role': 'assistant',
              'content': [
                {'type': 'text', 'text': ''},
              ],
              'stopReason': 'error',
              'errorMessage': '白鸽免费: 上游响应超时 (HTTP 504)',
            },
          ],
        },
      });

      expect(lines, hasLength(2));
      expect(lines[0].kind, 'text');
      expect(lines[1].kind, 'outcome');
      expect(lines[1].messageIndex, 1);
      expect(lines[1].text, '白鸽免费: 上游响应超时 (HTTP 504)');
    });

    test('outcome stays outside the folded process group', () {
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {'role': 'user', 'content': '继续'},
            {
              'role': 'assistant',
              'content': [
                {
                  'type': 'toolCall',
                  'toolCallId': 'c1',
                  'toolName': 'bash',
                  'input': {'command': 'git push'},
                },
              ],
            },
            {'role': 'toolResult', 'toolCallId': 'c1', 'content': 'ok'},
            {
              'role': 'assistant',
              'content': [
                {'type': 'text', 'text': ''},
              ],
              'stopReason': 'error',
              'errorMessage': 'upstream timeout',
            },
          ],
        },
      });

      // The folded group must not swallow the failure card.
      final entries = buildTranscriptEntries(lines, liveTail: false);
      final kinds = [
        for (final entry in entries)
          if (entry.isGroup) 'group' else entry.line!.kind,
      ];
      expect(kinds, ['text', 'group', 'outcome']);
      expect(entries.last.line!.text, 'upstream timeout');
    });
  });

  group('live stream outcome', () {
    testWidgets('a model failure event renders the failure card', (tester) async {
      final connection = _OutcomeFakeConnection();
      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          home: ChatPage(connection: connection, sessionId: 's1', title: 'Outcome测试'),
        ),
      );
      await tester.pumpAndSettle();

      // The shape pi-agent-core emits in handleRunFailure: message_start then
      // message_end, both carrying the same failure message.
      final failureMessage = {
        'role': 'assistant',
        'content': [
          {'type': 'text', 'text': ''},
        ],
        'stopReason': 'error',
        'errorMessage': '白鸽免费: 上游响应超时 (HTTP 504, upstream_timeout, request id req_1)',
      };
      connection.events.add(RemoteSessionEvent('agent.events', 's1', {
        'type': 'message_start',
        'message': failureMessage,
      }));
      connection.events.add(RemoteSessionEvent('agent.events', 's1', {
        'type': 'message_end',
        'message': failureMessage,
      }));
      await tester.pumpAndSettle();

      expect(find.text('模型请求失败'), findsOneWidget);
      expect(find.textContaining('HTTP 504'), findsOneWidget);
    });

    testWidgets('an aborted event renders the stopped card', (tester) async {
      final connection = _OutcomeFakeConnection();
      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          home: ChatPage(connection: connection, sessionId: 's1', title: 'Outcome测试'),
        ),
      );
      await tester.pumpAndSettle();

      connection.events.add(RemoteSessionEvent('agent.events', 's1', {
        'type': 'message_end',
        'message': {
          'role': 'assistant',
          'content': [
            {'type': 'text', 'text': ''},
          ],
          'stopReason': 'aborted',
        },
      }));
      await tester.pumpAndSettle();

      expect(find.text('已停止'), findsOneWidget);
    });
  });
}

class _OutcomeFakeConnection extends RemoteConnection {
  final events = StreamController<RemoteSessionEvent>.broadcast();

  _OutcomeFakeConnection()
      : super(
          relayUrl: 'ws://relay.example.com/ws',
          deviceId: 'dev-outcome',
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
  Future<Map<String, dynamic>> request(String method, Object? params) async {
    switch (method) {
      case 'sessions.get':
        return {
          'info': {'cwd': r'D:\work\pi-desktop'},
          'context': {'messages': <dynamic>[]},
          'agentState': {
            'running': false,
            'state': {'isStreaming': false, 'isPromptRunning': false},
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
