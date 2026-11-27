/// Widget tests for picking, previewing, removing, sending, and rolling back
/// image attachments in [ChatPage].
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/image_attachments.dart';
import 'package:pi_remote/core/remote_connection.dart';
import 'package:pi_remote/pages/chat_page.dart';
import 'package:pi_remote/widgets/image_attachments_bar.dart';

const _pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
final _pngBytes = base64Decode(_pngBase64);

class _FakeConnection extends RemoteConnection {
  final events = StreamController<RemoteSessionEvent>.broadcast();
  final commands = <Map<String, dynamic>>[];
  final requests = <Map<String, Object?>>[];
  Object? commandError;
  bool ready = true;

  List<Map<String, dynamic>> get messageCommands =>
      commands.where((c) => c['type'] == 'prompt' || c['type'] == 'steer' || c['type'] == 'follow_up').toList();

  _FakeConnection()
      : super(
          relayUrl: 'ws://relay.example:8788/ws',
          deviceId: 'dev-1',
          deviceLabel: 'phone',
        );

  @override
  bool get isReady => ready;

  @override
  Stream<RemoteSessionEvent> get onEvent => events.stream;

  @override
  Future<void> subscribe(String topic, String key) async {}

  @override
  Future<void> unsubscribe(String topic, String key) async {}

  @override
  Future<Map<String, dynamic>> request(String method, Object? params) async {
    requests.add({'method': method, 'params': params});
    switch (method) {
      case 'sessions.get':
        return {'context': {'messages': <dynamic>[]}};
      case 'sessions.list':
        return {'runningSessionIds': <dynamic>[]};
      case 'models.preferences.get':
        return {'models': <dynamic>[]};
      case 'agent.new':
        return {'sessionId': 's-new'};
      default:
        return <String, dynamic>{};
    }
  }

  @override
  Future<Map<String, dynamic>> agentCommand(String sessionId, Map<String, dynamic> command) async {
    if (commandError != null) throw commandError!;
    commands.add({'sessionId': sessionId, ...command});
    return <String, dynamic>{};
  }
}

Future<void> _pumpChat(
  WidgetTester tester,
  _FakeConnection connection, {
  String? sessionId = 's1',
  String? newTaskCwd,
  PickImagesFn? pickImages,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ChatPage(
        connection: connection,
        title: '测试会话',
        sessionId: sessionId,
        newTaskCwd: newTaskCwd,
        pickImages: pickImages,
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));
}

Future<void> _attachFromGallery(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('composer-attach-image')));
  for (var i = 0; i < 4; i++) {
    await tester.pump(const Duration(milliseconds: 80));
  }
  await tester.tap(find.byKey(const Key('attach-source-gallery')));
  for (var i = 0; i < 4; i++) {
    await tester.pump(const Duration(milliseconds: 80));
  }
}

/// Let TranscriptImageCache and Image.memory codec finish decoding.
Future<void> _settleImages(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump();
  }
  await tester.pump();
}

