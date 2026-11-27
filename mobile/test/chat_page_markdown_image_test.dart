/// End to end on the chat page: a reply whose prose names a picture by path
/// (`![logo](D:\work\app\res\icon-512.png)`) is read from the PC and shown.
///
/// This is how the agent usually "sends" a picture. Before this was handled
/// the phone showed `!logo` as a blue link instead.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/remote_connection.dart';
import 'package:pi_remote/pages/chat_page.dart';

/// One transparent 1x1 PNG.
const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const sessionCwd = r'D:\work\carhome';

class FakeConnection extends RemoteConnection {
  final events = StreamController<RemoteSessionEvent>.broadcast();
  final fileReads = <Map<Object?, Object?>>[];
  Map<String, dynamic> history = {'context': {'messages': <dynamic>[]}};
  Map<String, dynamic>? detailExtra;

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
        return <String, dynamic>{...history, ...?detailExtra};
      case 'sessions.list':
        return {'runningSessionIds': <dynamic>[]};
      case 'models.preferences.get':
        return {'models': <dynamic>[]};
      case 'files.read':
        final map = params as Map;
        fileReads.add({'path': map['path'], 'sourceSessionId': map['sourceSessionId']});
        // Paths arrive normalised to forward slashes.
        if (map['path'] == 'D:/work/carhome/res/missing.png') {
          throw StateError('rpc error: NOT_FOUND');
        }
        return {'content': pngBase64, 'encoding': 'base64', 'mime': 'image/png'};
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

/// Let the request round trip and the image codec both finish.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump();
  }
  await tester.pump();
}

/// The reply from the bug report, shortened but in its original shape.
const logoReply =
    '当前 logo（512 px 原图）：\n'
    r'![CarHome 当前图标](D:\work\carhome\res\icon-512.png)'
    '\n48 px 实际尺寸效果：\n'
    r'![48px 预览](D:\work\carhome\res\icon-preview-48.png)';

/// Tap every "load this picture" placeholder on screen, one at a time. A
/// picture named by path costs a files.read, so it waits for the reader.
Future<void> loadPictures(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    final placeholder = find.text('点击加载图片');
    if (placeholder.evaluate().isEmpty) return;
    await tester.tap(placeholder.first);
    await tester.pump();
  }
}

