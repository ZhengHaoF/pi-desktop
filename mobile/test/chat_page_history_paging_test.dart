/// History paging in the chat page: the first page is windowed, older pages
/// prepend without moving the reader, and message ordinals stay unique across
/// pages so live events never collide with history.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/remote_connection.dart';
import 'package:pi_remote/pages/chat_page.dart';

/// Records every request and answers from a script the test controls.
class FakeConnection extends RemoteConnection {
  final requests = <String>[];
  final params = <String, Object?>{};
  final _answers = <String, Future<Map<String, dynamic>> Function()>{};

  FakeConnection({
    required super.relayUrl,
    required super.deviceId,
    required super.deviceLabel,
  });

  /// Answer `method` with the result of [produce] from now on.
  void on(String method, Future<Map<String, dynamic>> Function() produce) {
    _answers[method] = produce;
  }

  @override
  Future<void> subscribe(String topic, String key) async {}

  @override
  Future<void> unsubscribe(String topic, String key) async {}

  @override
  Future<Map<String, dynamic>> request(String method, Object? params) async {
    requests.add(method);
    this.params[method] = params;
    final answer = _answers[method];
    if (answer != null) return answer();
    if (method == 'sessions.list') return {'runningSessionIds': <dynamic>[]};
    if (method == 'models.preferences.get') return {'models': <dynamic>[]};
    return <String, dynamic>{};
  }
}

Map<String, dynamic> message(String role, String text) => {'role': role, 'content': text};

/// A paged detail whose `context` carries the paging fields a real PC sends.
Map<String, dynamic> pagedDetail({
  required List<Map<String, dynamic>> messages,
  required int totalMessages,
  String? previousCursor,
}) => {
      'context': {
        'messages': messages,
        'totalMessages': totalMessages,
        'loadedMessages': messages.length,
        'truncatedBefore': previousCursor != null,
        'previousCursor': ?previousCursor,
        'historyRevision': 'rev-1',
      },
    };

/// Turn a long page into lines tall enough to scroll.
List<Map<String, dynamic>> longPage(int count, String prefix) => [
      for (var i = 0; i < count; i++) ...[
        message('user', '$prefix q $i'),
        message('assistant', '$prefix a $i ${'x' * 40}'),
      ],
    ];

Future<void> pumpPage(WidgetTester tester, FakeConnection connection) async {
  await tester.pumpWidget(MaterialApp(home: ChatPage(connection: connection, sessionId: 's1', title: '会话')));
  // Let sessions.get resolve and the first frame settle.
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
}

/// The transcript's scroll controller, as wired by the chat page.
ScrollController listController(WidgetTester tester) =>
    tester.widget<ListView>(find.byType(ListView)).controller!;

