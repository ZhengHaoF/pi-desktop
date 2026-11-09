/// Chat page bound to a real PC session: history from sessions.get, live
/// agent.events stream, prompt / steer commands, approval cards, abort.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../core/remote_connection.dart';
import '../widgets/markdown_text.dart';
import '../widgets/session_models.dart';

class ChatPage extends StatefulWidget {
  const ChatPage({
    required this.connection,
    required this.sessionId,
    required this.title,
    super.key,
  });

  final RemoteConnection connection;
  final String sessionId;
  final String title;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final _promptController = TextEditingController();
  final _scrollController = ScrollController();
  final _lines = <ChatLine>[];
  final _toolIndexByCallId = <String, int>{};
  final _expandedTools = <String>{};
  final _expandedThinking = <String>{};
  final _approvals = <Map<String, dynamic>>[];
  String? _error;
  StreamSubscription<RemoteSessionEvent>? _events;
  Timer? _renderThrottle;
  bool _pendingRender = false;
  Map<String, String>? _currentModel; // {provider, modelId}
  bool _switchingModel = false;
  String? _sendingText;
  bool _awaitingFirst = false;
  bool _slashOpen = false;
  bool _slashSkillsLoaded = false;
  /// Turn-state mirror (PC `isStreaming` equivalent): true while the agent
  /// is running a turn on the PC. Drives steer-vs-prompt and the queue bar.
  bool _turnRunning = false;
  Timer? _queuePollTimer;
  List<String> _steeringQueue = const [];
  List<String> _followUpQueue = const [];
  bool _clearingQueue = false;
  List<Map<String, String>> _slashItems = const [
    {'name': 'compact', 'desc': '压缩上下文，可附指令', 'source': '内置'},
    {'name': 'reload', 'desc': '重载扩展、技能、提示词与工具', 'source': '内置'},
    {'name': 'name', 'desc': '设置会话显示名', 'source': '内置'},
    {'name': 'session', 'desc': '查看会话消息/token/费用统计', 'source': '内置'},
    {'name': 'copy', 'desc': '复制最后一条助手回复', 'source': '内置'},
  ];
  late final String _sessionId = widget.sessionId;

  @override
  void initState() {
    super.initState();
    _attach();
  }

  Future<void> _attach() async {
    _events = widget.connection.onEvent.listen(_onEvent);
    try {
      await widget.connection.subscribe('agent.events', _sessionId);
      await widget.connection.subscribe('agent.running', _sessionId);
      // includeState is required or the PC omits agentState entirely,
      // which would break the running-mirror restore below.
      final detail = await widget.connection.request(
        'sessions.get',
        {'id': _sessionId, 'includeState': true},
      );
      setState(() {
        _lines
          ..clear()
          ..addAll(historyLinesFromDetail(detail));
        _currentModel = _modelFromDetail(detail);
        // Restore the turn-running mirror from the session snapshot so the
        // steer-vs-prompt choice is correct right after opening the page.
        final agentState = detail['agentState'];
        _turnRunning = agentState is Map ? agentState['running'] == true : false;
      });
      if (_turnRunning) _startQueuePolling();
      _throttledScroll();
    } catch (err) {
      setState(() => _error = err.toString());
    }
  }

  Map<String, String>? _modelFromDetail(Map<String, dynamic> detail) {
    final context = detail['context'];
    if (context is Map) {
      for (final key in ['selectedModel', 'model']) {
        final m = context[key];
        if (m is Map && m['provider'] is String && m['modelId'] is String) {
          return {'provider': m['provider'] as String, 'modelId': m['modelId'] as String};
        }
      }
    }
    final agentState = detail['agentState'];
    if (agentState is Map) {
      final m = agentState['model'];
      if (m is Map && m['provider'] is String && m['id'] is String) {
        return {'provider': m['provider'] as String, 'modelId': m['id'] as String};
      }
    }
    return null;
  }

