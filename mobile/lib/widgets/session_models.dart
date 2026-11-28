/// Shared models + parsing helpers for the remote session UI. Tool rendering
/// mirrors the desktop MessageView: toolCall blocks become collapsible cards,
/// toolResult messages pair into their card by toolCallId.
library;

import 'image_block.dart';

/// One rendered line in the chat view: a text bubble, thinking card, tool
/// card, image or outcome card.
class ChatLine {
  final String kind; // 'text' | 'thinking' | 'tool' | 'image' | 'outcome'
  String role;
  String text;
  bool done;
  /// Ordinal of the source message in the transcript. History assigns it while
  /// walking `context.messages`; live events count `message_start`. Process
  /// groups use it for stable keys and per-message counts.
  int? messageIndex;
  // Tool card fields (kind == 'tool').
  String? toolCallId;
  String? toolName;
  /// True for a toolCall block; false for a standalone toolResult card.
  bool fromToolCall;
  /// Raw tool arguments, kept so the card can derive its action title and
  /// serialize the args only while expanded.
  Map<dynamic, dynamic>? input;
  String? resultText;
  bool resultIsError;
  /// Images the tool returned, shown under the result when the card is open.
  List<ImageRef> resultImages;
  bool running;
  // Image fields (kind == 'image').
  ImageRef? image;
  /// Position of this image among the image blocks of its source message.
  /// Live events carry no entry id, so this plus [messageIndex] is the only
  /// identity a streamed image has.
  int imageOrdinal;
  // Outcome card fields (kind == 'outcome'). True for a stopped turn ("已停止"
  // muted card), false for a model request failure (red card).
  final bool stopped;
  ChatLine.text({required this.role, required this.text, this.done = false, this.messageIndex})
      : kind = 'text',
        fromToolCall = false,
        resultIsError = false,
        resultImages = const [],
        image = null,
        imageOrdinal = 0,
        stopped = false,
        running = false;
  ChatLine.thinking({required this.role, required this.text, this.done = false, this.messageIndex})
      : kind = 'thinking',
        fromToolCall = false,
        resultIsError = false,
        resultImages = const [],
        image = null,
        imageOrdinal = 0,
        stopped = false,
        running = false;
  ChatLine.tool({
    required this.toolCallId,
    required this.toolName,
    this.input,
    this.running = false,
    this.messageIndex,
    this.fromToolCall = false,
  })  : kind = 'tool',
        role = 'assistant',
        text = '',
        done = false,
        resultIsError = false,
        resultImages = const [],
        image = null,
        imageOrdinal = 0,
        stopped = false;
  ChatLine.image({
    required this.image,
    required this.role,
    this.messageIndex,
    this.imageOrdinal = 0,
  })  : kind = 'image',
        text = '',
        done = true,
        fromToolCall = false,
        resultIsError = false,
        resultImages = const [],
        stopped = false,
        running = false;
  /// Outcome card for a finished assistant message: a model request failure
  /// (red card, [text] carries the detail) or a stopped turn (muted card).
  /// Always done — outcomes only exist for settled messages.
  ChatLine.outcome({
    required this.role,
    required this.text,
    required this.stopped,
    this.messageIndex,
  })  : kind = 'outcome',
        done = true,
        fromToolCall = false,
        resultIsError = false,
        resultImages = const [],
        image = null,
        imageOrdinal = 0,
        running = false;
}

/// One image attached to a line: where its bytes come from. The decoded bytes
/// live in the page's image cache, not here.
class ImageRef {
  ImageBlockData data;