void main() {
  group('first page', () {
    testWidgets('sessions.get asks for a windowed history', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.on('sessions.get', () async => pagedDetail(messages: [], totalMessages: 0));

      await pumpPage(tester, connection);

      final params = connection.params['sessions.get'] as Map;
      expect(params['historyWindow'], {'maxTurns': 10, 'maxBytes': 1024 * 1024});
    });

    testWidgets('an unpaged response still renders (older PC or test fixture)', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.on('sessions.get', () async => {
            'context': {'messages': [message('user', '你好'), message('assistant', '你好！')]},
          });

      await pumpPage(tester, connection);

      expect(find.text('你好'), findsOneWidget);
      // Nothing older to load, so no control is offered.
      expect(find.text('加载更早的消息'), findsNothing);
    });

    testWidgets('a truncated history offers the older page', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.on(
        'sessions.get',
        () async => pagedDetail(messages: longPage(2, 'new'), totalMessages: 40, previousCursor: 'c1'),
      );

      await pumpPage(tester, connection);

      expect(find.text('加载更早的消息'), findsOneWidget);
    });
  });

  group('loading an older page', () {
    testWidgets('scrolling up to the top loads the page before and keeps the reader in place',
        (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.on(
        'sessions.get',
        () async => pagedDetail(messages: longPage(8, 'new'), totalMessages: 80, previousCursor: 'c1'),
      );
      var olderCalls = 0;
      connection.on('sessions.contextPage', () async {
        olderCalls += 1;
        return {'context': pagedDetail(messages: longPage(8, 'old'), totalMessages: 80)['context']};
      });

      await pumpPage(tester, connection);
      // Scroll up toward the top. Getting within the trigger distance is what
      // loads the older page; no tap is needed on the normal path.
      await tester.drag(find.byType(ListView), const Offset(0, -400));
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 60));
      }
      expect(olderCalls, 1, reason: 'reaching the top should load the older page');

      // Settle any remaining scroll, then check the reader did not get moved.
      await tester.pumpAndSettle();
      final offset = listController(tester).offset;
      final max = listController(tester).position.maxScrollExtent;
      // The prepended page grew the list upward. The viewport was moved down
      // by that growth, so it is no longer at the top it reached for.
      expect(max, greaterThan(0));
      expect(offset, greaterThan(0), reason: 'the reader is held where they were, not snapped to the new top');

      // Jump to the very top: the prepended page is what the reader finds
      // there. (A plain drag cannot be used to look for it, because lazy
      // building means the rows do not exist until they are on screen, which
      // is also why only the top rows are asserted here.)
      listController(tester).jumpTo(0);
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 60));
      }
      expect(find.text('old q 0'), findsOneWidget);
    });

    testWidgets('the request carries the cursor and the same window', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.on(
        'sessions.get',
        () async => pagedDetail(messages: longPage(2, 'new'), totalMessages: 40, previousCursor: 'cursor-abc'),
      );
      connection.on('sessions.contextPage', () async => {'context': pagedDetail(messages: [], totalMessages: 40)['context']});

      await pumpPage(tester, connection);
      await tester.tap(find.text('加载更早的消息'));
      await tester.pump(const Duration(milliseconds: 60));

      final params = connection.params['sessions.contextPage'] as Map;
      expect(params['cursor'], 'cursor-abc');
      expect(params['maxTurns'], 10);
      expect(params['maxBytes'], 1024 * 1024);
    });

    testWidgets('a stale cursor stops paging without surfacing an error', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.on(
        'sessions.get',
        () async => pagedDetail(messages: longPage(2, 'new'), totalMessages: 40, previousCursor: 'stale'),
      );
      connection.on(
        'sessions.contextPage',
        () async => throw const RpcException('STALE_CURSOR', 'Session history changed; reload the latest page'),
      );

      await pumpPage(tester, connection);
      await tester.tap(find.text('加载更早的消息'));
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 60));
      }

      expect(find.textContaining('Session history changed'), findsNothing);
      expect(find.text('加载更早的消息'), findsNothing);
      expect(find.text('加载失败，点击重试'), findsNothing,
          reason: 'a stale cursor is not a retryable failure');
      expect(find.textContaining('new q 0'), findsOneWidget);
    });

    testWidgets('a transient failure keeps the cursor and offers a retry', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.on(
        'sessions.get',
        () async => pagedDetail(messages: longPage(2, 'new'), totalMessages: 40, previousCursor: 'c1'),
      );
      var attempts = 0;
      connection.on('sessions.contextPage', () async {
        attempts += 1;
        if (attempts == 1) throw const RpcException('GATEWAY_TIMEOUT', 'gateway did not answer in time');
        return {'context': pagedDetail(messages: longPage(1, 'old'), totalMessages: 40)['context']};
      });

      await pumpPage(tester, connection);
      await tester.tap(find.text('加载更早的消息'));
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 60));
      }

      // Paging is not dead: the reader can try again.
      expect(find.text('加载失败，点击重试'), findsOneWidget);
      expect(find.textContaining('gateway did not answer'), findsNothing,
          reason: 'a transient failure should not be a banner');

      await tester.tap(find.text('加载失败，点击重试'));
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 60));
      }

      expect(attempts, 2);
      expect(find.text('加载失败，点击重试'), findsNothing);
      expect(find.textContaining('old q 0'), findsOneWidget);
    });

    testWidgets('the control disappears once the last page is loaded', (tester) async {
      final connection = FakeConnection(relayUrl: 'ws://r', deviceId: 'd', deviceLabel: 'phone');
      connection.on(
        'sessions.get',
        () async => pagedDetail(messages: longPage(2, 'new'), totalMessages: 6, previousCursor: 'c1'),
      );
      connection.on(
        'sessions.contextPage',
        () async => {'context': pagedDetail(messages: longPage(1, 'old'), totalMessages: 6)['context']},
      );

      await pumpPage(tester, connection);
      expect(find.text('加载更早的消息'), findsOneWidget);

      await tester.tap(find.text('加载更早的消息'));
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 60));
      }

      expect(find.text('加载更早的消息'), findsNothing);
      expect(find.textContaining('old q 0'), findsOneWidget);
    });
  });
}
