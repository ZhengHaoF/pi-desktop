/// Image content blocks as the PC sends them.
///
/// Mirrors the desktop `imageSource()` / `persistedImageSource()` rules: only
/// saved raster bytes are displayable, and the wire carries two shapes —
/// Anthropic's `source: {type: "base64", data, media_type}` (pi's read tool)
/// and the flat `{data, mimeType}` this app's browser tools emit.
library;

/// Raster types the desktop renders; anything else (svg, url-only) is skipped.
const Set<String> _allowedMimes = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'};

/// A displayable image block, or a placeholder whose bytes live on the PC.
sealed class ImageBlockData {
  const ImageBlockData();

  /// Raw base64 that arrived inline. Null while a deferred block is unloaded.
  String? get base64;

  /// Decoded MIME type; null while a deferred block is unloaded.
  String? get mimeType;
}

/// The bytes arrived with the block (unpaged history, live events).
class InlineImage extends ImageBlockData {
  @override
  final String base64;
  @override
  final String mimeType;

  const InlineImage(this.base64, this.mimeType);
}

/// A paged-history placeholder: the PC dropped the bytes to fit the page
/// budget and will return them for `entryId` + `blockIndex`.
class DeferredImage extends ImageBlockData {
  final String entryId;
  final int blockIndex;

  @override
  String? get base64 => null;
  @override
  String? get mimeType => null;

  const DeferredImage(this.entryId, this.blockIndex);
}

/// A picture the reply refers to by path in its prose rather than sending as
/// a block: `![logo](D:\work\app\res\icon.png)`. The bytes are read from the
/// PC with `files.read`.
class LocalFileImage extends ImageBlockData {
  /// Absolute path on the PC, with forward slashes.
  final String path;

  @override
  String? get base64 => null;
  @override
  String? get mimeType => null;

  const LocalFileImage(this.path);
}