  Future<void> _pickModel() async {
    try {
      final prefs = await widget.connection.request('models.preferences.get', null);
      if (!mounted) return;
      await showModalBottomSheet<void>(
        context: context,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
        builder: (sheetContext) => _ModelPickerSheet(prefs: prefs, current: _currentModel, onPick: _setModel),
      );
    } catch (err) {
      setState(() => _error = err.toString());
    }
  }

  Future<void> _setModel(String provider, String modelId, BuildContext sheetContext) async {
    if (_switchingModel) return;
    setState(() => _switchingModel = true);
    try {
      await widget.connection.agentCommand(_sessionId, {'type': 'set_model', 'provider': provider, 'modelId': modelId});
      if (!mounted) return;
      setState(() {
        _currentModel = {'provider': provider, 'modelId': modelId};
        _error = null;
      });
      if (sheetContext.mounted) Navigator.of(sheetContext).pop();
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已切换到 $modelId')));
    } catch (err) {
      final message = err is StateError ? err.message.replaceFirst('Bad state: ', '') : err.toString();
      if (sheetContext.mounted) {
        ScaffoldMessenger.of(sheetContext).showSnackBar(
          SnackBar(content: Text(message), backgroundColor: Colors.red.shade700),
        );
      }
    } finally {
      if (mounted) setState(() => _switchingModel = false);
    }
  }

  void _onEvent(RemoteSessionEvent event) {
    if (event.topic == 'remote.approval') {
      final data = Map<String, dynamic>.from(event.data as Map);
      if ((data['sessionId'] as String?) == _sessionId) {
        setState(() => _approvals.add(data));
      }
      return;
    }
    if (event.topic == 'agent.running') {
      // Turn lifecycle from the PC: refresh running state + queue bar.
      // PC emits a global payload: {type, sessionIds, runningSessionIds}.
      final data = event.data is Map ? event.data as Map : const {};
      final raw = data['runningSessionIds'] ?? data['sessionIds'];
      final ids = raw is List ? raw.map((e) => e.toString()).toSet() : const <String>{};
      final nowRunning = ids.contains(_sessionId);
      if (nowRunning != _turnRunning || nowRunning) {
        setState(() => _turnRunning = nowRunning);
        if (nowRunning) {
          _startQueuePolling();
        } else {
          _stopQueuePolling();
          setState(() {
            _steeringQueue = const [];
            _followUpQueue = const [];
          });
        }
      }
      return;
    }
    if (event.topic != 'agent.events' || event.key != _sessionId) return;
    final data = event.data;
    if (data is! Map) return;
    final type = data['type'] as String?;
    final message = data['message'];
    if (message is! Map) return;
    final role = message['role'] as String?;
    setState(() {
      if (role == 'toolResult') {
        // Tool results pair into their toolCall card (desktop MessageView
        // behavior); unpaired ones become standalone result cards.
        applyToolResult(_lines, _toolIndexByCallId, message);
        _throttledScroll();
        return;
      }
      final text = extractText(message['content']);
      final content = message['content'];
      switch (type) {
        case 'message_start':
          // Text lines are created on first non-empty content; tool calls are
          // upserted from content blocks below.
          break;
        case 'message_update':
          _applyStreamedMessage(role, content, text, done: false);
          break;
        case 'message_end':
          _applyStreamedMessage(role, content, text, done: true);
          break;
        default:
          break;
      }
    });
    _throttledScroll();
  }

  void _applyStreamedMessage(String? role, Object? content, String? text, {required bool done}) {
    var hasContent = false;
    if (content is List) {
      for (final block in content) {
        if (block is! Map) continue;
        if (block['type'] == 'toolCall') {
          hasContent = true;
          upsertToolCard(_lines, _toolIndexByCallId, block);
        } else if (block['type'] == 'thinking') {
          hasContent = true;
          _upsertThinkingLine(role ?? 'assistant', block['thinking'] as String? ?? '', done: done);
        } else if (block['type'] == 'text') {
          final blockText = (block['text'] as String? ?? '').trim();
          if (blockText.isEmpty) continue;
          hasContent = true;
          _upsertTextLine(role ?? 'assistant', blockText, done: done);
        }
      }
    }
    if (!hasContent && text != null && text.trim().isNotEmpty && content is! List) {
      _upsertTextLine(role ?? 'assistant', text.trim(), done: done);
      hasContent = true;
    }
    if (done && role != 'user') {
      for (final line in _lines) {
        if ((line.kind == 'text' || line.kind == 'thinking') && line.role == role) line.done = true;
      }
    }
    if (hasContent && role == 'assistant') _awaitingFirst = false;
    if (role == 'user') _sendingText = null;
  }

