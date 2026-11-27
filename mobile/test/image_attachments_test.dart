/// Unit tests for client-side image attachment validation and budget enforcement.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/image_attachments.dart';

final _pngBytes = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);

final _jpegBytes = Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
final _gifBytes = Uint8List.fromList([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01]);
final _webpBytes = Uint8List.fromList([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

void main() {
  group('detectImageMimeType', () {
    test('detects PNG, JPEG, GIF and WebP from magic bytes', () {
      expect(detectImageMimeType(_pngBytes), 'image/png');
      expect(detectImageMimeType(_jpegBytes), 'image/jpeg');
      expect(detectImageMimeType(_gifBytes), 'image/gif');
      expect(detectImageMimeType(_webpBytes), 'image/webp');
    });

    test('falls back to mimeType or file extension and rejects non-raster formats', () {
      final unknown = Uint8List.fromList([1, 2, 3, 4]);
      expect(detectImageMimeType(unknown, mimeType: 'image/jpg'), 'image/jpeg');
      expect(detectImageMimeType(unknown, name: 'photo.WEBP'), 'image/webp');
      expect(detectImageMimeType(unknown, mimeType: 'image/svg+xml', name: 'logo.svg'), isNull);
      expect(detectImageMimeType(unknown, name: 'notes.txt'), isNull);
    });
  });

  group('selectAttachedImages', () {
    test('enforces count limit and formats wire blocks', () {
      final existing = [
        AttachedImage.tryFromBytes(_pngBytes, name: '1.png')!,
        AttachedImage.tryFromBytes(_jpegBytes, name: '2.jpg')!,
      ];
      final incoming = [
        PickedImageFile(bytes: _pngBytes, name: '3.png'),
        PickedImageFile(bytes: _gifBytes, name: '4.gif'),
        PickedImageFile(bytes: _webpBytes, name: '5.webp'),
      ];

      final result = selectAttachedImages(existing, incoming);
      expect(result.accepted, hasLength(2));
      expect(result.rejections, {ImageAttachmentRejectReason.count});
      expect(result.describeRejection(), contains('最多发送 4 张'));
      expect(result.accepted.first.toWireBlock(), {
        'type': 'image',
        'data': base64Encode(_pngBytes),
        'mimeType': 'image/png',
      });
    });

    test('enforces total decoded byte budget', () {
      final bigJpeg = Uint8List(3 * 1024 * 1024)..setAll(0, _jpegBytes);
      final existing = [AttachedImage.tryFromBytes(bigJpeg)!];
      final tooBigSecond = Uint8List(2 * 1024 * 1024)..setAll(0, _jpegBytes);
      final smallThird = _pngBytes;

      final result = selectAttachedImages(existing, [
        PickedImageFile(bytes: tooBigSecond, name: 'big.jpg'),
        PickedImageFile(bytes: smallThird, name: 'ok.png'),
      ]);

      expect(result.accepted, hasLength(1));
      expect(result.accepted.single.mimeType, 'image/png');
      expect(result.rejections, {ImageAttachmentRejectReason.bytes});
      expect(result.describeRejection(), contains('4 MB'));
    });

    test('rejects empty or unsupported files', () {
      final result = selectAttachedImages(const [], [
        PickedImageFile(bytes: Uint8List(0), name: 'empty.png'),
        PickedImageFile(bytes: Uint8List.fromList([0x3C, 0x73, 0x76, 0x67]), name: 'icon.svg'),
      ]);

      expect(result.accepted, isEmpty);
      expect(result.rejections, {ImageAttachmentRejectReason.unsupportedFormat});
      expect(result.describeRejection(), contains('PNG'));
    });
  });
}
