import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/chat_scroll_policy.dart';

void main() {
  group('isNearChatBottom', () {
    test('true within the 96px proximity window', () {
      expect(isNearChatBottom(maxScrollExtent: 500, offset: 500), isTrue);
      expect(isNearChatBottom(maxScrollExtent: 500, offset: 420), isTrue);
      expect(isNearChatBottom(maxScrollExtent: 500, offset: 405), isTrue, reason: '95px from bottom');
    });

    test('false when scrolled away beyond the window', () {
      expect(isNearChatBottom(maxScrollExtent: 500, offset: 400), isFalse);
      expect(isNearChatBottom(maxScrollExtent: 500, offset: 0), isFalse);
    });

    test('true when content fits without scrolling', () {
      // Overscroll reports negative offsets and non-finite extents; near-bottom.
      expect(isNearChatBottom(maxScrollExtent: 0, offset: 0), isTrue);
      expect(isNearChatBottom(maxScrollExtent: double.infinity, offset: 0), isTrue);
    });
  });

  group('scroll direction deltas', () {
    test('up/down detection with a 1px dead zone', () {
      expect(didUserScrollUp(500, 498), isTrue);
      expect(didUserScrollUp(500, 499.5), isFalse, reason: 'jitter below 1px is noise');
      expect(didUserScrollDown(500, 502), isTrue);
      expect(didUserScrollDown(500, 500.5), isFalse);
    });
  });

  group('isUpwardTouchGesture', () {
    test('downward finger move of 8px+ reveals earlier content', () {
      expect(isUpwardTouchGesture(100, 110), isTrue);
      expect(isUpwardTouchGesture(100, 106), isFalse, reason: 'below the touch jitter threshold');
      expect(isUpwardTouchGesture(null, 110), isFalse);
    });
  });
}