  /// 流式 upsert 的行查找：从尾向前找同 role 同 kind 且未完结的行。
  /// 只看 last 会在 thinking/text 交替的消息里每轮 update 追加新行
  /// （同一条回复渲染 2-3 份的根因）。任何 done 行或不同 role 行都是
  /// 消息边界，停止扫描。
  ChatLine? _findOpenLine(String role, String kind) {
    for (var i = _lines.length - 1; i >= 0; i--) {
      final line = _lines[i];
      if (line.done) return null;
      if (line.role != role) return null;
      if (line.kind == kind) return line;
    }
    return null;
  }

  void _upsertThinkingLine(String role, String chunk, {required bool done}) {
    final open = _findOpenLine(role, 'thinking');
    if (open != null) {
      open.text = chunk;
      open.done = done;
    } else {
      _lines.add(ChatLine.thinking(role: role, text: chunk, done: done));
    }
  }

  /// Queue polling (PC parity): only while the turn is running, refresh the
  /// steering/follow-up lists from agentState.queuedMessages.
  void _startQueuePolling() {
    _queuePollTimer?.cancel();
    _pollQueueOnce();
    _queuePollTimer = Timer.periodic(const Duration(seconds: 5), (_) => _pollQueueOnce());
  }

  void _stopQueuePolling() {
    _queuePollTimer?.cancel();
    _queuePollTimer = null;
  }

  Future<void> _pollQueueOnce() async {
    try {
      final state = await widget.connection.request('agent.state', {'sessionId': _sessionId});
      final agentState = state['state'] is Map ? state['state'] as Map : state;
      final queued = agentState['queuedMessages'];
      if (!mounted) return;
      final steeringList = queued is Map ? queued['steering'] : null;
      final followUpList = queued is Map ? queued['followUp'] : null;
      setState(() {
        _steeringQueue = [
          if (steeringList is List)
            for (final s in steeringList)
              if (s != null) s.toString(),
        ];
        _followUpQueue = [
          if (followUpList is List)
            for (final s in followUpList)
              if (s != null) s.toString(),
        ];
      });
    } catch (_) {
      // Transient (host restart etc.); the next tick retries.
    }
  }

  Future<void> _clearQueue() async {
    if (_clearingQueue) return;
    setState(() => _clearingQueue = true);
    try {
      final result = await widget.connection.agentCommand(_sessionId, {'type': 'clear_queue'});
      final steeringList = result['steering'];
      final followUpList = result['followUp'];
      if (!mounted) return;
      setState(() {
        _steeringQueue = [
          if (steeringList is List)
            for (final s in steeringList)
              if (s != null) s.toString(),
        ];
        _followUpQueue = [
          if (followUpList is List)
            for (final s in followUpList)
              if (s != null) s.toString(),
        ];
        _clearingQueue = false;
      });
    } catch (err) {
      if (mounted) {
        setState(() {
          _error = err.toString();
          _clearingQueue = false;
        });
      }
    }
  }

