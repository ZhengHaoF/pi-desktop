/// Chat thumbnails and the full-screen viewer: inline render, deferred
/// loading states, retry, and the viewer's tap targets.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/image_cache.dart';
import 'package:pi_remote/widgets/chat_image.dart';
import 'package:pi_remote/widgets/image_block.dart';
import 'package:pi_remote/widgets/session_models.dart';

final png1x1 = base64Encode([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, //
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
  0x42, 0x60, 0x82,
]);

Future<void> pumpImage(WidgetTester tester, Widget image) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: image)));
  await tester.pump();
}

void main() {
  group('ChatImage', () {
    testWidgets('an inline image renders without asking the PC', (tester) async {
      var loads = 0;
      final cache = TranscriptImageCache((_, _) async {
        loads += 1;
        return null;
      });
      final ref = ImageRef(InlineImage(png1x1, 'image/png'));

      await pumpImage(tester, ChatImage(ref: ref, sessionId: 's', cache: cache));
      await tester.pump();

      expect(find.byType(Image), findsOneWidget);
      expect(loads, 0);
    });

    testWidgets('a deferred image waits for a tap before requesting anything', (tester) async {
      var loads = 0;
      final cache = TranscriptImageCache((_, _) async {
        loads += 1;
        return null;
      });
      final ref = ImageRef(DeferredImage('e-1', 0));

      await pumpImage(tester, ChatImage(ref: ref, sessionId: 's', cache: cache, alt: '旧图标'));
      await tester.pump();

      expect(find.text('点击加载图片'), findsOneWidget);
      // The alt says which picture is waiting.
      expect(find.text('旧图标'), findsOneWidget);
      expect(loads, 0, reason: 'scrolling past a picture must not spend data on it');
    });

    testWidgets('tapping a deferred image loads it and shows a spinner meanwhile', (tester) async {
      final gate = Completer<Map<dynamic, dynamic>?>();
      final cache = TranscriptImageCache((_, _) => gate.future);
      final ref = ImageRef(DeferredImage('e-1', 0));

      await pumpImage(tester, ChatImage(ref: ref, sessionId: 's', cache: cache));
      expect(find.byType(CircularProgressIndicator), findsNothing);

      await tester.tap(find.text('点击加载图片'));
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('点击加载图片'), findsNothing);

      gate.complete({
        'content': {'type': 'image', 'data': png1x1, 'mimeType': 'image/png'},
      });
      await tester.pump();
      // Bytes arriving is not the same as a decoded frame: the thumbnail
      // keeps its spinner until the image codec finishes.
      await tester.runAsync(() async {
        await tester.pump();
        // Let the codec complete a real decode.
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pump();

      expect(find.byType(Image), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('a failed load offers a retry that asks again', (tester) async {
      var attempts = 0;
      final cache = TranscriptImageCache((_, _) async {
        attempts += 1;
        if (attempts == 1) throw StateError('rpc down');
        return {
          'content': {'type': 'image', 'data': png1x1, 'mimeType': 'image/png'},
        };
      });
      final ref = ImageRef(DeferredImage('e-1', 0));

      await pumpImage(tester, ChatImage(ref: ref, sessionId: 's', cache: cache));
      await tester.tap(find.text('点击加载图片'));
      await tester.pump();
      await tester.pump();

      expect(find.text('图片加载失败，点击重试'), findsOneWidget);
      expect(attempts, 1);

      await tester.tap(find.text('图片加载失败，点击重试'));
      await tester.pump();
      await tester.pump();

      expect(find.byType(Image), findsOneWidget);
      expect(attempts, 2);
    });

    testWidgets('a response with nothing to show is treated as a failure', (tester) async {
      final cache = TranscriptImageCache((_, _) async => {'content': {'type': 'text', 'text': 'x'}});
      final ref = ImageRef(DeferredImage('e-1', 0));

      await pumpImage(tester, ChatImage(ref: ref, sessionId: 's', cache: cache));
      await tester.tap(find.text('点击加载图片'));
      await tester.pump();
      await tester.pump();

      expect(find.text('图片加载失败，点击重试'), findsOneWidget);
    });

    testWidgets('tapping a loaded thumbnail opens the viewer', (tester) async {
      final cache = TranscriptImageCache((_, _) async => null);
      final ref = ImageRef(InlineImage(png1x1, 'image/png'));

      await pumpImage(tester, ChatImage(ref: ref, sessionId: 's', cache: cache));
      await tester.pump();
      await tester.tap(find.byType(Image));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(find.byType(ImageViewer), findsOneWidget);
    });
  });

  group('ImageViewer', () {
    // The viewer is always pushed, never a home route: without a route
    // underneath there is nothing for maybePop() to return to.
    Future<void> pumpViewer(WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: Center(
                child: TextButton(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => ImageViewer(bytes: base64Decode(png1x1), mimeType: 'image/png'),
                    ),
                  ),
                  child: const Text('open'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
    }

    testWidgets('opens over the previous route', (tester) async {
      await pumpViewer(tester);

      expect(find.byType(ImageViewer), findsOneWidget);
      expect(find.byType(InteractiveViewer), findsOneWidget);
      expect(find.byType(Image), findsOneWidget);
    });

    testWidgets('the close button returns to the previous route', (tester) async {
      await pumpViewer(tester);

      // One frame starts the pop, then the exit transition has to finish
      // before the route leaves the tree.
      await tester.tap(find.byTooltip('关闭'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 400));

      expect(find.byType(ImageViewer), findsNothing);
      expect(find.text('open'), findsOneWidget);
    });

    testWidgets('the system back gesture returns to the previous route', (tester) async {
      await pumpViewer(tester);

      await tester.binding.handlePopRoute();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 400));

      expect(find.byType(ImageViewer), findsNothing);
    });

    testWidgets('zoom and pan are available, and dragging never closes', (tester) async {
      await pumpViewer(tester);
      final viewer = tester.widget<InteractiveViewer>(find.byType(InteractiveViewer));

      expect(viewer.minScale, 1);
      expect(viewer.maxScale, 5);

      final center = tester.getCenter(find.byType(InteractiveViewer));
      final gesture = await tester.startGesture(center);
      await gesture.moveBy(const Offset(0, -80));
      await gesture.up();
      await tester.pump();

      expect(find.byType(ImageViewer), findsOneWidget);
    });
  });
}
