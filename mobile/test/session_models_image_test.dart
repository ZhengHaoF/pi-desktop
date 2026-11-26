/// Image handling in the transcript model: image lines from history, tool
/// result images, generated-image lifting, and the paged-history helpers.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/widgets/image_block.dart';
import 'package:pi_remote/widgets/session_models.dart';

const pngBlock = {'type': 'image', 'data': 'QUJD', 'mimeType': 'image/png'};
const deferredBlock = {
  'type': 'image',
  'source': {'type': 'url', 'url': ''},
  'deferredContent': {'entryId': 'e-2', 'blockIndex': 1, 'originalBytes': 999, 'contentType': 'image'},
};

void main() {
  group('history image lines', () {
    test('an assistant image block becomes an image line', () {
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {'role': 'user', 'content': '看这张图'},
            {
              'role': 'assistant',
              'content': [
                {'type': 'text', 'text': '这是截图'},
                pngBlock,
              ],
            },
          ],
        },
      });

      expect(lines.map((l) => l.kind), ['text', 'text', 'image']);
      final image = lines.last;
      expect(image.role, 'assistant');
      expect(image.image!.data, isA<InlineImage>());
      expect(image.messageIndex, 1);
    });

    test('a deferred placeholder keeps its entry ref for the loader', () {
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {'role': 'assistant', 'content': [deferredBlock]},
          ],
        },
      });

      final data = lines.single.image!.data as DeferredImage;
      expect(data.entryId, 'e-2');
      expect(data.blockIndex, 1);
      expect(lines.single.kind, 'image');
    });

    test('a user image is shown too', () {
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {'role': 'user', 'content': [pngBlock, {'type': 'text', 'text': '这是什么'}]},
          ],
        },
      });

      expect(lines.map((l) => l.kind), ['image', 'text']);
      expect(lines.first.role, 'user');
    });

    test('a block that cannot be shown adds no line', () {
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {
              'role': 'assistant',
              'content': [
                {'type': 'image', 'data': 'QUJD', 'mimeType': 'image/svg+xml'},
                {'type': 'text', 'text': 'ok'},
              ],
            },
          ],
        },
      });

      expect(lines.map((l) => l.kind), ['text']);
    });

    test('an empty image placeholder without a ref adds no line', () {
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {
              'role': 'assistant',
              'content': [
                {'type': 'image', 'source': {'type': 'url', 'url': ''}},
              ],
            },
          ],
        },
      });

      expect(lines, isEmpty);
    });
  });

  group('tool result images', () {
    test('a screenshot-only result is collected on its tool card', () {
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {
              'role': 'assistant',
              'content': [
                {'type': 'toolCall', 'toolCallId': 'c1', 'toolName': 'browser_screenshot', 'input': {}},
              ],
            },
            {
              'role': 'toolResult',
              'toolCallId': 'c1',
              'toolName': 'browser_screenshot',
              'content': [pngBlock, {'type': 'text', 'text': 'captured'}],
            },
          ],
        },
      });

      expect(lines.single.kind, 'tool');
      expect(lines.single.resultImages, hasLength(1));
      expect(lines.single.resultText, 'captured');
    });

    test('a result with only an image still gets a card', () {
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {
              'role': 'assistant',
              'content': [
                {'type': 'toolCall', 'toolCallId': 'c1', 'toolName': 'browser_screenshot', 'input': {}},
              ],
            },
            {
              'role': 'toolResult',
              'toolCallId': 'c1',
              'content': [pngBlock],
            },
          ],
        },
      });

      expect(lines.single.resultImages, hasLength(1));
      expect(lines.single.resultText, '(无输出)');
    });

    test('a silent result with no image is still dropped', () {
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {'role': 'assistant', 'content': [{'type': 'toolCall', 'toolCallId': 'c1', 'toolName': 'x', 'input': {}}]},
            {'role': 'toolResult', 'toolCallId': 'c1', 'content': ''},
          ],
        },
      });

      // The toolCall is still there; only the empty result was dropped.
      expect(lines.single.resultImages, isEmpty);
    });

    test('an unpaired image result becomes a standalone tool line', () {
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {'role': 'toolResult', 'toolCallId': 'orphan', 'toolName': 'shot', 'content': [pngBlock]},
          ],
        },
      });

      expect(lines.single.kind, 'tool');
      expect(lines.single.resultImages, hasLength(1));
      expect(lines.single.fromToolCall, isFalse);
    });

    test('a live tool result pairs its image into the running card', () {
      final lines = <ChatLine>[];
      final indexByCallId = <String, int>{};
      upsertToolCard(lines, indexByCallId, {'toolCallId': 'c1', 'toolName': 'browser_screenshot'});

      applyToolResult(lines, indexByCallId, {
        'role': 'toolResult',
        'toolCallId': 'c1',
        'content': [pngBlock],
      });

      expect(lines.single.running, isFalse);
      expect(lines.single.resultImages, hasLength(1));
    });
  });

  group('generated image lifting', () {
    final codemodeResult = {
      'role': 'toolResult',
      'toolCallId': 'gen',
      'toolName': 'codemode',
      'details': {
        'calls': [
          {'name': 'models.generateImages', 'status': 'ok'},
        ],
      },
      'content': [pngBlock, pngBlock],
    };

    test('images from a successful generateImages call follow the reply', () {
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {'role': 'user', 'content': '画一只猫'},
            {
              'role': 'assistant',
              'content': [
                {'type': 'toolCall', 'toolCallId': 'gen', 'toolName': 'codemode', 'input': {}},
              ],
            },
            codemodeResult,
            {
              'role': 'assistant',
              'content': [
                {'type': 'text', 'text': '画好了'},
              ],
            },
          ],
        },
      });

      expect(lines.map((l) => l.kind), ['text', 'tool', 'text', 'image', 'image']);
      // The lifted images sit after the answer and share its ordinal, so they
      // stay inside the turn when it folds.
      expect(lines[3].messageIndex, 3);
      expect(lines[3].role, 'assistant');
    });

    test('a failed generateImages call lifts nothing', () {
      final failed = {
        'role': 'toolResult',
        'toolCallId': 'gen',
        'toolName': 'codemode',
        'details': {
          'calls': [
            {'name': 'models.generateImages', 'status': 'error'},
          ],
        },
        'content': [],
      };
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {'role': 'user', 'content': 'x'},
            {'role': 'assistant', 'content': [{'type': 'toolCall', 'toolCallId': 'gen', 'toolName': 'codemode'}]},
            failed,
            {'role': 'assistant', 'content': [{'type': 'text', 'text': 'failed'}]},
          ],
        },
      });

      expect(lines.where((l) => l.kind == 'image'), isEmpty);
    });

    test('another tool returning images does not get lifted', () {
      final lines = historyLinesFromDetail({
        'context': {
          'messages': [
            {'role': 'user', 'content': 'x'},
            {
              'role': 'toolResult',
              'toolCallId': 'read',
              'toolName': 'read',
              'content': [pngBlock],
            },
            {'role': 'assistant', 'content': [{'type': 'text', 'text': 'here'}]},
          ],
        },
      });

      expect(lines.where((l) => l.kind == 'image'), isEmpty);
      // The image stays on its own tool card.
      final tool = lines.singleWhere((l) => l.kind == 'tool');
      expect(tool.resultImages, hasLength(1));
    });
  });

  group('paged history helpers', () {
    test('ordinal offset is the number of messages before the page', () {
      final detail = {
        'context': {'messages': List.filled(3, null), 'totalMessages': 40, 'loadedMessages': 3},
      };
      expect(historyOrdinalOffset(detail), 37);
    });

    test('an unpaged response has no offset', () {
      expect(historyOrdinalOffset({'context': {'messages': [1, 2]}}), 0);
    });

    test('ordinals are shifted by the offset', () {
      final lines = historyLinesFromDetail(
        {
          'context': {
            'messages': [
              {'role': 'user', 'content': 'hi'},
              {'role': 'assistant', 'content': 'yo'},
            ],
          },
        },
        ordinalOffset: 37,
      );

      expect(lines.map((l) => l.messageIndex), [37, 38]);
    });

    test('the previous cursor is only exposed when something is older', () {
      expect(
        historyPreviousCursor({
          'context': {'truncatedBefore': true, 'previousCursor': 'abc'},
        }),
        'abc',
      );
      expect(
        historyPreviousCursor({
          'context': {'truncatedBefore': false, 'previousCursor': 'abc'},
        }),
        isNull,
      );
      expect(historyPreviousCursor({'context': {'messages': []}}), isNull);
    });

    test('total messages is null for an unpaged response', () {
      expect(historyTotalMessages({'context': {'totalMessages': 12}}), 12);
      expect(historyTotalMessages({'context': {'messages': []}}), isNull);
    });

    test('older pages are numbered downward without overlapping', () {
      // First page holds the newest 30 messages of a 100-message session, so
      // the oldest loaded message is 70. Pages below total exactly 70.
      var oldest = 100 - 30;
      final seen = <int>{};
      for (final pageLength in [30, 25, 15]) {
        final page = olderPageOrdinals(oldestOrdinal: oldest, pageLength: pageLength);
        // This page occupies [offset, oldest).
        for (var ordinal = page.offset; ordinal < oldest; ordinal++) {
          expect(seen.add(ordinal), isTrue, reason: 'ordinal $ordinal used twice');
        }
        expect(page.oldest, page.offset);
        oldest = page.oldest;
      }
      // Three pages walked from message 70 down to message 0.
      expect(oldest, 0);
      // Every message below the first page was covered exactly once.
      expect(seen, hasLength(70));
      // The newest page's ordinals were never touched by the older ones.
      for (var ordinal = 70; ordinal < 100; ordinal++) {
        expect(seen.contains(ordinal), isFalse);
      }
    });

    test('a page longer than what is below it clamps at message 0', () {
      final page = olderPageOrdinals(oldestOrdinal: 3, pageLength: 10);
      expect(page.offset, 0);
      expect(page.oldest, 0);
    });

    test('the last page lands exactly on message 0', () {
      final page = olderPageOrdinals(oldestOrdinal: 12, pageLength: 12);
      expect(page.offset, 0);
      expect(page.oldest, 0);
    });
  });
}