  /// "/" 命令面板：首字符输入 "/" 时展示内置命令 + PC 端技能列表。
  void _onPromptChanged(String text) {
    if (text.startsWith('/')) {
      if (!_slashOpen) {
        _slashOpen = true;
        if (!_slashSkillsLoaded) {
          _slashSkillsLoaded = true;
          widget.connection
              .request('skills.list', null)
              .then((result) {
                final skills = result['skills'];
                if (skills is! List) return;
                setState(() {
                  _slashItems = [
                    ..._slashItems,
                    for (final s in skills)
                      if (s is Map)
                        {
                          'name': (s['name'] as String? ?? '').replaceFirst('/', ''),
                          'desc': s['description'] as String? ?? '',
                          'source': '技能',
                        },
                  ];
                });
              })
              .catchError((Object err) {
                // Skill catalog unavailable — builtin commands still work.
              });
        }
      }
      setState(() {});
    } else if (_slashOpen) {
      setState(() => _slashOpen = false);
    }
  }

  List<Map<String, String>> _filteredSlashItems() {
    final query = _promptController.text.startsWith('/')
        ? _promptController.text.substring(1).trim().toLowerCase()
        : '';
    if (query.isEmpty) return _slashItems;
    return _slashItems
        .where((item) =>
            item['name']!.toLowerCase().contains(query) || item['desc']!.toLowerCase().contains(query))
        .toList();
  }

  void _applySlashCommand(String name) {
    _promptController.text = '/$name ';
    _promptController.selection = TextSelection.fromPosition(
      TextPosition(offset: _promptController.text.length),
    );
    setState(() => _slashOpen = false);
  }

  void _upsertTextLine(String role, String blockText, {required bool done}) {
    final open = _findOpenLine(role, 'text');
    if (open != null) {
      open.text = blockText;
      open.done = done;
    } else {
      _lines.add(ChatLine.text(role: role, text: blockText, done: done));
    }
  }

  void _throttledScroll() {
    if (_pendingRender) return;
    _pendingRender = true;
    _renderThrottle = Timer(const Duration(milliseconds: 50), () {
      _pendingRender = false;
      if (_scrollController.hasClients) {
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      }
    });
  }

  Future<void> _respondApproval(Map<String, dynamic> approval, bool confirmed) async {
    final requestId = approval['requestId'] as String?;
    if (requestId == null) return;
    try {
      await widget.connection.agentCommand(_sessionId, {
        'type': 'extension_ui_response',
        'id': requestId,
        'response': {'confirmed': confirmed},
      });
      setState(() => _approvals.remove(approval));
    } catch (err) {
      setState(() => _error = err.toString());
    }
  }

  Future<void> _send() async {
    final text = _promptController.text.trim();
    if (text.isEmpty) return;
    // Optimistic feedback immediately (the stream mirrors the user message
    // back later; until then this pending bubble + loading row show).
    setState(() {
      _sendingText = text;
      _awaitingFirst = true;
    });
    _promptController.clear();
    _throttledScroll();
    try {
      // PC parity: while a turn is running, Enter steers (queued into the
      // current turn); when idle the message starts a fresh turn.
      final type = _turnRunning ? 'steer' : 'prompt';
      await widget.connection.agentCommand(_sessionId, {'type': type, 'message': text});
    } catch (err) {
      setState(() {
        _sendingText = null;
        _awaitingFirst = false;
        _error = err.toString();
      });
    }
  }

  Future<void> _abort() async {
    try {
      await widget.connection.agentCommand(_sessionId, {'type': 'abort'});
      setState(() => _lines.add(ChatLine.text(role: 'system', text: '— 已发送中止 —', done: true)));
    } catch (err) {
      setState(() => _error = err.toString());
    }
  }

