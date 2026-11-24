/// 回归测试：输入框要随长文本换行长高，而不是把整段文字压成一行横向滚动。
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

  @override
  bool get isReady => true;

  @override
  Future<void> subscribe(String topic, String key) async {}

  @override
  Future<void> unsubscribe(String topic, String key) async {}

  @override
  Future<Map<String, dynamic>> request(String method, Object? params) async {
    switch (method) {
      case 'sessions.get':
        return {'context': {'messages': <dynamic>[]}};
      case 'sessions.list':
        return {'runningSessionIds': <dynamic>[]};
      case 'models.preferences.get':
        return {'models': <dynamic>[]};
      default:
        return <String, dynamic>{};
    }
  }
}

Future<void> pumpFrames(WidgetTester tester, Widget child) async {
  await tester.pumpWidget(MaterialApp(home: child));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  testWidgets('输入框声明为可换行的多行框，而不是单行', (tester) async {
    final connection = FakeConnection(
      relayUrl: 'ws://relay.example:8788/ws',
      deviceId: 'dev-1',
      deviceLabel: 'phone',
    );

    await pumpFrames(tester, ChatPage(connection: connection, sessionId: 's1', title: '会话'));

    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.minLines, 1);
    expect(field.maxLines, 5, reason: '多行框要有上限，避免整屏都被输入框吃掉');
    expect(field.textInputAction, TextInputAction.send, reason: '回车键保持发送语义');
  });

  testWidgets('长文本让输入框变高', (tester) async {
    final connection = FakeConnection(
      relayUrl: 'ws://relay.example:8788/ws',
      deviceId: 'dev-1',
      deviceLabel: 'phone',
    );

    await pumpFrames(tester, ChatPage(connection: connection, sessionId: 's1', title: '会话'));
    final singleLineHeight = tester.getSize(find.byType(TextField)).height;

    await tester.enterText(
      find.byType(TextField),
      '把 600×800 的 browser_device 设好之后，再跑一遍 browser_screenshot，'
      '确认 viewport 模式不再是 1×1 纯白图，然后顺手把 full-page 的对比图也存下来。',
    );
    await tester.pump();

    final wrappedHeight = tester.getSize(find.byType(TextField)).height;
    expect(wrappedHeight, greaterThan(singleLineHeight), reason: '文字换行后输入框应随内容长高');
    // 五行为上限：再长的正文只能框内滚动，不能无限撑高。
    await tester.enterText(
      find.byType(TextField),
      List.filled(40, '这是一段很长的指令文本，用来验证输入框的高度上限。').join(''),
    );
    await tester.pump();
    expect(tester.getSize(find.byType(TextField)).height, lessThanOrEqualTo(wrappedHeight * 2),
        reason: '达到 maxLines 后高度必须封顶');
  });
}