  ImageRef(this.data);
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

/// Displayable image blocks of a message's `content`, in order.
List<ImageRef> extractImages(Object? content) {
  if (content is! List) return const [];
  final images = <ImageRef>[];
  for (final block in content) {
    if (block is! Map || block['type'] != 'image') continue;
    final parsed = parseImageBlock(block);
    if (parsed != null) images.add(ImageRef(parsed));
  }
  return images;
}

/// Upsert a tool card line by toolCallId; returns its index.
///
/// [live] cards start out running until their result pairs in. History cards
/// never do: a toolCall with no recorded result (truncated history) must not
/// spin forever.
int upsertToolCard(
  List<ChatLine> lines,
  Map<String, int> indexByCallId,
  Map<dynamic, dynamic> block, {
  bool live = true,
  int? messageIndex,
}) {
  final toolCallId = block['toolCallId'] as String? ?? '';
  final rawInput = block['input'];
  final input = rawInput is Map ? rawInput : null;
  final toolName = block['toolName'] as String? ?? 'tool';
  final existing = indexByCallId[toolCallId];
  if (existing != null && existing < lines.length && lines[existing].kind == 'tool') {
    final line = lines[existing];
    line.toolName = toolName;
    // Early streaming snapshots may carry a partial or missing input; keep
    // the last complete one so the action title does not flicker backwards.
    if (input != null) line.input = input;
    return existing;
  }
  lines.add(ChatLine.tool(
    toolCallId: toolCallId,
    toolName: toolName,
    input: input,
    running: live,
    messageIndex: messageIndex,
    fromToolCall: true,
  ));
  indexByCallId[toolCallId] = lines.length - 1;
  return lines.length - 1;
}

/// Pair a toolResult message into its tool card; returns true when paired.
bool applyToolResult(
  List<ChatLine> lines,
  Map<String, int> indexByCallId,
  Map<dynamic, dynamic> message, {
  int? messageIndex,
}) {
  final toolCallId = message['toolCallId'] as String?;
  final text = extractText(message['content']) ?? '';
  final isError = message['isError'] == true;
  final images = extractImages(message['content']);
  final existing = toolCallId == null ? null : indexByCallId[toolCallId];
  if (existing != null && existing < lines.length && lines[existing].kind == 'tool') {
    final line = lines[existing];
    line.resultText = text.trim().isEmpty ? '(无输出)' : text;
    line.resultIsError = isError;
    line.resultImages = images;
    line.running = false;
    line.done = true;
    return true;
  }
  // A silent result with nothing to show is not worth a card.
  if (text.trim().isEmpty && !isError && images.isEmpty) return false;
  // Unpaired result (e.g. truncated history): standalone tool line.
  lines.add(ChatLine.tool(
    toolCallId: toolCallId ?? '',
    toolName: message['toolName'] as String? ?? 'tool',
    messageIndex: messageIndex,
  ));
  final line = lines.last;
  line.resultText = text.trim().isEmpty ? '(无输出)' : text;
  line.resultIsError = isError;
  line.resultImages = images;
  line.running = false;
  line.done = true;
  return true;
}

/// True when a toolResult is a successful `models.generateImages` call, the
/// one tool whose images the desktop also lifts into the reply.
/// Mirrors `withGeneratedImageReply` (renderer/lib/generated-image-reply.ts).
bool isGeneratedImageResult(Map<dynamic, dynamic> message) {
  if (message['role'] != 'toolResult' || message['toolName'] != 'codemode') return false;
  final details = message['details'];
  if (details is! Map) return false;
  final calls = details['calls'];
  if (calls is! List) return false;
  return calls.any(
    (call) => call is Map && call['name'] == 'models.generateImages' && call['status'] == 'ok',
  );
}

/// Outcome line for a settled assistant message, or null for ordinary ones.
///
/// Mirrors the desktop AssistantOutcome (src/shared/message-display.ts):
/// `stopReason: "error"` renders a failure card with the provider's
/// `errorMessage` as detail, `stopReason: "aborted"` a muted stopped card.
/// These messages carry no displayable content block (just an empty text
/// placeholder), so without this they vanish from the transcript entirely.
ChatLine? assistantOutcomeLine(Map<dynamic, dynamic> message, {int? messageIndex}) {
  if (message['role'] != 'assistant') return null;
  final stopReason = message['stopReason'];
  final stopped = stopReason == 'aborted';
  if (!stopped && stopReason != 'error') return null;
  final rawDetail = stopped ? null : message['errorMessage'];
  final detail = rawDetail is String ? rawDetail.trim() : '';
  return ChatLine.outcome(
    role: 'assistant',
    // Desktop falls back to this text when the provider returned no detail.
    text: detail.isEmpty && !stopped ? '模型服务未返回错误详情，请检查 API 密钥、服务地址和模型配置。' : detail,
    stopped: stopped,
    messageIndex: messageIndex,
  );
}

/// Build chat lines from a sessions.get detail (history), including tool
/// cards paired with their results.
///
/// `ordinalOffset` shifts every line's message ordinal: with paged history the
/// first loaded message is not message 0 of the session, and live events
/// count from the session total.
List<ChatLine> historyLinesFromDetail(Map<String, dynamic> detail, {int ordinalOffset = 0}) {
  final lines = <ChatLine>[];
  final indexByCallId = <String, int>{};
  final context = detail['context'];
  final messages = context is Map ? context['messages'] : null;
  if (messages is! List) return lines;

  // Generated images are lifted out of the turn's tool results and appended
  // after that turn's last line, the way the desktop reply shows them. One
  // entry per turn: where in `lines` the turn ended, and what to insert there.
  final generatedInserts = <({int at, int messageIndex, List<ImageRef> images})>[];
  var turnImages = <ImageRef>[];
  var turnStartOrdinal = -1;

  void closeTurn() {
    if (turnImages.isNotEmpty && lines.isNotEmpty) {
      generatedInserts.add((at: lines.length, messageIndex: lines.last.messageIndex ?? turnStartOrdinal, images: turnImages));
    }
    turnImages = <ImageRef>[];
  }

  for (var messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    final message = messages[messageIndex];
    if (message is! Map) continue;
    final role = message['role'] as String? ?? 'assistant';
    final ordinal = messageIndex + ordinalOffset;
    if (role == 'toolResult') {
      applyToolResult(lines, indexByCallId, message, messageIndex: ordinal);
      if (isGeneratedImageResult(message)) turnImages.addAll(extractImages(message['content']));
      continue;
    }
    if (role != 'user' && role != 'assistant') continue;
    if (role == 'user') {
      closeTurn();
      turnStartOrdinal = ordinal;
    }
    // A failed/stopped assistant message trails its turn as an outcome card,
    // after any displayable blocks it might still carry.
    final outcome = role == 'assistant' ? assistantOutcomeLine(message, messageIndex: ordinal) : null;
    final content = message['content'];
    if (content is! List) {
      final text = extractText(content);
      if (text != null && text.trim().isNotEmpty) {
        lines.add(ChatLine.text(role: role, text: text.trim(), done: true, messageIndex: ordinal));
      }
      if (outcome != null) lines.add(outcome);
      continue;
    }
    for (final block in content) {
      if (block is! Map) continue;
      if (block['type'] == 'toolCall') {
        upsertToolCard(lines, indexByCallId, block, live: false, messageIndex: ordinal);
      } else if (block['type'] == 'thinking') {
        final thinking = (block['thinking'] as String? ?? '').trim();
        if (thinking.isNotEmpty) {
          lines.add(ChatLine.thinking(role: role, text: thinking, done: true, messageIndex: ordinal));
        }
      } else if (block['type'] == 'text') {
        final text = (block['text'] as String? ?? '').trim();
        if (text.isNotEmpty) {
          lines.add(ChatLine.text(role: role, text: text, done: true, messageIndex: ordinal));
        }
      } else if (block['type'] == 'image') {
        final parsed = parseImageBlock(block);
        if (parsed != null) lines.add(ChatLine.image(image: ImageRef(parsed), role: role, messageIndex: ordinal));
      }
    }
    if (outcome != null) lines.add(outcome);
  }
  closeTurn();

  // Insert back to front so earlier insertion points stay valid.
  for (final insert in generatedInserts.reversed) {
    lines.insertAll(
      insert.at,
      [
        for (final image in insert.images)
          ChatLine.image(image: image, role: 'assistant', messageIndex: insert.messageIndex),
      ],
    );
  }
  return lines;
}

/// Total messages in the session according to a sessions.get detail, or null
/// when the PC did not paginate (an unpaged response carries no totals).
int? historyTotalMessages(Map<String, dynamic> detail) {
  final context = detail['context'];
  if (context is! Map) return null;
  final total = context['totalMessages'];
  return total is int ? total : null;
}

/// How many messages precede the loaded page. Live events count ordinals from
/// the session total, so a partial page must be shifted by this to keep its
/// ordinals from colliding with freshly streamed ones.
int historyOrdinalOffset(Map<String, dynamic> detail) {
  final context = detail['context'];
  if (context is! Map) return 0;
  final total = context['totalMessages'];
  final loaded = context['loadedMessages'];
  if (total is! int || loaded is! int) return 0;
  final offset = total - loaded;
  return offset < 0 ? 0 : offset;
}

/// Number of messages in a sessions.get detail, used to seed the live message
/// ordinal so freshly streamed lines never collide with history entries.
int historyMessageCount(Map<String, dynamic> detail) {
  final context = detail['context'];
  final messages = context is Map ? context['messages'] : null;
  return messages is List ? messages.length : 0;
}

/// Cursor for the page before this one, or null when nothing is older.
String? historyPreviousCursor(Map<String, dynamic> detail) {
  final context = detail['context'];
  if (context is! Map || context['truncatedBefore'] != true) return null;
  final cursor = context['previousCursor'];
  return cursor is String && cursor.isNotEmpty ? cursor : null;
}

/// Where an older page sits in the session, given the oldest ordinal loaded
/// so far. The page ends right before that message, so its first message is
/// `oldestOrdinal - pageLength` and the new oldest ordinal is the same value.
/// Loading several pages in a row keeps walking down toward 0, which keeps
/// ordinals unique across pages (and clear of live events, which count up
/// from the session total).
({int offset, int oldest}) olderPageOrdinals({required int oldestOrdinal, required int pageLength}) {
  final offset = oldestOrdinal - pageLength;
  // Never negative: an unpaged or odd response must not produce bogus keys.
  return (offset: offset < 0 ? 0 : offset, oldest: offset < 0 ? 0 : offset);
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
