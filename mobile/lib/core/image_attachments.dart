/// Client-side image attachment helpers for sending pictures from the mobile
/// composer via `agent.command` (`prompt` / `steer` / `follow_up`).
///
/// Mirrors the desktop draft limits (`MAX_PERSISTED_DRAFT_IMAGES`,
/// `MAX_PERSISTED_DRAFT_IMAGE_BYTES`, `DRAFT_IMAGE_MAX_DIMENSION`) so mobile
/// uploads stay responsive over E2EE + cellular relays and match PC model caps.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:image_picker/image_picker.dart';

/// Maximum images attached to one message (desktop `MAX_PERSISTED_DRAFT_IMAGES`).
const int maxAttachedImages = 4;

/// Maximum combined decoded bytes across all images on one message (4 MiB).
const int maxAttachedImageBytes = 4 * 1024 * 1024;

/// Longest edge passed to the platform picker when resizing large photos.
const double pickedImageMaxDimension = 2048;

/// JPEG quality passed to the platform picker when compressing photos.
const int pickedImageQuality = 82;

/// Raster formats accepted by Pi and the desktop/mobile transcript viewers.
const Set<String> allowedAttachmentMimes = {
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
};

/// Where the user chooses an attachment from.
enum ImagePickSource { gallery, camera }

/// Raw image returned by a picker adapter before validation/encoding.
class PickedImageFile {
  final Uint8List bytes;
  final String? mimeType;
  final String? name;

  const PickedImageFile({
    required this.bytes,
    this.mimeType,
    this.name,
  });
}

/// Pluggable picker callback so widget tests can supply images without hitting
/// Android/iOS platform channels.
typedef PickImagesFn = Future<List<PickedImageFile>> Function(
  ImagePickSource source, {
  int remainingSlots,
});

/// One validated image ready to preview and serialize onto `agent.command`.
class AttachedImage {
  final Uint8List bytes;
  final String base64Data;
  final String mimeType;
  final String? name;

  AttachedImage._({
    required this.bytes,
    required this.base64Data,
    required this.mimeType,
    this.name,
  });

  /// Build an attachment from raw [bytes], returning null if empty or not a
  /// supported raster format (`png`, `jpeg`, `gif`, `webp`).
  static AttachedImage? tryFromBytes(
    Uint8List bytes, {
    String? mimeType,
    String? name,
  }) {
    if (bytes.isEmpty) return null;
    final detected = detectImageMimeType(bytes, mimeType: mimeType, name: name);
    if (detected == null) return null;
    return AttachedImage._(
      bytes: bytes,
      base64Data: base64Encode(bytes),
      mimeType: detected,
      name: name,
    );
  }

  /// Wire shape expected by `BuiltinAgentCommands["prompt" | "steer"]`.
  Map<String, String> toWireBlock() => {
        'type': 'image',
        'data': base64Data,
        'mimeType': mimeType,
      };
}

/// Why an incoming attachment could not be added.
enum ImageAttachmentRejectReason { count, bytes, unsupportedFormat }

/// Result of merging newly picked images into the current composer list.
class AttachmentSelectionResult {
  final List<AttachedImage> accepted;
  final Set<ImageAttachmentRejectReason> rejections;

  const AttachmentSelectionResult({
    required this.accepted,
    required this.rejections,
  });

  /// User-facing Chinese summary of any rejected items, or null if all fit.
  String? describeRejection() {
    if (rejections.isEmpty) return null;
    final parts = <String>[];
    if (rejections.contains(ImageAttachmentRejectReason.unsupportedFormat)) {
      parts.add('仅支持 PNG、JPEG、GIF、WebP 图片');
    }
    if (rejections.contains(ImageAttachmentRejectReason.count)) {
      parts.add('每次最多发送 $maxAttachedImages 张图片');
    }
    if (rejections.contains(ImageAttachmentRejectReason.bytes)) {
      final mb = maxAttachedImageBytes ~/ (1024 * 1024);
      parts.add('图片总大小不能超过 $mb MB');
    }
    return parts.join('；');
  }
}

