/// Transcript images: a thumbnail, the tap that loads it, and the full-screen
/// viewer it opens.
///
/// A picture whose bytes came with the message renders at once. One that would
/// cost a request (a paged-history placeholder, a path named in prose) waits
/// for a tap, so an old session costs no image data until the reader asks.
/// Either way, tapping the picture opens [ImageViewer].
library;

import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../core/app_theme.dart';
import '../core/image_cache.dart';
import '../widgets/image_block.dart';
import '../widgets/session_models.dart';

/// Edge-to-edge size of a thumbnail, in logical pixels. Screenshots are wide,
/// so width bounds most images; height keeps a tall capture from filling the
/// transcript.
const double _thumbnailMaxWidth = 260;
const double _thumbnailMaxHeight = 320;

/// Floor for the thumbnail box, so a tiny or extreme-aspect image still has a
/// tappable area and the loading / failed placeholders keep a sensible size.
const double _thumbnailMinWidth = 160;
const double _thumbnailMinHeight = 120;

/// Thumbnail for one transcript image. [sessionId] scopes the cache key.
class ChatImage extends StatefulWidget {
  final ImageRef ref;
  final String sessionId;
  final TranscriptImageCache cache;
  /// What the picture is, shown while it loads and in place of it when it
  /// cannot be shown. A reply's `![alt](path)` supplies it; blocks have none.
  final String? alt;
  /// Load without a tap. Defaults to true only for blocks whose bytes already
  /// arrived with the message: decoding those costs no network. A placeholder
  /// that would need a request (paged history, a path in prose) waits for a
  /// tap, so scrolling through an old session never spends data on pictures
  /// the reader is only scrolling past.
  final bool? autoLoad;

  const ChatImage({
    required this.ref,
    required this.sessionId,
    required this.cache,
    this.alt,
    this.autoLoad,
    super.key,
  });

  /// Whether this picture loads by itself.
  bool get shouldAutoLoad => autoLoad ?? (ref.data is InlineImage);

  @override
  State<ChatImage> createState() => _ChatImageState();

  /// Whether two refs name the same picture. A parent that rebuilds creates a
  /// fresh ImageRef each time, so identity is the cache key, not the object.
  static bool samePicture(ChatImage a, ChatImage b) =>
      a.sessionId == b.sessionId && TranscriptImageCache.keyFor(a.ref, a.sessionId) == TranscriptImageCache.keyFor(b.ref, b.sessionId);
}

class _ChatImageState extends State<ChatImage> {
  Uint8List? _bytes;
  String? _mime;
  Object? _error;
  /// A request is in flight (or was made): distinguishes "waiting for a tap"
  /// from "loading", which look alike before any bytes arrive.
  bool _loadStarted = false;
  int _attempt = 0;

  @override
  void initState() {
    super.initState();
    if (widget.shouldAutoLoad) _resolve();
  }

  @override
  void didUpdateWidget(ChatImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (ChatImage.samePicture(oldWidget, widget) && oldWidget.cache == widget.cache) return;
    // A different picture (or a different cache) invalidates everything.
    _attempt += 1;
    _bytes = null;
    _mime = null;
    _error = null;
    _loadStarted = false;
    if (widget.shouldAutoLoad) _resolve();
  }

  Future<void> _resolve() async {
    final attempt = ++_attempt;
    // Direct assignment rather than setState: the first call runs from
    // initState, where notifying dependents is not allowed yet.
    _error = null;
    _loadStarted = true;
    try {
      final result = await widget.cache.bytesFor(widget.ref, sessionId: widget.sessionId);
      if (!mounted || attempt != _attempt) return;
      setState(() {
        if (result == null) {
          _error = StateError('no image');
        } else {
          _bytes = result.bytes;
          _mime = result.mimeType;
          _error = null;
        }
      });
    } catch (error) {
      if (!mounted || attempt != _attempt) return;
      setState(() => _error = error);
    }
  }

  /// Start a load the reader asked for, so the tap shows a spinner at once.
  void _loadOnTap() {
    setState(() => _loadStarted = true);
    _resolve();
  }