  @override
  void dispose() {
    _renderThrottle?.cancel();
    _stopQueuePolling();
    _events?.cancel();
    widget.connection.unsubscribe('agent.events', _sessionId);
    widget.connection.unsubscribe('agent.running', _sessionId);
    _promptController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Widget _buildLine(BuildContext context, ChatLine line) {
    if (line.kind == 'tool') {
      final callId = line.toolCallId ?? '';
      return _ToolCard(
        line: line,
        expanded: _expandedTools.contains(callId),
        onToggle: () => setState(() {
          if (!_expandedTools.remove(callId)) _expandedTools.add(callId);
        }),
      );
    }
    if (line.kind == 'thinking') {
      final thinkingId = 'think-${_lines.indexOf(line)}';
      return _ThinkingCard(
        line: line,
        expanded: _expandedThinking.contains(thinkingId),
        onToggle: () => setState(() {
          if (!_expandedThinking.remove(thinkingId)) _expandedThinking.add(thinkingId);
        }),
      );
    }
    final isUser = line.role == 'user';
    final baseStyle = TextStyle(
      fontSize: 13,
      height: 1.35,
      fontStyle: line.done ? FontStyle.normal : FontStyle.italic,
      color: Colors.black87,
    );
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        constraints: BoxConstraints(maxWidth: isUser ? 320 : 340),
        decoration: BoxDecoration(
          color: isUser ? Theme.of(context).colorScheme.primaryContainer : Colors.white,
          borderRadius: BorderRadius.circular(10),
        ),
        child: isUser
            ? Text(line.text.isEmpty && !line.done ? '…' : line.text, style: baseStyle)
            : MarkdownText(data: line.text.isEmpty && !line.done ? '…' : line.text, baseStyle: baseStyle),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ready = widget.connection.isReady;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title, overflow: TextOverflow.ellipsis),
        actions: [
          _ModelChip(
            model: _currentModel,
            busy: _switchingModel,
            onTap: _pickModel,
          ),
          IconButton(
            tooltip: '中止当前回合',
            onPressed: _abort,
            icon: const Icon(Icons.stop_circle_outlined),
          ),
        ],
      ),
      body: Column(
        children: [
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              child: Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
            ),
          for (final approval in _approvals)
            _ApprovalCard(approval: approval, onRespond: _respondApproval),
          if (_turnRunning && (_steeringQueue.isNotEmpty || _followUpQueue.isNotEmpty))
            _QueueBar(
              steering: _steeringQueue,
              followUp: _followUpQueue,
              clearing: _clearingQueue,
              onClear: _clearQueue,
            ),
          if (_slashOpen)
            Container(
              margin: const EdgeInsets.fromLTRB(12, 4, 12, 0),
              constraints: const BoxConstraints(maxHeight: 220),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Colors.black12),
              ),
              child: ListView(
                shrinkWrap: true,
                padding: EdgeInsets.zero,
                children: [
                  for (final item in _filteredSlashItems())
                    ListTile(
                      dense: true,
                      leading: Icon(
                        item['source'] == '技能' ? Icons.extension : Icons.build_circle_outlined,
                        size: 16,
                        color: Colors.black45,
                      ),
                      title: Text('/${item['name']}',
                          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, fontFamily: 'monospace')),
                      subtitle: Text(item['desc'] ?? '',
                          maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11)),
                      onTap: () => _applySlashCommand(item['name']!),
                    ),
                  if (_filteredSlashItems().isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(14),
                      child: Text('没有匹配的命令', style: TextStyle(fontSize: 12, color: Colors.black38)),
                    ),
                ],
              ),
            ),
          Expanded(
            child: (_lines.isEmpty && _sendingText == null && !_awaitingFirst)
                ? const Center(
                    child: Text('向 PC 上的 agent 发送第一条指令…', style: TextStyle(color: Colors.black38)),
                  )
                : ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    itemCount:
                        _lines.length + (_sendingText != null ? 1 : 0) + (_awaitingFirst ? 1 : 0),
                    itemBuilder: (context, index) {
                      if (index < _lines.length) {
                        return _buildLine(context, _lines[index]);
                      }
                      final pendingIndex = index - _lines.length;
                      if (_sendingText != null && pendingIndex == 0) {
                        return Align(
                          alignment: Alignment.centerRight,
                          child: Container(
                            margin: const EdgeInsets.symmetric(vertical: 4),
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                            constraints: const BoxConstraints(maxWidth: 320),
                            decoration: BoxDecoration(
                              color: Theme.of(context).colorScheme.primaryContainer,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: Text(_sendingText!, style: const TextStyle(fontSize: 13, height: 1.35)),
                          ),
                        );
                      }
                      return Align(
                        alignment: Alignment.centerLeft,
                        child: Container(
                          margin: const EdgeInsets.symmetric(vertical: 4),
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const SizedBox(
                                width: 13,
                                height: 13,
                                child: CircularProgressIndicator(strokeWidth: 1.8),
                              ),
                              const SizedBox(width: 8),
                              Text(
                                '正在回复…',
                                style: const TextStyle(fontSize: 12, color: Colors.black45, fontStyle: FontStyle.italic),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _promptController,
                      enabled: ready,
                      onChanged: _onPromptChanged,
                      onSubmitted: (_) => _send(),
                      decoration: InputDecoration(
                        hintText: _turnRunning ? '回合进行中，发送将插队…' : '发送指令到 PC 会话…（/ 唤起命令）',
                        border: OutlineInputBorder(
                          borderSide: BorderSide(
                            color: _turnRunning ? const Color(0xFFEAB836) : Colors.black12,
                            width: _turnRunning ? 1.4 : 1,
                          ),
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderSide: BorderSide(
                            color: _turnRunning ? const Color(0xFFEAB836) : Colors.black12,
                            width: _turnRunning ? 1.4 : 1,
                          ),
                        ),
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: _send,
                    icon: const Icon(Icons.send),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Collapsible thinking card (desktop-aligned): shows the model's reasoning
/// dimmed and collapsed by default, expandable to the full text.
/// Queued steering / follow-up messages bar (PC ChatInput parity): shows
/// what is queued while a turn is running, with a clear-all action.
class _QueueBar extends StatelessWidget {
  final List<String> steering;
  final List<String> followUp;
  final bool clearing;
  final VoidCallback onClear;

  const _QueueBar({
    required this.steering,
    required this.followUp,
    required this.clearing,
    required this.onClear,
  });

  @override
  Widget build(BuildContext context) {
    final total = steering.length + followUp.length;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 0),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF8E1),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFFEAB836)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 8, 6, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.bolt, size: 14, color: Color(0xFFB8860B)),
                const SizedBox(width: 5),
                Text(
                  '已排队 $total 条（回合中送达）',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                    color: Color(0xFF8D6E00),
                  ),
                ),
                const Spacer(),
                TextButton(
                  style: TextButton.styleFrom(
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                  ),
                  onPressed: clearing ? null : onClear,
                  child: clearing
                      ? const SizedBox(
                          width: 12,
                          height: 12,
                          child: CircularProgressIndicator(strokeWidth: 1.6),
                        )
                      : const Text('清空', style: TextStyle(fontSize: 12, color: Color(0xFFB8860B))),
                ),
              ],
            ),
            for (final text in steering)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  '⚡ 插队：$text',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, color: Color(0xFF8D6E00)),
                ),
              ),
            for (final text in followUp)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  '⏭ 排队：$text',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, color: Colors.black54),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ThinkingCard extends StatelessWidget {
  final ChatLine line;
  final bool expanded;
  final VoidCallback onToggle;

  const _ThinkingCard({required this.line, required this.expanded, required this.onToggle});

  @override
  Widget build(BuildContext context) {
    final preview = line.text.length > 80 ? '${line.text.substring(0, 80)}…' : line.text;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.7),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: onToggle,
            borderRadius: BorderRadius.circular(10),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              child: Row(
                children: [
                  Icon(Icons.psychology_outlined, size: 15, color: Colors.black45),
                  const SizedBox(width: 6),
                  Text('思考过程', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Colors.black54)),
                  const SizedBox(width: 6),
                  if (!expanded)
                    Expanded(
                      child: Text(
                        preview,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 11, fontStyle: FontStyle.italic, color: Colors.black45),
                      ),
                    )
                  else
                    const Spacer(),
                  AnimatedRotation(
                    turns: expanded ? 0 : -0.25,
                    duration: const Duration(milliseconds: 140),
                    child: const Icon(Icons.expand_more, size: 16, color: Colors.black38),
                  ),
                ],
              ),
            ),
          ),
          if (expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
              child: Text(
                line.text,
                style: const TextStyle(fontSize: 11.5, height: 1.4, fontStyle: FontStyle.italic, color: Colors.black54),
              ),
            ),
        ],
      ),
    );
  }
}

