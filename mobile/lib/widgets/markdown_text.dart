/// Minimal markdown renderer for chat bubbles (zero-dependency): headers,
/// unordered/ordered lists, fenced code blocks, inline **bold** / *italic* /
/// `code` / [link](url) / ![image](path). Covers the subset the agent emits.
library;

import 'package:flutter/material.dart';

/// One `![alt](target)` found in a line of prose.
class _MarkdownImage {
  /// Display text while the picture loads, or instead of it when it cannot
  /// be shown.
  final String alt;
  final String target;

  const _MarkdownImage(this.alt, this.target);
}

/// Take the images out of a line of prose.
///
/// Returns the remaining text and the images in order. Inline code wins over
/// the image rule: `` `![x](a.png)` `` is a literal, not a picture.
({String text, List<_MarkdownImage> images}) _extractImages(String line) {
  final images = <_MarkdownImage>[];
  final text = StringBuffer();
  var cursor = 0;
  final token = RegExp(r'`[^`]*`|!\[([^\]]*)\]\(([^)]+)\)');
  for (final match in token.allMatches(line)) {
    text.write(line.substring(cursor, match.start));
    if (match[2] != null) {
      final target = match[2]!.trim();
      if (target.isNotEmpty) images.add(_MarkdownImage(match[1]!.trim(), target));
    } else {
      text.write(match[0]);
    }
    cursor = match.end;
  }
  text.write(line.substring(cursor));
  return (text: text.toString(), images: images);
}

/// Inline spans: parses **bold**, *italic*, `code`, [text](url).
///
/// Images have already been taken out of [text] by [_extractImages]. A `[..]`
/// preceded by `!` is never a link, so an image the caller cannot show stays
/// visible as its syntax instead of collapsing to `!alt`.
List<InlineSpan> _inlineSpans(
  BuildContext context,
  String text,
  TextStyle base,
) {
  final spans = <InlineSpan>[];
  final pattern = RegExp(r'\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`]+)`|(?<!!)\[([^\]]+)\]\(([^)]+)\)');
  var cursor = 0;
  for (final match in pattern.allMatches(text)) {
    if (match.start > cursor) {
      spans.add(TextSpan(text: text.substring(cursor, match.start), style: base));
    }
    final bold = match.group(1);
    final italic = match.group(2);
    final code = match.group(3);
    final linkText = match.group(4);
    final linkUrl = match.group(5);
    if (bold != null) {
      spans.add(TextSpan(
        text: bold,
        style: base.copyWith(fontWeight: FontWeight.bold),
      ));
    } else if (italic != null) {
      spans.add(TextSpan(text: italic, style: base.copyWith(fontStyle: FontStyle.italic)));
    } else if (code != null) {
      spans.add(TextSpan(
        text: code,
        style: base.copyWith(
          fontFamily: 'monospace',
          fontSize: (base.fontSize ?? 13) - 1,
          background: Paint()..color = Colors.black.withValues(alpha: 0.07),
        ),
      ));
    } else if (linkText != null && linkUrl != null) {
      spans.add(TextSpan(
        text: linkText,
        style: base.copyWith(
          color: Colors.blue,
          decoration: TextDecoration.underline,
          decorationColor: Colors.blue,
        ),
      ));
    }
    cursor = match.end;
  }
  if (cursor < text.length) {
    spans.add(TextSpan(text: text.substring(cursor), style: base));
  }
  if (spans.isEmpty) spans.add(TextSpan(text: text, style: base));
  return spans;
}

Widget _monoBlock(BuildContext context, String code) {
  return Container(
    width: double.infinity,
    margin: const EdgeInsets.symmetric(vertical: 4),
    padding: const EdgeInsets.all(8),
    decoration: BoxDecoration(
      color: Colors.black.withValues(alpha: 0.06),
      borderRadius: BorderRadius.circular(6),
    ),
    child: Text(
      code,
      style: const TextStyle(fontSize: 10.5, fontFamily: 'monospace', height: 1.35),
    ),
  );
}

/// One rendered block: paragraph / header / list item / code fence.
///
/// [buildImage] renders one `![alt](target)` of this block; when null (or for
/// headers and code) the image syntax stays as literal text.
Widget _block(
  BuildContext context,
  String kind,
  String content,
  TextStyle base, {
  MarkdownImageBuilder? buildImage,
}) {
  // Headers and code never contain pictures.
  if (kind == 'code' || kind.startsWith('h')) {
    return _textBlock(context, kind, content, base);
  }
  final extracted = _extractImages(content);
  if (buildImage == null || extracted.images.isEmpty) {
    // Put the syntax back exactly as written when it cannot be rendered.
    return _textBlock(context, kind, content, base);
  }
  final text = extracted.text.trim();
  final images = <Widget>[];
  for (final image in extracted.images) {
    final widget = buildImage(image.alt, image.target);
    if (widget != null) images.add(widget);
  }
  if (images.isEmpty) return _textBlock(context, kind, content, base);
  final Widget body = Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      // Always a paragraph: the list marker (if any) is drawn by the wrapper.
      if (text.isNotEmpty) _textBlock(context, 'p', text, base),
      ...images,
    ],
  );
  // A list item keeps its marker; the pictures go under the item's text.
  if (kind == 'ul' || kind == 'ol') {
    final dot = kind == 'ol' ? content.indexOf('.') : -1;
    final marker = dot > 0 ? '${content.substring(0, dot)}.' : '•';
    return Padding(
      padding: EdgeInsets.only(left: kind == 'ol' ? 4 : 10, top: 1, bottom: 1),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: EdgeInsets.only(right: kind == 'ol' ? 4 : 6),
            child: Text(marker, style: base.copyWith(fontWeight: kind == 'ol' ? FontWeight.bold : null)),
          ),
          Expanded(child: body),
        ],
      ),
    );
  }
  return Padding(padding: const EdgeInsets.symmetric(vertical: 1), child: body);
}

