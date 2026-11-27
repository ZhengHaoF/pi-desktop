/// Minimal markdown renderer for chat bubbles (zero-dependency): headers,
/// unordered/ordered lists, fenced code blocks with copy/scroll, blockquotes,
/// horizontal rules, and inline **bold** / *italic* / `code` / [link](url) /
/// ![image](path).
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/app_theme.dart';

/// One `![alt](target)` found in a line of prose.
class _MarkdownImage {
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
          color: AppColors.brandInk,
          backgroundColor: AppColors.brandSoft,
        ),
      ));
    } else if (linkText != null && linkUrl != null) {
      spans.add(TextSpan(
        text: linkText,
        style: base.copyWith(
          color: AppColors.brand,
          decoration: TextDecoration.underline,
          decorationColor: AppColors.brand,
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

class _CodeBlockWidget extends StatefulWidget {
  final String code;
  final String language;

  const _CodeBlockWidget({required this.code, this.language = ''});

  @override
  State<_CodeBlockWidget> createState() => _CodeBlockWidgetState();
}

class _CodeBlockWidgetState extends State<_CodeBlockWidget> {
  bool _copied = false;
  Timer? _resetTimer;

  @override
  void dispose() {
    _resetTimer?.cancel();
    super.dispose();
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) return;
    setState(() => _copied = true);
    _resetTimer?.cancel();
    _resetTimer = Timer(const Duration(milliseconds: 1500), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final label = widget.language.trim().isEmpty ? 'code' : widget.language.trim();
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        color: AppColors.surfaceSubtle,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.fromLTRB(10, 5, 6, 5),
            decoration: const BoxDecoration(
              color: AppColors.surfaceMuted,
              borderRadius: BorderRadius.vertical(top: Radius.circular(9)),
              border: Border(bottom: BorderSide(color: AppColors.border)),
            ),
            child: Row(
              children: [
                Text(
                  label,
                  style: const TextStyle(
                    fontSize: 11,
                    fontFamily: 'monospace',
                    fontWeight: FontWeight.w600,
                    color: AppColors.textSecondary,
                  ),
                ),
                const Spacer(),
                InkWell(
                  onTap: _copy,
                  borderRadius: BorderRadius.circular(6),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          _copied ? Icons.check_rounded : Icons.copy_rounded,
                          size: 13,
                          color: _copied ? AppColors.success : AppColors.textMuted,
                        ),
                        const SizedBox(width: 4),
                        Text(
                          _copied ? '已复制' : '复制',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w500,
                            color: _copied ? AppColors.success : AppColors.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.all(10),
            child: Text(
              widget.code,
              style: const TextStyle(
                fontSize: 11.5,
                fontFamily: 'monospace',
                height: 1.45,
                color: AppColors.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// One rendered block: paragraph / header / list item / quote / code fence.
Widget _block(
  BuildContext context,
  String kind,
  String content,
  TextStyle base, {
  String codeLang = '',
  MarkdownImageBuilder? buildImage,
}) {
  if (kind == 'code') {
    return _CodeBlockWidget(code: content, language: codeLang);
  }
  if (kind == 'hr') {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 6),
      child: Divider(height: 1, color: AppColors.border),
    );
  }
  if (kind.startsWith('h')) {
    return _textBlock(context, kind, content, base);
  }
  final extracted = _extractImages(content);
  if (buildImage == null || extracted.images.isEmpty) {
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
      if (text.isNotEmpty) _textBlock(context, 'p', text, base),
      ...images,
    ],
  );
  if (kind == 'quote') {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 3),
      padding: const EdgeInsets.fromLTRB(10, 4, 8, 4),
      decoration: const BoxDecoration(
        color: AppColors.surfaceSubtle,
        border: Border(left: BorderSide(color: AppColors.brandBorder, width: 3)),
      ),
      child: body,
    );
  }
  if (kind == 'ul' || kind == 'ol') {
    final dot = kind == 'ol' ? content.indexOf('.') : -1;
    final marker = dot > 0 ? '${content.substring(0, dot)}.' : '•';
    return Padding(
      padding: EdgeInsets.only(left: kind == 'ol' ? 4 : 10, top: 2, bottom: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: EdgeInsets.only(right: kind == 'ol' ? 5 : 6),
            child: Text(marker, style: base.copyWith(fontWeight: kind == 'ol' ? FontWeight.bold : null)),
          ),
          Expanded(child: body),
        ],
      ),
    );
  }
  return Padding(padding: const EdgeInsets.symmetric(vertical: 1.5), child: body);
}

/// A block rendered as text only: no image extraction.
Widget _textBlock(BuildContext context, String kind, String content, TextStyle base) {
  switch (kind) {
    case 'quote':
      return Container(
        width: double.infinity,
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.fromLTRB(10, 4, 8, 4),
        decoration: const BoxDecoration(
          color: AppColors.surfaceSubtle,
          border: Border(left: BorderSide(color: AppColors.brandBorder, width: 3)),
        ),
        child: RichText(
          text: TextSpan(
            children: _inlineSpans(
              context,
              content,
              base.copyWith(color: AppColors.textSecondary),
            ),
          ),
        ),
      );
    case 'h1':
      return Padding(
        padding: const EdgeInsets.only(top: 6, bottom: 3),
        child: Text(
          content,
          style: base.copyWith(fontSize: (base.fontSize ?? 13.5) + 3.5, fontWeight: FontWeight.w700),
        ),
      );
    case 'h2':
      return Padding(
        padding: const EdgeInsets.only(top: 5, bottom: 2),
        child: Text(
          content,
          style: base.copyWith(fontSize: (base.fontSize ?? 13.5) + 2, fontWeight: FontWeight.w700),
        ),
      );
    case 'h3':
      return Padding(
        padding: const EdgeInsets.only(top: 4, bottom: 1.5),
        child: Text(
          content,
          style: base.copyWith(fontSize: (base.fontSize ?? 13.5) + 1, fontWeight: FontWeight.w600),
        ),
      );
    case 'ul':
      return Padding(
        padding: const EdgeInsets.only(left: 10, top: 2, bottom: 2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(padding: EdgeInsets.only(right: 6), child: Text('•', style: TextStyle(height: 1.35))),
            Expanded(child: RichText(text: TextSpan(children: _inlineSpans(context, content, base)))),
          ],
        ),
      );
    case 'ol':
      final dot = content.indexOf('.');
      final number = dot > 0 ? content.substring(0, dot) : '';
      final body = dot > 0 ? content.substring(dot + 1).trim() : content;
      return Padding(
        padding: const EdgeInsets.only(left: 4, top: 2, bottom: 2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(right: 5),
              child: Text('$number.', style: base.copyWith(fontWeight: FontWeight.w600)),
            ),
            Expanded(child: RichText(text: TextSpan(children: _inlineSpans(context, body, base)))),
          ],
        ),
      );
    default:
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 1.5),
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
    var codeLang = '';
    final codeBuffer = <String>[];
    for (final rawLine in lines) {
      if (rawLine.trimLeft().startsWith('```')) {
        if (inCode) {
          widgets.add(_block(context, 'code', codeBuffer.join('\n'), baseStyle, codeLang: codeLang));
          codeBuffer.clear();
          codeLang = '';
        } else {
          codeLang = rawLine.trimLeft().substring(3).trim();
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
        widgets.add(const SizedBox(height: 5));
        continue;
      }
      if (RegExp(r'^(-{3,}|\*{3,}|_{3,})$').hasMatch(trimmed)) {
        widgets.add(_block(context, 'hr', '', baseStyle));
        continue;
      }
      final header = RegExp(r'^(#{1,3})\s+(.*)$').firstMatch(trimmed);
      if (header != null) {
        widgets.add(_block(context, 'h${header.group(1)!.length}', header.group(2)!, baseStyle, buildImage: buildImage));
        continue;
      }
      final quote = RegExp(r'^>\s?(.*)$').firstMatch(trimmed);
      if (quote != null) {
        widgets.add(_block(context, 'quote', quote.group(1)!, baseStyle, buildImage: buildImage));
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
      widgets.add(_block(context, 'code', codeBuffer.join('\n'), baseStyle, codeLang: codeLang));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: widgets);
  }
}