/// Collapsible tool card mirroring the desktop ToolCallBlock: header with a
/// display label + input preview, running/error state, expandable full input
/// JSON and paired result text.
class _ToolCard extends StatelessWidget {
  final ChatLine line;
  final bool expanded;
  final VoidCallback onToggle;

  const _ToolCard({required this.line, required this.expanded, required this.onToggle});

  IconData get _icon {
    final name = (line.toolName ?? '').toLowerCase();
    if (name == 'bash' || name == 'powershell' || name.contains('command')) return Icons.terminal;
    if (name == 'read') return Icons.description_outlined;
    if (name == 'write' || name == 'edit' || name == 'multiedit') return Icons.edit_outlined;
    if (name.startsWith('browser')) return Icons.language;
    if (name.contains('search') || name.contains('fetch')) return Icons.travel_explore;
    return Icons.build_outlined;
  }

  @override
  Widget build(BuildContext context) {
    final label = toolDisplayName(line.toolName ?? 'tool');
    final hasBody = (line.inputJson?.isNotEmpty ?? false) || (line.resultText?.isNotEmpty ?? false);
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(10),
        border: line.resultIsError ? Border.all(color: Colors.red.shade300) : null,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: hasBody ? onToggle : null,
            borderRadius: BorderRadius.circular(10),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                children: [
                  Icon(_icon, size: 15, color: Colors.black54),
                  const SizedBox(width: 6),
                  Text(label, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      line.preview ?? '',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, color: Colors.black54, fontFamily: 'monospace'),
                    ),
                  ),
                  if (line.running)
                    const SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(strokeWidth: 1.6),
                    )
                  else
                    AnimatedRotation(
                      turns: expanded ? 0 : -0.25,
                      duration: const Duration(milliseconds: 140),
                      child: Icon(hasBody ? Icons.expand_more : Icons.remove, size: 16, color: Colors.black38),
                    ),
                ],
              ),
            ),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 160),
            curve: Curves.easeOutCubic,
            alignment: Alignment.topCenter,
            child: expanded && hasBody
                ? Container(
                    width: double.infinity,
                    padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (line.inputJson?.isNotEmpty ?? false)
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(6),
                            decoration: BoxDecoration(
                              color: Colors.black.withValues(alpha: 0.04),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              line.inputJson!,
                              style: const TextStyle(fontSize: 10, fontFamily: 'monospace', color: Colors.black87),
                            ),
                          ),
                        if (line.resultText?.isNotEmpty ?? false) ...[
                          Padding(
                            padding: const EdgeInsets.only(top: 6, bottom: 2),
                            child: Text(
                              line.resultIsError ? '结果（出错）' : '结果',
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.bold,
                                color: line.resultIsError ? Colors.red.shade700 : Colors.black45,
                              ),
                            ),
                          ),
                          Text(
                            line.resultText!,
                            maxLines: 14,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 10.5, fontFamily: 'monospace', color: Colors.black87),
                          ),
                        ],
                      ],
                    ),
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}

