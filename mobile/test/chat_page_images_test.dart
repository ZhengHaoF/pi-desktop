/// Images arriving live over agent.events, and tool results that carry them:
/// the path a screenshot takes when the agent produces it while the phone is
/// attached, as opposed to reading it back from history.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/remote_connection.dart';
import 'package:pi_remote/pages/chat_page.dart';
import 'package:pi_remote/widgets/chat_image.dart';

/// One transparent 1x1 PNG.
final png = base64Encode([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, //
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
  0x42, 0x60, 0x82,
]);

final imageBlock = {'type': 'image', 'data': png, 'mimeType': 'image/png'};

/// Drives agent.events straight into the page, the way a live connection does.
class FakeConnection extends RemoteConnection {
  final events = StreamController<RemoteSessionEvent>.broadcast();
  final entryContentRequests = <Map<Object?, Object?>>[];
  /// What sessions.get answers; tests set this before pumping the page.
  Map<String, dynamic> history = {'context': {'messages': <dynamic>[]}};

  FakeConnection({
    required super.relayUrl,
    required super.deviceId,
    required super.deviceLabel,
  });

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
        return history;
      case 'sessions.list':
        return {'runningSessionIds': <dynamic>[]};
      case 'models.preferences.get':
        return {'models': <dynamic>[]};
      case 'sessions.entryContent':
        entryContentRequests.add({'entryId': params is Map ? params['entryId'] : null});
        return {
          'content': imageBlock,
        };
      default:
        return <String, dynamic>{};
    }
  }
}

Future<void> pumpPage(WidgetTester tester, FakeConnection connection) async {
  await tester.pumpWidget(MaterialApp(home: ChatPage(connection: connection, sessionId: 's1', title: '会话')));
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
}

/// Let the image codec finish a real decode, which the fake clock cannot skip.
Future<void> settleImages(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump();
  }
}

Map<String, dynamic> agentEvent(String type, Map<String, dynamic> message) => {'type': type, 'message': message};

