/// Minimal markdown renderer for chat bubbles (zero-dependency): headers,
/// unordered/ordered lists, fenced code blocks, inline **bold** / *italic* /
/// `code` / [link](url). Covers the subset the agent actually emits.
library;

import 'package:flutter/material.dart';

/// Inline spans: parses **bold**, *italic*, `code`, [text](url).
List<InlineSpan> _inlineSpans(
  BuildContext context,
  String text,
  TextStyle base,
) {
  final spans = <InlineSpan>[];
  final pattern = RegExp(r'\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)');
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
Widget _block(BuildContext context, String kind, String content, TextStyle base) {
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

/// Render markdown-ish chat text. Falls back to plain text for user bubbles.
class MarkdownText extends StatelessWidget {
  final String data;
  final TextStyle baseStyle;
  final bool plain;

  const MarkdownText({required this.data, required this.baseStyle, this.plain = false, super.key});

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
        widgets.add(_block(context, 'h${header.group(1)!.length}', header.group(2)!, baseStyle));
        continue;
      }
      final ul = RegExp(r'^[-*]\s+(.*)$').firstMatch(trimmed);
      if (ul != null) {
        widgets.add(_block(context, 'ul', ul.group(1)!, baseStyle));
        continue;
      }
      final ol = RegExp(r'^(\d+\.)\s+(.*)$').firstMatch(trimmed);
      if (ol != null) {
        widgets.add(_block(context, 'ol', '${ol.group(1)} ${ol.group(2)}', baseStyle));
        continue;
      }
      widgets.add(_block(context, 'p', trimmed, baseStyle));
    }
    if (inCode && codeBuffer.isNotEmpty) {
      widgets.add(_block(context, 'code', codeBuffer.join('\n'), baseStyle));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: widgets);
  }
}