/// Compact current-model chip shown in the AppBar; opens the picker sheet.
class _ModelChip extends StatelessWidget {
  final Map<String, String>? model;
  final bool busy;
  final VoidCallback onTap;

  const _ModelChip({required this.model, required this.busy, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final label = busy ? '切换中…' : (model?['modelId'] ?? '选择模型');
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(20),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(20),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 140),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                ),
              ),
              const SizedBox(width: 2),
              const Icon(Icons.expand_more, size: 16),
            ],
          ),
        ),
      ),
    );
  }
}

/// Bottom-sheet model picker backed by models.preferences.get. Filters to the
/// models the user enabled on the desktop (enabledModels), marks the current
/// selection and the PC-side default.
class _ModelPickerSheet extends StatelessWidget {
  final Map<String, dynamic> prefs;
  final Map<String, String>? current;
  final Future<void> Function(String provider, String modelId, BuildContext) onPick;

  const _ModelPickerSheet({required this.prefs, required this.current, required this.onPick});

  List<Map<String, dynamic>> _models() {
    final raw = prefs['models'];
    final all = <Map<String, dynamic>>[
      if (raw is List)
        for (final m in raw)
          if (m is Map) Map<String, dynamic>.from(m),
    ];
    final enabled = prefs['enabledModels'];
    if (enabled is List && enabled.isNotEmpty) {
      final keys = enabled.map((e) => e.toString()).toSet();
      final filtered = all.where((m) => keys.contains('${m['provider']}/${m['id']}')).toList();
      if (filtered.isNotEmpty) return filtered;
    }
    return all;
  }

