/// Bytes for transcript images, shared by every thumbnail of one chat page.
///
/// Three sources. Inline blocks (live events, unpaged history) only need their
/// base64 decoded once however many rebuilds ask. Paged-history placeholders
/// need a round trip: the PC dropped the bytes to fit the page budget and
/// returns them through `sessions.entryContent`. Pictures the reply refers to
/// by path are read from the PC's disk with `files.read`.
///
/// Decoded bytes live in an LRU because full-resolution screenshots are
/// megabytes each; a placeholder that scrolls back into view simply reloads.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import '../widgets/image_block.dart';
import '../widgets/session_models.dart';

/// How the loader reaches the PC. The chat page wraps `RemoteConnection`.
typedef EntryContentLoader = Future<Map<dynamic, dynamic>?> Function(String entryId, int blockIndex);

/// Reads one file from the PC, as `files.read` answers it: base64 under
/// `content` with a `mime`, or `encoding: "too_large"` past the size limit.
typedef FileReadLoader = Future<Map<dynamic, dynamic>?> Function(String path);

/// Mirrors the desktop `DEFERRED_CONTENT_CACHE_SIZE`.
const int imageCacheCapacity = 12;

/// Resolved bytes of one image.
class ImageBytes {
  final Uint8List bytes;
  final String mimeType;

  const ImageBytes(this.bytes, this.mimeType);
}

/// Resolves image bytes for one chat page. Not a singleton: each page owns
/// its own cache and clears it on dispose.
class TranscriptImageCache {
  final EntryContentLoader _load;
  final FileReadLoader? _readFile;
  final int capacity;
  // Insertion ordered: the first entry is the least recently used.
  final _cache = <String, ImageBytes>{};
  // One load per key: concurrent callers share the in-flight request.
  final _inflight = <String, Future<ImageBytes?>>{};

  // A named parameter cannot initialize a private field directly in this
  // SDK (private_named_non_field_parameter), hence the explicit initializer.
  TranscriptImageCache(this._load, {FileReadLoader? readFile, this.capacity = imageCacheCapacity})
      // ignore: prefer_initializing_formals
      : _readFile = readFile;

  /// Identity of a ref's bytes within a session.
  static String keyFor(ImageRef ref, String sessionId) {
    final data = ref.data;
    return switch (data) {
      InlineImage() => '$sessionId:inline:${data.mimeType}:${data.base64.length}:${identityHash(data.base64)}',
      DeferredImage() => '$sessionId:${data.entryId}:${data.blockIndex}',
      // A file can change on disk; keying by path alone would show a stale
      // picture after the agent rewrites it, so the page cache is per-visit
      // and this key is only unique within one visit.
      LocalFileImage() => '$sessionId:file:${data.path}',
    };
  }

  /// A cheap, stable identity for an inline block. Inline blocks carry no
  /// entry id, so the base64 itself is the only identity; hashing every byte
  /// of a multi-megabyte string on each lookup would defeat the cache, so the
  /// length plus a few sampled characters stands in for it.
  static String identityHash(String base64) {
    if (base64.length <= 64) return base64;
    final step = base64.length ~/ 16;
    final buffer = StringBuffer();
    for (var i = 0; i < base64.length; i += step) {
      buffer.writeCharCode(base64.codeUnitAt(i));
    }
    buffer.writeCharCode(base64.codeUnitAt(base64.length - 1));
    return buffer.toString();
  }

  /// Decoded bytes for `ref`, resolving it first if it has not been yet.
  ///
  /// Returns null when the block cannot produce bytes. Throws the loader's
  /// error so the caller can show a retry. Concurrent requests for the same
  /// image share one load.
  Future<ImageBytes?> bytesFor(ImageRef ref, {required String sessionId}) {
    final key = keyFor(ref, sessionId);
    // Insertion order is the recency order.
    final cached = _cache.remove(key);
    if (cached != null) {
      _cache[key] = cached;
      return Future.value(cached);
    }
    final running = _inflight[key];
    if (running != null) return running;
    // Block body on purpose: whenComplete awaits a Future returned by its
    // callback, and an arrow returning `_inflight.remove(key)` would hand
    // back this very future and wait on itself forever.
    final future = _resolve(ref.data, sessionId).then((result) {
      if (result != null) {
        _cache[key] = result;
        while (_cache.length > capacity) {
          _cache.remove(_cache.keys.first);
        }
      }
      return result;
    }).whenComplete(() {
      _inflight.remove(key);
    });
    _inflight[key] = future;
    return future;
  }

  /// Whether bytes for `ref` are already resolved, so a caller can skip work.
  bool isCached(ImageRef ref, {required String sessionId}) => _cache.containsKey(keyFor(ref, sessionId));

  /// Drop everything. The page is going away.
  void clear() {
    _cache.clear();
    _inflight.clear();
  }

  /// Resolve the bytes of one block: decode an inline block, ask the PC for a
  /// deferred one, or read a file the reply refers to.
  Future<ImageBytes?> _resolve(ImageBlockData data, String sessionId) async {
    switch (data) {
      case InlineImage(:final base64, :final mimeType):
        return ImageBytes(base64Decode(base64), mimeType);
      case DeferredImage(:final entryId, :final blockIndex):
        final response = await _load(entryId, blockIndex);
        final content = response?['content'];
        if (content is! Map) return null;
        final parsed = parseImageBlock(content);
        if (parsed is! InlineImage) return null;
        return ImageBytes(base64Decode(parsed.base64), parsed.mimeType);
      case LocalFileImage(:final path):
        final readFile = _readFile;
        if (readFile == null) return null;
        final response = await readFile(path);
        final content = response?['content'];
        final mime = response?['mime'];
        // files.read answers "too_large" instead of bytes past its size
        // limit; there is nothing to show for that.
        if (response?['encoding'] != 'base64' || content is! String || content.isEmpty) return null;
        return ImageBytes(base64Decode(content), mime is String ? mime : 'image/png');
    }
  }
}
