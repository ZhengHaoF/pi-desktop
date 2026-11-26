/// Image block parsing: both wire shapes, the MIME allowlist, and the
/// paged-history placeholder that needs a second request.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/widgets/image_block.dart';

void main() {
  group('inline blocks', () {
    test('Anthropic source shape (pi read tool)', () {
      final parsed = parseImageBlock({
        'type': 'image',
        'source': {'type': 'base64', 'media_type': 'image/png', 'data': 'AAAA'},
      });

      expect(parsed, isA<InlineImage>());
      expect((parsed as InlineImage).base64, 'AAAA');
      expect(parsed.mimeType, 'image/png');
    });

    test('flat data/mimeType shape (this app browser tools)', () {
      final parsed = parseImageBlock({
        'type': 'image',
        'data': 'BBBB',
        'mimeType': 'image/jpeg',
      });

      expect(parsed, isA<InlineImage>());
      expect((parsed as InlineImage).base64, 'BBBB');
      expect(parsed.mimeType, 'image/jpeg');
    });

    test('every raster MIME in the desktop allowlist is accepted', () {
      for (final mime in ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
        expect(
          parseImageBlock({'type': 'image', 'data': 'AAAA', 'mimeType': mime}),
          isA<InlineImage>(),
          reason: mime,
        );
      }
    });

    test('a MIME outside the allowlist is not displayable', () {
      expect(parseImageBlock({'type': 'image', 'data': 'AAAA', 'mimeType': 'image/svg+xml'}), isNull);
    });

    test('a missing MIME is not displayable', () {
      expect(parseImageBlock({'type': 'image', 'data': 'AAAA'}), isNull);
    });

    test('empty base64 data is not displayable', () {
      expect(
        parseImageBlock({
          'type': 'image',
          'source': {'type': 'base64', 'media_type': 'image/png', 'data': ''},
        }),
        isNull,
      );
    });
  });

  group('deferred placeholders (paged history)', () {
    test('the PC strips bytes and leaves entryId + blockIndex', () {
      final parsed = parseImageBlock({
        'type': 'image',
        'source': {'type': 'url', 'url': ''},
        'deferredContent': {
          'entryId': 'entry-7',
          'blockIndex': 3,
          'originalBytes': 204800,
          'contentType': 'image',
        },
      });

      expect(parsed, isA<DeferredImage>());
      final deferred = parsed as DeferredImage;
      expect(deferred.entryId, 'entry-7');
      expect(deferred.blockIndex, 3);
      expect(deferred.base64, isNull);
      expect(deferred.mimeType, isNull);
    });

    test('a placeholder without blockIndex targets block 0', () {
      final parsed = parseImageBlock({
        'type': 'image',
        'source': {'type': 'url', 'url': ''},
        'deferredContent': {'entryId': 'entry-1', 'contentType': 'image'},
      }) as DeferredImage;

      expect(parsed.blockIndex, 0);
    });

    test('an inline block wins over a stale deferred ref', () {
      // sessions.entryContent returns the full block with its deferredContent
      // still attached; the bytes must render, not re-request.
      final parsed = parseImageBlock({
        'type': 'image',
        'source': {'type': 'base64', 'media_type': 'image/png', 'data': 'AAAA'},
        'deferredContent': {'entryId': 'entry-7', 'blockIndex': 0, 'contentType': 'image'},
      });

      expect(parsed, isA<InlineImage>());
    });
  });

  group('blocks that can never be shown', () {
    test('a url-only source is not an attachment', () {
      expect(
        parseImageBlock({
          'type': 'image',
          'source': {'type': 'url', 'url': 'https://example.com/a.png'},
        }),
        isNull,
      );
    });

    test('an empty url placeholder without a ref has nothing to load', () {
      expect(
        parseImageBlock({'type': 'image', 'source': {'type': 'url', 'url': ''}}),
        isNull,
      );
    });

    test('a deferred ref for another content type is skipped', () {
      expect(
        parseImageBlock({
          'type': 'image',
          'source': {'type': 'url', 'url': ''},
          'deferredContent': {'entryId': 'entry-7', 'contentType': 'text'},
        }),
        isNull,
      );
    });

    test('a ref without an entryId is skipped', () {
      expect(
        parseImageBlock({
          'type': 'image',
          'source': {'type': 'url', 'url': ''},
          'deferredContent': {'blockIndex': 0, 'contentType': 'image'},
        }),
        isNull,
      );
    });
  });
}
