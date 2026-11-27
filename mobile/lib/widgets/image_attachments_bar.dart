/// Horizontal thumbnail strip for images queued in the chat composer, plus
/// right-aligned local image preview bubbles while a user message is in flight.
library;

import 'package:flutter/material.dart';

import '../core/image_attachments.dart';

/// Compact horizontal strip of pending image attachments above the input box.
class PendingImagesBar extends StatelessWidget {
  final List<AttachedImage> images;
  final void Function(int index) onRemove;

  const PendingImagesBar({
    required this.images,
    required this.onRemove,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    if (images.isEmpty) return const SizedBox.shrink();
    return SizedBox(
      height: 68,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.only(top: 6, bottom: 4),
        itemCount: images.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final img = images[index];
          return Stack(
            clipBehavior: Clip.none,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Image.memory(
                  img.bytes,
                  width: 56,
                  height: 56,
                  fit: BoxFit.cover,
                  cacheWidth: 168,
                  errorBuilder: (_, _, _) => Container(
                    width: 56,
                    height: 56,
                    color: const Color(0xFFF0F0F3),
                    child: const Icon(Icons.broken_image_outlined, size: 20, color: Colors.black38),
                  ),
                ),
              ),
              Positioned(
                top: -5,
                right: -5,
                child: Semantics(
                  button: true,
                  label: '移除第 ${index + 1} 张图片',
                  child: GestureDetector(
                    key: Key('remove-attached-image-$index'),
                    onTap: () => onRemove(index),
                    child: Container(
                      width: 20,
                      height: 20,
                      decoration: const BoxDecoration(
                        color: Color(0xCC1E1E24),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(Icons.close, size: 13, color: Colors.white),
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// Optimistic user-side thumbnail shown while an outgoing image message waits
/// for the PC's `agent.events` echo.
class SendingImageBubble extends StatelessWidget {
  final AttachedImage image;

  const SendingImageBubble({required this.image, super.key});

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerRight,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            minWidth: 120,
            maxWidth: 260,
            minHeight: 90,
            maxHeight: 320,
          ),
          child: Opacity(
            opacity: 0.78,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: Image.memory(
                image.bytes,
                fit: BoxFit.contain,
                cacheWidth: (260 * MediaQuery.devicePixelRatioOf(context)).round(),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
