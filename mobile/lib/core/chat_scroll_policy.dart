/// Chat scroll magnet policy — Dart port of the desktop
/// `src/renderer/hooks/chat-scroll-policy.ts` rules that matter on touch:
///
/// - Streaming output follows the bottom only while the magnet is engaged.
/// - Any meaningful upward user scroll disengages it immediately (so an
///   expanded thinking card stays put and its collapse handle stays tappable).
/// - Re-engagement requires scrolling back down to near the bottom — never
///   happens automatically from the top.
library;

/// Distance from the scroll bottom within which the magnet re-attaches.
const double chatBottomProximityPx = 96;

/// Minimum upward drift (px) that counts as a user "scroll up".
const double userScrollMinPx = 1;

/// Touch gestures jitter; require a slightly larger move to release.
const double touchScrollUpMinPx = 8;

bool isNearChatBottom({
  required double maxScrollExtent,
  required double offset,
  double threshold = chatBottomProximityPx,
}) {
  if (!maxScrollExtent.isFinite) return true;
  return maxScrollExtent - offset <= threshold && offset <= maxScrollExtent;
}

bool didUserScrollUp(double previousOffset, double currentOffset) =>
    currentOffset < previousOffset - userScrollMinPx;

bool didUserScrollDown(double previousOffset, double currentOffset) =>
    currentOffset > previousOffset + userScrollMinPx;

/// A downward finger movement reveals earlier content (dragging the content
/// down), equivalent to scrolling the viewport upward.
bool isUpwardTouchGesture(double? startClientY, double currentClientY) =>
    startClientY != null && currentClientY - startClientY >= touchScrollUpMinPx;