/// Resolve the target of a Markdown image to an absolute path on the PC, or
/// null when it is not a local file at all (a web URL, or nothing to go on).
///
/// Mirrors the desktop `resolveLocalFileHref`: a drive path (`D:/a.png`,
/// `D:\a.png`), a `file:` URL, a POSIX absolute path, or a path relative to
/// [cwd]. Anything with another scheme (`https:`, `data:`) is left alone.
String? resolveLocalImagePath(String href, {String? cwd}) {
  var href_ = href.trim();
  // A title after the path (`![a](b.png "title")`) is not part of the path.
  final titleBreak = RegExp(r'\s+["\x27(]').firstMatch(href_);
  if (titleBreak != null) href_ = href_.substring(0, titleBreak.start).trim();
  if (href_.isEmpty) return null;
  // Strip an anchor or query the way the desktop does, then percent-encoding.
  href_ = _before(href_, '#');
  href_ = _before(href_, '?');
  try {
    href_ = Uri.decodeComponent(href_);
  } on ArgumentError {
    // A malformed percent escape: use the target as written.
  }
  if (href_.isEmpty) return null;

  final isBackslashUnc = href_.startsWith(r'\\');
  final slashes = (isBackslashUnc || RegExp(r'^[a-zA-Z]:[\\/]').hasMatch(href_))
      ? href_.replaceAll(r'\', '/')
      : href_;
  final lower = slashes.toLowerCase();

  if (lower.startsWith('/api/') || lower.startsWith('/_next/')) return null;
  // Protocol-relative URLs point at a host, not at the PC's disk.
  if (!isBackslashUnc && slashes.startsWith('//')) return null;
  final hasScheme = RegExp(r'^[a-zA-Z][a-zA-Z0-9+.-]*:').hasMatch(slashes);
  final isDrive = RegExp(r'^[a-zA-Z]:/').hasMatch(slashes);
  if (hasScheme && !lower.startsWith('file:') && !isDrive) return null;

  String? candidate;
  var relative = false;
  if (lower.startsWith('file:')) {
    final uri = Uri.tryParse(slashes);
    // toFilePath handles file:///D:/a.png, file:///C%3A/a.png and UNC forms,
    // and refuses a URL that carries a host other than localhost.
    try {
      candidate = uri?.toFilePath(windows: true);
    } on UnsupportedError {
      return null;
    }
    if (candidate == null) return null;
    // toFilePath(windows:) yields backslashes; the rest works in forward slashes.
    candidate = candidate.replaceAll(r'\', '/');
  } else if (isDrive) {
    candidate = slashes;
  } else if (slashes.startsWith('/')) {
    candidate = slashes;
  } else if (isBackslashUnc) {
    candidate = slashes;
  } else if (cwd != null && cwd.trim().isNotEmpty) {
    if (!_looksLikeRelativeFile(slashes)) return null;
    candidate = '${cwd.replaceAll(r'\', '/').replaceAll(RegExp(r'/+$'), '')}/$slashes';
    relative = true;
  } else {
    return null;
  }

  candidate = _normalize(candidate);
  // A relative reference must not climb out of the session directory.
  if (relative && cwd != null && !_isWithin(candidate, _normalize(cwd.replaceAll(r'\', '/')))) return null;
  return candidate;
}

/// The part of [value] before the first [separator], or all of it.
String _before(String value, String separator) {
  final index = value.indexOf(separator);
  return index < 0 ? value : value.substring(0, index);
}

bool _looksLikeRelativeFile(String href) {
  if (href.startsWith('#') || href.startsWith('?')) return false;
  if (href.startsWith('./') || href.startsWith('../')) return true;
  if (href.contains('/')) return true;
  return RegExp(r'(^|\/)\.?[^/]+\.[^/.]+$').hasMatch(href);
}

/// Collapse `.` and `..` segments and duplicate slashes.
String _normalize(String path) {
  final isUnc = path.startsWith('//');
  final isDrive = RegExp(r'^[a-zA-Z]:/').hasMatch(path);
  final absolute = path.startsWith('/') && !isDrive;
  final parts = <String>[];
  for (final part in path.split('/')) {
    if (part.isEmpty || part == '.') continue;
    if (part == '..') {
      if (parts.isNotEmpty && parts.last != '..') {
        parts.removeLast();
      } else if (!absolute && !isDrive && !isUnc) {
        parts.add(part);
      }
      continue;
    }
    parts.add(part);
  }
  final joined = parts.join('/');
  if (isDrive) return joined;
  if (isUnc) return '//$joined';
  return absolute ? '/$joined' : joined;
}

bool _isWithin(String path, String dir) {
  if (path == dir) return true;
  final prefix = dir.endsWith('/') ? dir : '$dir/';
  final lowerPath = path.toLowerCase();
  final lowerDir = prefix.toLowerCase();
  return lowerPath.startsWith(lowerDir);
}

/// Parse one `type: "image"` block. Returns null when nothing can be shown:
/// a url-only source, a non-raster MIME, or a placeholder without a ref.
ImageBlockData? parseImageBlock(Map<dynamic, dynamic> block) {
  final deferred = block['deferredContent'];
  final deferredRef = deferred is Map ? deferred : null;
  if (deferredRef != null && deferredRef['contentType'] != 'image') return null;

  String? data;
  String? mime;
  final source = block['source'];
  if (source is Map) {
    if (source['type'] == 'base64') {
      data = source['data'] as String?;
      mime = source['media_type'] as String?;
    }
  } else {
    data = block['data'] as String?;
    mime = block['mimeType'] as String?;
  }

  if (data != null && data.isNotEmpty) {
    if (mime == null || !_allowedMimes.contains(mime)) return null;
    return InlineImage(data, mime);
  }

  final entryId = deferredRef?['entryId'] as String?;
  if (entryId == null || entryId.isEmpty) return null;
  final rawIndex = deferredRef?['blockIndex'];
  return DeferredImage(entryId, rawIndex is int ? rawIndex : 0);
}