  @override
  Widget build(BuildContext context) {
    final models = _models();
    final defaultModel = prefs['defaultModel'];
    bool isDefault(Map<String, dynamic>? m) {
      if (m == null || defaultModel is! Map) return false;
      return defaultModel['provider'] == m['provider'] && defaultModel['modelId'] == m['modelId'];
    }

    bool isCurrent(Map<String, dynamic> m) =>
        current?['provider'] == m['provider'] && current?['modelId'] == m['id'];
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
              child: Row(
                children: [
                  const Text('选择模型', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  const Spacer(),
                  IconButton(icon: const Icon(Icons.close, size: 20), onPressed: () => Navigator.of(context).pop()),
                ],
              ),
            ),
            const Divider(height: 1),
            Flexible(
              child: models.isEmpty
                  ? const Padding(
                      padding: EdgeInsets.all(24),
                      child: Center(child: Text('没有可用模型', style: TextStyle(color: Colors.black38))),
                    )
                  : ListView.builder(
                      shrinkWrap: true,
                      itemCount: models.length,
                      itemBuilder: (context, index) {
                        final m = models[index];
                        final currentHere = isCurrent(m);
                        return ListTile(
                          dense: true,
                          title: Text(
                            m['name'] as String? ?? m['id'] as String? ?? '',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 14,
                              fontWeight: currentHere ? FontWeight.bold : FontWeight.w500,
                            ),
                          ),
                          subtitle: Text(
                            '${m['provider']}/${m['id']}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 11, color: Colors.black45),
                          ),
                          trailing: currentHere
                              ? Icon(Icons.check_circle, size: 20, color: Theme.of(context).colorScheme.primary)
                              : isDefault(m)
                                  ? Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                      decoration: BoxDecoration(
                                        color: Colors.green.shade50,
                                        borderRadius: BorderRadius.circular(10),
                                      ),
                                      child: Text('默认', style: TextStyle(fontSize: 11, color: Colors.green.shade700)),
                                    )
                                  : null,
                          onTap: currentHere
                              ? null
                              : () => onPick(m['provider'] as String, m['id'] as String, context),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ApprovalCard extends StatelessWidget {
  const _ApprovalCard({required this.approval, required this.onRespond});

  final Map<String, dynamic> approval;
  final Future<void> Function(Map<String, dynamic>, bool) onRespond;

  @override
  Widget build(BuildContext context) {
    final hasExpiry = approval['expiresAt'] != null;
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      color: Theme.of(context).colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '待审批：${approval['method'] ?? 'confirm'}',
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 4),
            Text(approval['title']?.toString() ?? '', style: const TextStyle(fontSize: 13)),
            if (hasExpiry)
              const Text('此审批在桌面端有超时，到点将自动拒绝。', style: TextStyle(fontSize: 11)),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: () => onRespond(approval, false),
                  child: const Text('拒绝'),
                ),
                FilledButton(
                  onPressed: () => onRespond(approval, true),
                  child: const Text('批准'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