void main() {
  testWidgets('attaches image from picker, removes it, and toggles send button', (tester) async {
    final connection = _FakeConnection();
    await _pumpChat(
      tester,
      connection,
      pickImages: (source, {int remainingSlots = maxAttachedImages}) async {
        expect(source, ImagePickSource.gallery);
        expect(remainingSlots, 4);
        return [PickedImageFile(bytes: _pngBytes, name: 'shot.png')];
      },
    );

    // Send is initially disabled while draft and attachments are both empty.
    await tester.tap(find.byKey(const Key('composer-send')));
    await tester.pump();
    expect(connection.commands, isEmpty);

    await _attachFromGallery(tester);
    expect(find.byType(PendingImagesBar), findsOneWidget);
    expect(find.byKey(const Key('remove-attached-image-0')), findsOneWidget);

    await tester.tap(find.byKey(const Key('remove-attached-image-0')));
    await tester.pump();
    expect(find.byKey(const Key('remove-attached-image-0')), findsNothing);
  });

  testWidgets('sends image-only message and swaps optimistic preview on message_end', (tester) async {
    final connection = _FakeConnection();
    await _pumpChat(
      tester,
      connection,
      pickImages: (_, {int remainingSlots = maxAttachedImages}) async => [
        PickedImageFile(bytes: _pngBytes, name: 'logo.png'),
      ],
    );

    await _attachFromGallery(tester);
    await tester.tap(find.byKey(const Key('composer-send')));
    await tester.pump();

    expect(connection.messageCommands, hasLength(1));
    expect(connection.messageCommands.single, {
      'sessionId': 's1',
      'type': 'prompt',
      'message': '',
      'images': [
        {'type': 'image', 'data': _pngBase64, 'mimeType': 'image/png'},
      ],
    });
    expect(find.byType(SendingImageBubble), findsOneWidget);
    expect(find.byKey(const Key('remove-attached-image-0')), findsNothing);

    // PC echoes the user message with its image block.
    connection.events.add(RemoteSessionEvent('agent.events', 's1', {
      'type': 'message_start',
      'message': {'role': 'user', 'content': []},
    }));
    connection.events.add(RemoteSessionEvent('agent.events', 's1', {
      'type': 'message_end',
      'message': {
        'role': 'user',
        'content': [
          {'type': 'image', 'data': _pngBase64, 'mimeType': 'image/png'},
        ],
      },
    }));
    await _settleImages(tester);
    expect(find.byType(SendingImageBubble), findsNothing);
    expect(find.byType(Image), findsOneWidget);
  });

  testWidgets('steers with images mid-turn and restores attachments when send fails', (tester) async {
    final connection = _FakeConnection();
    await _pumpChat(
      tester,
      connection,
      pickImages: (_, {int remainingSlots = maxAttachedImages}) async => [
        PickedImageFile(bytes: _pngBytes, name: 'bug.png'),
      ],
    );

    // Put the session into running state, then send text + image as steer.
    connection.events.add(RemoteSessionEvent('agent.running', 'global', {
      'runningSessionIds': ['s1'],
    }));
    await tester.pump();

    await tester.enterText(find.byType(TextField), '看下这张图');
    await _attachFromGallery(tester);
    await tester.tap(find.byKey(const Key('composer-send')));
    await tester.pump();

    expect(connection.messageCommands.single['type'], 'steer');
    expect(connection.messageCommands.single['message'], '看下这张图');
    expect(connection.messageCommands.single['images'], hasLength(1));

    // Next attempt fails -> text and attachment must be restored to composer.
    connection.commandError = StateError('network down');
    await tester.enterText(find.byType(TextField), '重试消息');
    await _attachFromGallery(tester);
    await tester.tap(find.byKey(const Key('composer-send')));
    await tester.pump();

    expect(find.textContaining('network down'), findsOneWidget);
    expect(tester.widget<TextField>(find.byType(TextField)).controller?.text, '重试消息');
    expect(find.byKey(const Key('remove-attached-image-0')), findsOneWidget);
  });

  testWidgets('new task page creates session first then sends attached images', (tester) async {
    final connection = _FakeConnection();
    await _pumpChat(
      tester,
      connection,
      sessionId: null,
      newTaskCwd: r'D:\work\carhome',
      pickImages: (_, {int remainingSlots = maxAttachedImages}) async => [
        PickedImageFile(bytes: _pngBytes, name: 'new.png'),
      ],
    );

    await _attachFromGallery(tester);
    await tester.tap(find.byKey(const Key('composer-send')));
    await tester.pump();

    expect(connection.requests.any((r) => r['method'] == 'agent.new'), isTrue);
    expect(connection.messageCommands.single['sessionId'], 's-new');
    expect(connection.messageCommands.single['type'], 'prompt');
    expect(connection.messageCommands.single['images'], hasLength(1));
  });
}