void main() {
  group('from history', () {
    testWidgets('a reply naming pictures by path shows the pictures', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.history = {
        'context': {
          'messages': [
            {'role': 'user', 'content': '把现在的 logo 发给我'},
            {'role': 'assistant', 'content': [{'type': 'text', 'text': logoReply}]},
          ],
        },
      };
      connection.detailExtra = {'info': {'cwd': sessionCwd}};

      await pumpPage(tester, connection);
      // Nothing is fetched until the reader asks.
      expect(connection.fileReads, isEmpty);
      expect(find.text('点击加载图片'), findsNWidgets(2));

      await loadPictures(tester);
      await settle(tester);

      expect(find.byType(Image), findsNWidgets(2));
      // The prose around the pictures is still there.
      expect(find.textContaining('当前 logo', findRichText: true), findsOneWidget);
      expect(find.textContaining('48 px', findRichText: true), findsOneWidget);
      // And the alt text is not rendered as a link with a stray "!".
      expect(find.textContaining('!CarHome', findRichText: true), findsNothing);
      expect(find.textContaining('!48px', findRichText: true), findsNothing);
    });

    testWidgets('each picture is read once from the PC, with the session for authorization',
        (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.history = {
        'context': {
          'messages': [
            {'role': 'assistant', 'content': [{'type': 'text', 'text': logoReply}]},
          ],
        },
      };
      connection.detailExtra = {'info': {'cwd': sessionCwd}};

      await pumpPage(tester, connection);
      expect(connection.fileReads, isEmpty);

      await loadPictures(tester);
      await settle(tester);

      expect(connection.fileReads, hasLength(2));
      expect(
        connection.fileReads.map((read) => read['path']),
        ['D:/work/carhome/res/icon-512.png', 'D:/work/carhome/res/icon-preview-48.png'],
      );
      expect(connection.fileReads.every((read) => read['sourceSessionId'] == 's1'), isTrue);
    });
  });

  group('relative paths', () {
    testWidgets('a relative path resolves against the session cwd', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.history = {
        'context': {
          'messages': [
            {'role': 'assistant', 'content': '![预览](res/mipmap-xxxhdpi/ic_launcher.png)'},
          ],
        },
      };
      connection.detailExtra = {'info': {'cwd': sessionCwd}};

      await pumpPage(tester, connection);
      await loadPictures(tester);
      await settle(tester);

      expect(find.byType(Image), findsOneWidget);
      expect(connection.fileReads.single['path'], 'D:/work/carhome/res/mipmap-xxxhdpi/ic_launcher.png');
    });
  });

  group('live', () {
    testWidgets('a reply streamed while attached shows its pictures', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.detailExtra = {'info': {'cwd': sessionCwd}};
      await pumpPage(tester, connection);

      final content = [
        {'type': 'text', 'text': logoReply},
      ];
      // Streaming: the same text grows through snapshots, then ends.
      for (final text in ['当前 logo', logoReply, logoReply]) {
        connection.events.add(RemoteSessionEvent('agent.events', 's1', {
          'type': 'message_update',
          'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': text}]},
        }));
        await tester.pump();
      }
      connection.events.add(RemoteSessionEvent('agent.events', 's1', {
        'type': 'message_end',
        'message': {'role': 'assistant', 'content': content},
      }));
      await tester.pump();
      await tester.pump();

      expect(find.text('点击加载图片'), findsNWidgets(2));
      await loadPictures(tester);
      await settle(tester);

      expect(find.byType(Image), findsNWidgets(2));
    });

    testWidgets('rebuilds while streaming do not re-read the same picture', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.detailExtra = {'info': {'cwd': sessionCwd}};
      await pumpPage(tester, connection);

      final text = '![a](D:\\work\\carhome\\res\\icon-512.png)';
      for (var i = 0; i < 4; i++) {
        connection.events.add(RemoteSessionEvent('agent.events', 's1', {
          'type': 'message_update',
          'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': '$text $i'}]},
        }));
        await tester.pump();
        // The event arrives through a stream, so the row is laid out on the
        // frame after the one that handles it.
        await tester.pump();
        if (i == 0) {
          // Load it once, then keep streaming: the picture must survive the
          // rebuilds without being fetched again.
          await loadPictures(tester);
          await settle(tester);
        }
      }
      await settle(tester);

      expect(find.byType(Image), findsOneWidget);
      expect(connection.fileReads, hasLength(1), reason: 'one picture, one read');
    });
  });

  group('when the picture cannot be shown', () {
    testWidgets('a web image stays as text and is never requested from the PC', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.history = {
        'context': {
          'messages': [
            {'role': 'assistant', 'content': '![x](https://example.com/a.png)'},
          ],
        },
      };

      await pumpPage(tester, connection);
      await settle(tester);

      expect(connection.fileReads, isEmpty);
      expect(find.byType(Image), findsNothing);
    });

    testWidgets('a missing file shows a retry with the alt, and the reply is intact', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.history = {
        'context': {
          'messages': [
            {'role': 'assistant', 'content': r'文字说明 ![旧图标](D:\work\carhome\res\missing.png) 结尾'},
          ],
        },
      };

      await pumpPage(tester, connection);
      // The read only happens on request.
      expect(connection.fileReads, isEmpty);
      await loadPictures(tester);
      await settle(tester);

      expect(find.byType(Image), findsNothing);
      expect(find.text('图片加载失败，点击重试'), findsOneWidget);
      expect(find.text('旧图标'), findsOneWidget);
      expect(find.textContaining('文字说明', findRichText: true), findsOneWidget);
      expect(find.textContaining('结尾', findRichText: true), findsOneWidget);
    });
  });
}