  Future<void> _openViewer() async {
    final bytes = _bytes;
    if (bytes == null) return;
    await Navigator.of(context).push(
      PageRouteBuilder<void>(
        opaque: false,
        barrierDismissible: true,
        barrierColor: Colors.black,
        pageBuilder: (context, animation, _) => ImageViewer(bytes: bytes, mimeType: _mime ?? 'image/png'),
        transitionsBuilder: (context, animation, _, child) =>
            FadeTransition(opacity: animation, child: child),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final bytes = _bytes;
    final Widget body;
    if (bytes != null) {
      body = GestureDetector(
        onTap: _openViewer,
        behavior: HitTestBehavior.opaque,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(10),
          // The image lays itself out at its intrinsic size, which for a 1x1
          // test fixture (or a very wide strip of a screenshot) leaves nothing
          // to tap. frameBuilder fits the decoded frame into a box of the
          // same aspect ratio instead, so every image gets a reachable area.
          child: Image.memory(
            bytes,
            // Decode at roughly the displayed size instead of the capture
            // size: a 4K screenshot is ~33 MB of RGBA at full resolution.
            cacheWidth: (_thumbnailMaxWidth * MediaQuery.devicePixelRatioOf(context)).round(),
            fit: BoxFit.contain,
            gaplessPlayback: true,
            frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
              if (wasSynchronouslyLoaded || frame != null) return child;
              return _LoadingImage(alt: widget.alt);
            },
            errorBuilder: (context, error, stack) => _FailedImage(
              alt: widget.alt,
              onRetry: () {
                setState(() => _bytes = null);
                _loadOnTap();
              },
            ),
          ),
        ),
      );
    } else if (_error != null) {
      body = _FailedImage(alt: widget.alt, onRetry: _loadOnTap);
    } else if (_loadStarted) {
      body = _LoadingImage(alt: widget.alt);
    } else {
      // Not loaded yet and not loading: the reader decides when to spend the
      // request this picture needs.
      body = _TapToLoadImage(alt: widget.alt, onTap: _loadOnTap);
    }
    // No alignment of its own: the caller places the thumbnail (right for the
    // user's own pictures, left inside assistant bubbles and tool cards).
    // An inner Align here would expand to the full row and defeat that.
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          minWidth: _thumbnailMinWidth,
          maxWidth: _thumbnailMaxWidth,
          minHeight: _thumbnailMinHeight,
          maxHeight: _thumbnailMaxHeight,
        ),
        child: body,
      ),
    );
  }
}

/// Placeholder for a picture that needs a request: the reader taps to spend
/// it. The alt text says which picture waits, when the reply named one.
class _TapToLoadImage extends StatelessWidget {
  final VoidCallback onTap;
  final String? alt;

  const _TapToLoadImage({required this.onTap, this.alt});

  @override
  Widget build(BuildContext context) {
    final label = alt?.trim();
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        width: 176,
        height: 120,
        decoration: BoxDecoration(
          color: AppColors.surfaceSubtle,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 34,
              height: 34,
              decoration: const BoxDecoration(color: AppColors.brandSoft, shape: BoxShape.circle),
              child: const Icon(Icons.image_outlined, size: 18, color: AppColors.brand),
            ),
            if (label != null && label.isNotEmpty) ...[
              const SizedBox(height: 6),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 10),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 11, color: AppColors.textSecondary),
                ),
              ),
            ],
            const SizedBox(height: 4),
            const Text(
              '点击加载图片',
              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: AppColors.brand),
            ),
          ],
        ),
      ),
    );
  }
}

/// Placeholder shown while the bytes are on their way from the PC.
class _LoadingImage extends StatelessWidget {
  /// What the picture is, when the reply said so.
  final String? alt;

  const _LoadingImage({this.alt});

  @override
  Widget build(BuildContext context) {
    final label = alt?.trim();
    return Container(
      width: 176,
      height: 120,
      decoration: BoxDecoration(
        color: AppColors.surfaceSubtle,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
          if (label != null && label.isNotEmpty) ...[
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10),
              child: Text(
                label,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 11, color: AppColors.textSecondary),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Placeholder shown when the bytes could not be loaded, with a retry.
class _FailedImage extends StatelessWidget {
  final VoidCallback onRetry;
  /// What the picture is, when the reply said so, so the reader can tell
  /// which picture is missing.
  final String? alt;

  const _FailedImage({required this.onRetry, this.alt});

  @override
  Widget build(BuildContext context) {
    final label = alt?.trim();
    return InkWell(
      onTap: onRetry,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        width: 176,
        height: 120,
        decoration: BoxDecoration(
          color: AppColors.dangerBg,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.dangerBorder),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.broken_image_outlined, size: 22, color: AppColors.danger),
            const SizedBox(height: 6),
            if (label != null && label.isNotEmpty) ...[
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 10),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 11, color: AppColors.textSecondary),
                ),
              ),
              const SizedBox(height: 2),
            ],
            const Text('图片加载失败，点击重试', style: TextStyle(fontSize: 11, color: AppColors.danger)),
          ],
        ),
      ),
    );
  }
}

/// Full-screen image with pinch-zoom and pan. The close button, a back
/// gesture, or tapping the black area around the image leaves.
class ImageViewer extends StatelessWidget {
  final Uint8List bytes;
  final String mimeType;

  const ImageViewer({required this.bytes, required this.mimeType, super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          // Tap-to-close sits on the scaffold, under the image, so a tap on
          // the image itself goes to InteractiveViewer and never closes.
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => Navigator.of(context).maybePop(),
            ),
          ),
          Positioned.fill(
            child: InteractiveViewer(
              minScale: 1,
              maxScale: 5,
              child: Center(
                child: Image.memory(bytes, fit: BoxFit.contain, gaplessPlayback: true),
              ),
            ),
          ),
          Positioned(
            top: MediaQuery.paddingOf(context).top + 8,
            right: 12,
            child: IconButton(
              tooltip: '关闭',
              onPressed: () => Navigator.of(context).maybePop(),
              style: IconButton.styleFrom(backgroundColor: Colors.black54),
              icon: const Icon(Icons.close, color: Colors.white),
            ),
          ),
        ],
      ),
    );
  }
}