/// A block rendered as text only: no image extraction.
Widget _textBlock(BuildContext context, String kind, String content, TextStyle base) {
  switch (kind) {
    case 'code':
      return _monoBlock(context, content);
    case 'h1':
      return Padding(
        padding: const EdgeInsets.only(top: 4, bottom: 2),
        child: Text(
          content,
          style: base.copyWith(fontSize: (base.fontSize ?? 13) + 3, fontWeight: FontWeight.bold),
        ),
      );
    case 'h2':
      return Padding(
        padding: const EdgeInsets.only(top: 4, bottom: 2),
        child: Text(
          content,
          style: base.copyWith(fontSize: (base.fontSize ?? 13) + 2, fontWeight: FontWeight.bold),
        ),
      );
    case 'h3':
      return Padding(
        padding: const EdgeInsets.only(top: 3, bottom: 1),
        child: Text(
          content,
          style: base.copyWith(fontSize: (base.fontSize ?? 13) + 1, fontWeight: FontWeight.bold),
        ),
      );
    case 'ul':
      return Padding(
        padding: const EdgeInsets.only(left: 10, top: 1, bottom: 1),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(padding: EdgeInsets.only(right: 6), child: Text('•', style: TextStyle(height: 1.3))),
            Expanded(child: RichText(text: TextSpan(children: _inlineSpans(context, content, base)))),
          ],
        ),
      );
    case 'ol':
      final dot = content.indexOf('.');
      final number = dot > 0 ? content.substring(0, dot) : '';
      final body = dot > 0 ? content.substring(dot + 1).trim() : content;
      return Padding(
        padding: const EdgeInsets.only(left: 4, top: 1, bottom: 1),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Text('$number.', style: base.copyWith(fontWeight: FontWeight.bold)),
            ),
            Expanded(child: RichText(text: TextSpan(children: _inlineSpans(context, body, base)))),
          ],
        ),
      );
    default:
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 1),
        child: RichText(text: TextSpan(children: _inlineSpans(context, content, base))),
      );
  }
}

/// Renders one `![alt](target)` the reply refers to. Return null to leave the
/// image syntax as literal text (the target is not something this app shows).
typedef MarkdownImageBuilder = Widget? Function(String alt, String target);

/// Render markdown-ish chat text. Falls back to plain text for user bubbles.
class MarkdownText extends StatelessWidget {
  final String data;
  final TextStyle baseStyle;
  final bool plain;
  /// Renders `![alt](target)` pictures. Without it the syntax stays as text,
  /// which is right for places that cannot read files from the PC.
  final MarkdownImageBuilder? buildImage;

  const MarkdownText({
    required this.data,
    required this.baseStyle,
    this.plain = false,
    this.buildImage,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    if (plain) return Text(data, style: baseStyle);
    final widgets = <Widget>[];
    final lines = data.split('\n');
    var inCode = false;
    final codeBuffer = <String>[];
    for (final rawLine in lines) {
      if (rawLine.trimLeft().startsWith('```')) {
        if (inCode) {
          widgets.add(_block(context, 'code', codeBuffer.join('\n'), baseStyle));
          codeBuffer.clear();
        }
        inCode = !inCode;
        continue;
      }
      if (inCode) {
        codeBuffer.add(rawLine);
        continue;
      }
      final line = rawLine.trimRight();
      final trimmed = line.trim();
      if (trimmed.isEmpty) {
        widgets.add(const SizedBox(height: 4));
        continue;
      }
      final header = RegExp(r'^(#{1,3})\s+(.*)$').firstMatch(trimmed);
      if (header != null) {
        widgets.add(_block(context, 'h${header.group(1)!.length}', header.group(2)!, baseStyle, buildImage: buildImage));
        continue;
      }
      final ul = RegExp(r'^[-*]\s+(.*)$').firstMatch(trimmed);
      if (ul != null) {
        widgets.add(_block(context, 'ul', ul.group(1)!, baseStyle, buildImage: buildImage));
        continue;
      }
      final ol = RegExp(r'^(\d+\.)\s+(.*)$').firstMatch(trimmed);
      if (ol != null) {
        widgets.add(_block(context, 'ol', '${ol.group(1)} ${ol.group(2)}', baseStyle, buildImage: buildImage));
        continue;
      }
      widgets.add(_block(context, 'p', trimmed, baseStyle, buildImage: buildImage));
    }
    if (inCode && codeBuffer.isNotEmpty) {
      widgets.add(_block(context, 'code', codeBuffer.join('\n'), baseStyle));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: widgets);
  }
}