/// Infer a supported raster MIME from file header magic bytes, falling back to
/// [mimeType] or filename extension in [name].
String? detectImageMimeType(Uint8List bytes, {String? mimeType, String? name}) {
  if (bytes.length >= 8 &&
      bytes[0] == 0x89 &&
      bytes[1] == 0x50 &&
      bytes[2] == 0x4E &&
      bytes[3] == 0x47 &&
      bytes[4] == 0x0D &&
      bytes[5] == 0x0A &&
      bytes[6] == 0x1A &&
      bytes[7] == 0x0A) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 &&
      bytes[0] == 0x47 &&
      bytes[1] == 0x49 &&
      bytes[2] == 0x46 &&
      bytes[3] == 0x38 &&
      (bytes[4] == 0x37 || bytes[4] == 0x39) &&
      bytes[5] == 0x61) {
    return 'image/gif';
  }
  if (bytes.length >= 12 &&
      bytes[0] == 0x52 &&
      bytes[1] == 0x49 &&
      bytes[2] == 0x46 &&
      bytes[3] == 0x46 &&
      bytes[8] == 0x57 &&
      bytes[9] == 0x45 &&
      bytes[10] == 0x42 &&
      bytes[11] == 0x50) {
    return 'image/webp';
  }

  final normalizedMime = mimeType?.split(';').first.trim().toLowerCase();
  if (normalizedMime == 'image/jpg') return 'image/jpeg';
  if (normalizedMime != null && allowedAttachmentMimes.contains(normalizedMime)) {
    return normalizedMime;
  }

  final lowerName = name?.trim().toLowerCase() ?? '';
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.gif')) return 'image/gif';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  return null;
}

/// Filter and cap [incoming] files against [existing] count and byte budgets.
AttachmentSelectionResult selectAttachedImages(
  List<AttachedImage> existing,
  List<PickedImageFile> incoming, {
  int maxCount = maxAttachedImages,
  int maxTotalBytes = maxAttachedImageBytes,
}) {
  final accepted = <AttachedImage>[];
  final rejections = <ImageAttachmentRejectReason>{};
  var usedBytes = existing.fold<int>(0, (sum, img) => sum + img.bytes.length);

  for (final file in incoming) {
    final parsed = AttachedImage.tryFromBytes(
      file.bytes,
      mimeType: file.mimeType,
      name: file.name,
    );
    if (parsed == null) {
      rejections.add(ImageAttachmentRejectReason.unsupportedFormat);
      continue;
    }
    if (existing.length + accepted.length >= maxCount) {
      rejections.add(ImageAttachmentRejectReason.count);
      continue;
    }
    if (usedBytes + parsed.bytes.length > maxTotalBytes) {
      rejections.add(ImageAttachmentRejectReason.bytes);
      continue;
    }
    accepted.add(parsed);
    usedBytes += parsed.bytes.length;
  }

  return AttachmentSelectionResult(accepted: accepted, rejections: rejections);
}

/// Default picker backed by `image_picker` with native resize & JPEG compression.
Future<List<PickedImageFile>> defaultPickImages(
  ImagePickSource source, {
  int remainingSlots = maxAttachedImages,
}) async {
  final picker = ImagePicker();
  final List<XFile> files;
  switch (source) {
    case ImagePickSource.gallery:
      // image_picker's `limit` requires >= 2 on Android; when only 1 slot
      // remains, single pick avoids throwing an ArgumentError.
      if (remainingSlots <= 1) {
        final single = await picker.pickImage(
          source: ImageSource.gallery,
          maxWidth: pickedImageMaxDimension,
          maxHeight: pickedImageMaxDimension,
          imageQuality: pickedImageQuality,
        );
        files = single == null ? const [] : [single];
      } else {
        files = await picker.pickMultiImage(
          maxWidth: pickedImageMaxDimension,
          maxHeight: pickedImageMaxDimension,
          imageQuality: pickedImageQuality,
          limit: remainingSlots,
        );
      }
    case ImagePickSource.camera:
      final photo = await picker.pickImage(
        source: ImageSource.camera,
        maxWidth: pickedImageMaxDimension,
        maxHeight: pickedImageMaxDimension,
        imageQuality: pickedImageQuality,
      );
      files = photo == null ? const [] : [photo];
  }

  final out = <PickedImageFile>[];
  for (final file in files) {
    final bytes = await file.readAsBytes();
    out.add(PickedImageFile(bytes: bytes, mimeType: file.mimeType, name: file.name));
  }
  return out;
}
