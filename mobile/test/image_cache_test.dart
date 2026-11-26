/// Image byte cache: decode once, bound memory, share concurrent loads, and
/// round-trip placeholders through sessions.entryContent.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/image_cache.dart';
import 'package:pi_remote/widgets/image_block.dart';
import 'package:pi_remote/widgets/session_models.dart';

ImageRef inline(String data, [String mime = 'image/png']) => ImageRef(InlineImage(data, mime));

ImageRef deferred(String entryId, [int blockIndex = 0]) => ImageRef(DeferredImage(entryId, blockIndex));

/// One pixel of valid PNG, so decode results are realistic sizes.
final png1x1 = base64Encode([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, //
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
  0x42, 0x60, 0x82,
]);

/// The answer the PC gives for any entry: one valid PNG.
Map<String, dynamic> pngEntryContent() => {
      'content': {'type': 'image', 'data': png1x1, 'mimeType': 'image/png'},
    };

/// A loader that records what was asked and always answers with `pngEntryContent`.
EntryContentLoader recordingLoader(List<String> loads) => (entryId, blockIndex) async {
      loads.add('$entryId:$blockIndex');
      return pngEntryContent();
    };

void main() {
  late List<String> loads;
  late TranscriptImageCache cache;

  setUp(() {
    loads = [];
    cache = TranscriptImageCache(recordingLoader(loads));
  });

  group('inline blocks', () {
    test('decode base64 once and reuse on every later lookup', () async {
      final ref = inline(png1x1);

      final first = await cache.bytesFor(ref, sessionId: 's');
      final second = await cache.bytesFor(ref, sessionId: 's');

      expect(first!.bytes, base64Decode(png1x1));
      expect(first.mimeType, 'image/png');
      expect(identical(first, second), isTrue);
      expect(loads, isEmpty, reason: 'inline bytes never need the PC');
    });

    test('the same image in two sessions is two cache entries', () async {
      final ref = inline(png1x1);

      await cache.bytesFor(ref, sessionId: 'a');
      expect(cache.isCached(ref, sessionId: 'a'), isTrue);
      expect(cache.isCached(ref, sessionId: 'b'), isFalse);
    });

    test('a malformed base64 throws and is not cached', () async {
      final ref = inline('not*valid*base64');

      await expectLater(cache.bytesFor(ref, sessionId: 's'), throwsA(isA<FormatException>()));
      expect(cache.isCached(ref, sessionId: 's'), isFalse);
    });
  });

  group('deferred placeholders', () {
    test('the bytes come back through the entry content loader', () async {
      final ref = deferred('entry-7', 3);

      final result = await cache.bytesFor(ref, sessionId: 's');

      expect(result!.bytes, base64Decode(png1x1));
      expect(loads, ['entry-7:3']);
    });

    test('a second lookup is served from the cache, not the PC', () async {
      final ref = deferred('entry-7');

      await cache.bytesFor(ref, sessionId: 's');
      await cache.bytesFor(ref, sessionId: 's');

      expect(loads, hasLength(1));
    });

    test('a null response resolves to null', () async {
      final cacheMiss = TranscriptImageCache((_, _) async => null);

      expect(await cacheMiss.bytesFor(deferred('gone'), sessionId: 's'), isNull);
    });

    test('a response whose content is not an image resolves to null', () async {
      final cacheText = TranscriptImageCache(
        (_, _) async => {
          'content': {'type': 'text', 'text': 'not an image'},
        },
      );

      expect(await cacheText.bytesFor(deferred('e'), sessionId: 's'), isNull);
    });

    test('a response that is itself a placeholder resolves to null', () async {
      // The PC re-stripped the block (e.g. the entry changed): nothing to show.
      final cacheStill = TranscriptImageCache(
        (_, _) async => {
          'content': {
            'type': 'image',
            'source': {'type': 'url', 'url': ''},
            'deferredContent': {'entryId': 'e', 'contentType': 'image'},
          },
        },
      );

      expect(await cacheStill.bytesFor(deferred('e'), sessionId: 's'), isNull);
    });

    test('a loader error propagates and is not cached', () async {
      var attempts = 0;
      final flaky = TranscriptImageCache((_, _) async {
        attempts += 1;
        if (attempts == 1) throw StateError('rpc down');
        return {
          'content': {'type': 'image', 'data': png1x1, 'mimeType': 'image/png'},
        };
      });
      final ref = deferred('entry-1');

      await expectLater(flaky.bytesFor(ref, sessionId: 's'), throwsStateError);
      expect(flaky.isCached(ref, sessionId: 's'), isFalse);

      final retried = await flaky.bytesFor(ref, sessionId: 's');
      expect(retried, isNotNull);
      expect(attempts, 2);
    });
  });

  group('concurrent loads', () {
    test('callers asking at the same time share one request', () async {
      final gate = Completer<Map<dynamic, dynamic>?>();
      var calls = 0;
      final slow = TranscriptImageCache((_, _) {
        calls += 1;
        return gate.future;
      });
      final ref = deferred('entry-1');

      final a = slow.bytesFor(ref, sessionId: 's');
      final b = slow.bytesFor(ref, sessionId: 's');
      gate.complete(pngEntryContent());
      final results = await Future.wait([a, b]);

      expect(calls, 1);
      expect(results[0], same(results[1]));
    });

    test('different images load independently', () async {
      final gate = Completer<void>();
      var calls = 0;
      final slow = TranscriptImageCache((_, _) async {
        calls += 1;
        await gate.future;
        return {
          'content': {'type': 'image', 'data': png1x1, 'mimeType': 'image/png'},
        };
      });

      final a = slow.bytesFor(deferred('a'), sessionId: 's');
      final b = slow.bytesFor(deferred('b'), sessionId: 's');
      gate.complete();
      await Future.wait([a, b]);

      expect(calls, 2);
    });
  });

  group('memory bound', () {
    test('the least recently used image is evicted past capacity', () async {
      final small = TranscriptImageCache(recordingLoader(loads), capacity: 2);

      await small.bytesFor(deferred('a'), sessionId: 's');
      await small.bytesFor(deferred('b'), sessionId: 's');
      // Touch "a" so "b" becomes the least recently used.
      await small.bytesFor(deferred('a'), sessionId: 's');
      await small.bytesFor(deferred('c'), sessionId: 's');

      expect(small.isCached(deferred('a'), sessionId: 's'), isTrue);
      expect(small.isCached(deferred('b'), sessionId: 's'), isFalse);
      expect(small.isCached(deferred('c'), sessionId: 's'), isTrue);
    });

    test('clear drops everything', () async {
      final ref = deferred('a');
      await cache.bytesFor(ref, sessionId: 's');

      cache.clear();

      expect(cache.isCached(ref, sessionId: 's'), isFalse);
    });

    test('a result that does not fit the budget is still evictable', () async {
      final tiny = TranscriptImageCache(recordingLoader(loads), capacity: 1);
      await tiny.bytesFor(deferred('a'), sessionId: 's');
      await tiny.bytesFor(deferred('b'), sessionId: 's');
      await tiny.bytesFor(deferred('c'), sessionId: 's');

      expect(tiny.isCached(deferred('a'), sessionId: 's'), isFalse);
      expect(tiny.isCached(deferred('b'), sessionId: 's'), isFalse);
      expect(tiny.isCached(deferred('c'), sessionId: 's'), isTrue);
    });
  });
}