void main() {
  group('live images', () {
    testWidgets('a reply image is shown once, when the message ends', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      await pumpPage(tester, connection);
      final message = {
        'role': 'assistant',
        'content': [
          {'type': 'text', 'text': '这是截图'},
          imageBlock,
        ],
      };

      // message_start / update carry the same image; none may add a thumbnail.
      connection.events.add(RemoteSessionEvent('agent.events', 's1', agentEvent('message_start', message)));
      await tester.pump();
      connection.events.add(RemoteSessionEvent('agent.events', 's1', agentEvent('message_update', message)));
      await tester.pump();
      expect(find.byType(ChatImage), findsNothing, reason: 'streaming snapshots must not place images');

      connection.events.add(RemoteSessionEvent('agent.events', 's1', agentEvent('message_end', message)));
      await tester.pump();
      await settleImages(tester);

      expect(find.byType(ChatImage), findsOneWidget);
      expect(find.textContaining('这是截图', findRichText: true), findsOneWidget);
    });

    testWidgets('a replayed message_end does not duplicate the image', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      await pumpPage(tester, connection);
      final message = {
        'role': 'assistant',
        'content': [imageBlock],
      };

      for (var i = 0; i < 3; i++) {
        connection.events.add(RemoteSessionEvent('agent.events', 's1', agentEvent('message_end', message)));
        await tester.pump();
      }
      await settleImages(tester);

      expect(find.byType(ChatImage), findsOneWidget);
    });

    testWidgets('two images in one message each get their own thumbnail', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      await pumpPage(tester, connection);

      connection.events.add(RemoteSessionEvent('agent.events', 's1', agentEvent('message_end', {
        'role': 'assistant',
        'content': [imageBlock, imageBlock],
      })));
      await tester.pump();
      await settleImages(tester);

      expect(find.byType(ChatImage), findsNWidgets(2));
    });

    testWidgets('an image that cannot be shown is skipped', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      await pumpPage(tester, connection);

      connection.events.add(RemoteSessionEvent('agent.events', 's1', agentEvent('message_end', {
        'role': 'assistant',
        'content': [
          {'type': 'image', 'data': 'AAAA', 'mimeType': 'image/svg+xml'},
          {'type': 'text', 'text': '文字回复仍然显示'},
        ],
      })));
      // One frame for setState, one for the new row to lay out.
      await tester.pump();
      await tester.pump();

      expect(find.byType(ChatImage), findsNothing);
      expect(find.textContaining('文字回复仍然显示', findRichText: true), findsOneWidget);
    });
  });

  group('live tool results', () {
    testWidgets('a screenshot tool result puts its image on the tool card', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      await pumpPage(tester, connection);

      connection.events.add(RemoteSessionEvent('agent.events', 's1', {
        'type': 'message_end',
        'message': {
          'role': 'assistant',
          'content': [
            {'type': 'toolCall', 'toolCallId': 'c1', 'toolName': 'browser_screenshot', 'input': {'fullPage': false}},
          ],
        },
      }));
      await tester.pump();
      connection.events.add(RemoteSessionEvent('agent.events', 's1', {
        'type': 'message_end',
        'message': {
          'role': 'toolResult',
          'toolCallId': 'c1',
          'toolName': 'browser_screenshot',
          'content': [imageBlock],
        },
      }));
      await tester.pump();
      await settleImages(tester);

      // Images sit in the card body, so the card is collapsed with them inside.
      expect(find.byType(ChatImage), findsNothing);
      // Expand the card: its image is now built.
      await tester.tap(find.textContaining('browser_screenshot'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      await settleImages(tester);
      expect(find.byType(ChatImage), findsOneWidget);
    });
  });

  group('history images', () {
    testWidgets('a deferred image is loaded on demand through sessions.entryContent', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.history = {
        'context': {
          'messages': [
            {
              'role': 'assistant',
              'content': [
                {
                  'type': 'image',
                  'source': {'type': 'url', 'url': ''},
                  'deferredContent': {'entryId': 'entry-9', 'blockIndex': 0, 'contentType': 'image'},
                },
              ],
            },
          ],
        },
      };

      await pumpPage(tester, connection);

      // A paged-history picture is a placeholder until the reader asks for it.
      expect(connection.entryContentRequests, isEmpty);
      expect(find.text('点击加载图片'), findsOneWidget);

      await tester.tap(find.text('点击加载图片'));
      await tester.pump();

      // One tap, one request.
      expect(connection.entryContentRequests, hasLength(1));
      expect(connection.entryContentRequests.single['entryId'], 'entry-9');

      await settleImages(tester);
      expect(find.byType(Image), findsOneWidget);
    });

    testWidgets('an inline history image renders without a round trip', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.history = {
        'context': {
          'messages': [
            {'role': 'assistant', 'content': [imageBlock]},
          ],
        },
      };

      await pumpPage(tester, connection);
      await settleImages(tester);

      expect(find.byType(Image), findsOneWidget);
      expect(connection.entryContentRequests, isEmpty);
    });

    testWidgets('a picture aligns with its sender: user right, assistant left', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.history = {
        'context': {
          'messages': [
            {'role': 'user', 'content': [imageBlock]},
            {'role': 'assistant', 'content': [imageBlock]},
          ],
        },
      };

      await pumpPage(tester, connection);
      await settleImages(tester);

      final pictures = find.byType(ChatImage);
      expect(pictures, findsNWidgets(2));
      final user = tester.getRect(pictures.at(0));
      final assistant = tester.getRect(pictures.at(1));
      // Both are the same 160-wide thumbnail; one sits at the right edge of
      // the transcript, the other at the left.
      expect(user.left, greaterThan(assistant.left + 100),
          reason: 'the user\'s own picture belongs on the right, like their bubbles');
      expect(assistant.left, lessThan(60));
    });
  });
}
