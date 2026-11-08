/// Shared models + parsing helpers for the remote session UI. Tool rendering
/// mirrors the desktop MessageView: toolCall blocks become collapsible cards,
/// toolResult messages pair into their card by toolCallId.
library;

import 'dart:convert';

String _clip(String value, [int max = 120]) =>
    value.length <= max ? value : value.substring(0, max);

/// One rendered line in the chat view: a text bubble, thinking card or tool card.
class ChatLine {
  final String kind; // 'text' | 'thinking' | 'tool'
  String role;
  String text;
  bool done;
  // Tool card fields (kind == 'tool').
  String? toolCallId;
  String? toolName;
  String? inputJson;
  String? preview;
  String? resultText;
  bool resultIsError;
  bool running;
  ChatLine.text({required this.role, required this.text, this.done = false})
      : kind = 'text',
        resultIsError = false,
        running = false;
  ChatLine.thinking({required this.role, required this.text, this.done = false})
      : kind = 'thinking',
        resultIsError = false,
        running = false;
  ChatLine.tool({
    required this.toolCallId,
    required this.toolName,
    required this.inputJson,
    required this.preview,
  })  : kind = 'tool',
        role = 'assistant',
        text = '',
        done = false,
        resultIsError = false,
        running = true;
}

/// A PC session as returned by sessions.list (SessionInfo subset).
class SessionSummary {
  final String id;
  final String cwd;
  final String? name;
  final String firstMessage;
  final int messageCount;
  final DateTime modified;
  final String projectRoot;
  SessionSummary({
    required this.id,
    required this.cwd,
    required this.name,
    required this.firstMessage,
    required this.messageCount,
    required this.modified,
    required this.projectRoot,
  });

  factory SessionSummary.fromMap(Map<String, dynamic> map) {
    return SessionSummary(
      id: map['id'] as String? ?? '',
      cwd: map['cwd'] as String? ?? '',
      name: map['name'] as String?,
      firstMessage: (map['firstMessage'] as String? ?? '').trim(),
      messageCount: (map['messageCount'] as num?)?.toInt() ?? 0,
      modified: DateTime.tryParse(map['modified'] as String? ?? '') ?? DateTime.now(),
      projectRoot: (map['projectRoot'] as String?) ?? (map['cwd'] as String? ?? ''),
    );
  }

  String get title {
    final n = name;
    if (n != null && n.trim().isNotEmpty) return n.trim();
    final f = firstMessage;
    if (f.isNotEmpty) return f.length > 40 ? '${f.substring(0, 40)}…' : f;
    return '(无标题)';
  }
}

String projectName(String root) {
  final normalized = root.replaceAll('\\', '/');
  final parts = normalized.split('/').where((p) => p.isNotEmpty).toList();
  return parts.isEmpty ? root : parts.last;
}

String relativeTime(DateTime time) {
  final diff = DateTime.now().difference(time);
  if (diff.inMinutes < 1) return '刚刚';
  if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
  if (diff.inHours < 24) return '${diff.inHours} 小时前';
  if (diff.inDays < 30) return '${diff.inDays} 天前';
  return '${time.year}-${time.month}-${time.day}';
}

String? extractText(Object? content) {
  if (content is String) return content;
  if (content is List) {
    final buffer = StringBuffer();
    for (final block in content) {
      if (block is Map && block['type'] == 'text') buffer.write(block['text'] as String? ?? '');
    }
    return buffer.toString();
  }
  return null;
}

/// Mirrors the desktop getToolPreview: the first meaningful input value.
String toolPreview(Map<dynamic, dynamic> input) {
  if (input.isEmpty) return '';
  for (final key in ['command', 'path', 'file_path', 'pattern', 'query']) {
    if (input.containsKey(key)) return _clip('${input[key]}'.replaceAll('\n', ' '));
  }
  return _clip('${input.values.first}'.replaceAll('\n', ' '));
}

/// Chinese display labels for common tools, aligned with the desktop.
String toolDisplayName(String toolName) {
  final lower = toolName.toLowerCase();
  if (lower == 'bash' || lower == 'powershell' || lower.contains('command')) return '终端';
  if (lower == 'read') return '读取文件';
  if (lower == 'write') return '写入文件';
  if (lower == 'edit' || lower == 'multiedit') return '编辑文件';
  if (lower.startsWith('browser')) return '浏览器';
  if (lower.contains('websearch') || lower.contains('search')) return '搜索';
  if (lower.contains('fetch')) return '网页抓取';
  if (lower.contains('todo')) return '任务清单';
  return toolName;
}

/// Upsert a tool card line by toolCallId; returns its index.
int upsertToolCard(
  List<ChatLine> lines,
  Map<String, int> indexByCallId,
  Map<dynamic, dynamic> block,
) {
  final toolCallId = block['toolCallId'] as String? ?? '';
  final input = block['input'];
  final inputJson = input is Map ? const JsonEncoder.withIndent('  ').convert(input) : '${input ?? ''}';
  final preview = input is Map ? toolPreview(input) : '';
  final toolName = block['toolName'] as String? ?? 'tool';
  final existing = indexByCallId[toolCallId];
  if (existing != null && existing < lines.length && lines[existing].kind == 'tool') {
    final line = lines[existing];
    line.toolName = toolName;
    line.inputJson = inputJson;
    line.preview = preview;
    return existing;
  }
  lines.add(ChatLine.tool(toolCallId: toolCallId, toolName: toolName, inputJson: inputJson, preview: preview));
  indexByCallId[toolCallId] = lines.length - 1;
  return lines.length - 1;
}

/// Pair a toolResult message into its tool card; returns true when paired.
bool applyToolResult(
  List<ChatLine> lines,
  Map<String, int> indexByCallId,
  Map<dynamic, dynamic> message,
) {
  final toolCallId = message['toolCallId'] as String?;
  final text = extractText(message['content']) ?? '';
  final isError = message['isError'] == true;
  final existing = toolCallId == null ? null : indexByCallId[toolCallId];
  if (existing != null && existing < lines.length && lines[existing].kind == 'tool') {
    final line = lines[existing];
    line.resultText = text.trim().isEmpty ? '(无输出)' : text;
    line.resultIsError = isError;
    line.running = false;
    line.done = true;
    return true;
  }
  if (text.trim().isEmpty && !isError) return false;
  // Unpaired result (e.g. truncated history): standalone tool line.
  lines.add(ChatLine.tool(
    toolCallId: toolCallId ?? '',
    toolName: message['toolName'] as String? ?? 'tool',
    inputJson: '',
    preview: '',
  ));
  final line = lines.last;
  line.resultText = text.trim().isEmpty ? '(无输出)' : text;
  line.resultIsError = isError;
  line.running = false;
  line.done = true;
  return true;
}

/// Build chat lines from a sessions.get detail (history), including tool
/// cards paired with their results.
List<ChatLine> historyLinesFromDetail(Map<String, dynamic> detail) {
  final lines = <ChatLine>[];
  final indexByCallId = <String, int>{};
  final context = detail['context'];
  final messages = context is Map ? context['messages'] : null;
  if (messages is List) {
    for (final message in messages) {
      if (message is! Map) continue;
      final role = message['role'] as String? ?? 'assistant';
      if (role == 'toolResult') {
        applyToolResult(lines, indexByCallId, message);
        continue;
      }
      if (role != 'user' && role != 'assistant') continue;
      final content = message['content'];
      if (content is! List) {
        final text = extractText(content);
        if (text != null && text.trim().isNotEmpty) {
          lines.add(ChatLine.text(role: role, text: text.trim(), done: true));
        }
        continue;
      }
      for (final block in content) {
        if (block is! Map) continue;
        if (block['type'] == 'toolCall') {
          upsertToolCard(lines, indexByCallId, block);
        } else if (block['type'] == 'thinking') {
          final thinking = (block['thinking'] as String? ?? '').trim();
          if (thinking.isNotEmpty) {
            lines.add(ChatLine.thinking(role: role, text: thinking, done: true));
          }
        } else if (block['type'] == 'text') {
          final text = (block['text'] as String? ?? '').trim();
          if (text.isNotEmpty) lines.add(ChatLine.text(role: role, text: text, done: true));
        }
      }
    }
  }
  return lines;
}

/// Group session summaries by project root, sorted by recency.
Map<String, List<SessionSummary>> groupByProject(List<SessionSummary> sessions) {
  final grouped = <String, List<SessionSummary>>{};
  for (final s in sessions) {
    grouped.putIfAbsent(s.projectRoot.isEmpty ? s.cwd : s.projectRoot, () => []).add(s);
  }
  for (final list in grouped.values) {
    list.sort((a, b) => b.modified.compareTo(a.modified));
  }
  return grouped;
}
