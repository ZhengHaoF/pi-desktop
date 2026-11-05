/// M1a shell: pairing (manual URL entry), live session stream, command bar,
/// abort, and the approval sheet. One screen, no router — the point is to
/// validate the link, not to polish UX.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'core/remote_connection.dart';

void main() {
  runApp(const PiRemoteApp());
}

class PiRemoteApp extends StatelessWidget {
  const PiRemoteApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Pi Remote',
      theme: ThemeData(colorSchemeSeed: const Color(0xFF534AB7), useMaterial3: true),
      home: const ConnectPage(),
    );
  }
}

class ConnectPage extends StatefulWidget {
  const ConnectPage({super.key});

  @override
  State<ConnectPage> createState() => _ConnectPageState();
}

class _ConnectPageState extends State<ConnectPage> {
  final _urlController = TextEditingController(text: 'ws://10.0.2.2:8787/ws');
  final _deviceController = TextEditingController();
  RemoteConnection? _connection;
  LinkState _state = LinkState.disconnected;
  String? _error;

  @override
  void initState() {
    super.initState();
    // The M1a relay does not implement pairing storage yet; the device id is
    // a locally generated stable label. Real pairing lands with M1b.
    _deviceController.text = 'android-${DateTime.now().millisecondsSinceEpoch % 100000}';
  }

  Future<void> _connect() async {
    setState(() {
      _error = null;
      _state = LinkState.connecting;
    });
    final connection = RemoteConnection(
      relayUrl: _urlController.text.trim(),
      deviceId: _deviceController.text.trim(),
      deviceLabel: 'Pi Remote (Android)',
    );
    try {
      await connection.connect();
      setState(() {
        _connection = connection;
        _state = LinkState.ready;
      });
      if (!mounted) return;
      Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => SessionPage(connection: connection)),
      );
    } catch (err) {
      setState(() {
        _state = LinkState.disconnected;
        _error = err.toString();
      });
    }
  }

  @override
  void dispose() {
    _connection?.disconnect();
    _urlController.dispose();
    _deviceController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Pi Remote — 连接')),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _urlController,
              decoration: const InputDecoration(
                labelText: 'Relay 地址',
                hintText: 'ws://192.168.x.x:8787/ws',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _deviceController,
              decoration: const InputDecoration(labelText: '设备标识', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: _state == LinkState.connecting ? null : _connect,
              child: Text(_state == LinkState.connecting ? '连接中…' : '连接'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(_error!, style: const TextStyle(color: Colors.red)),
            ],
            const Spacer(),
            Text(
              'M1a 链路验证版：本地/内网 Relay（诊断模式，无 E2EE）。\n'
              '正式配对、E2EE 与公网 Relay 属于 M1b。',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}

class SessionPage extends StatefulWidget {
  const SessionPage({required this.connection, super.key});

  final RemoteConnection connection;

  @override
  State<SessionPage> createState() => _SessionPageState();
}

class _SessionPageState extends State<SessionPage> {
  final _sessionIdController = TextEditingController();
  final _promptController = TextEditingController();
  final _scrollController = ScrollController();
  final _lines = <_ChatLine>[];
  final _approvals = <Map<String, dynamic>>[];
  String? _sessionId;
  String? _error;
  StreamSubscription<RemoteSessionEvent>? _events;
  Timer? _renderThrottle;
  bool _pendingRender = false;

  @override
  void initState() {
    super.initState();
    _events = widget.connection.onEvent.listen(_onEvent);
  }

  void _onEvent(RemoteSessionEvent event) {
    if (event.topic == 'remote.approval') {
      final data = Map<String, dynamic>.from(event.data as Map);
      setState(() => _approvals.add(data));
      return;
    }
    if (event.topic != 'agent.events' || event.key != _sessionId) return;
    final data = event.data;
    if (data is! Map) return;
    final type = data['type'] as String?;
    final message = data['message'];
    if (message is! Map) return;
    final role = message['role'] as String?;
    final text = _extractText(message['content']);
    setState(() {
      switch (type) {
        case 'message_start':
          _lines.add(_ChatLine(role: role ?? 'assistant', text: text ?? ''));
          break;
        case 'message_update':
          if (_lines.isNotEmpty && _lines.last.role == role) {
            _lines.last.text = text ?? _lines.last.text;
          } else {
            _lines.add(_ChatLine(role: role ?? 'assistant', text: text ?? ''));
          }
          break;
        case 'message_end':
          if (_lines.isNotEmpty && _lines.last.role == role) {
            _lines.last.text = text ?? _lines.last.text;
            _lines.last.done = true;
          }
          break;
        default:
          if (role == 'toolResult') {
            _lines.add(_ChatLine(role: 'tool', text: text ?? '[tool result]', done: true));
          }
      }
    });
    _throttledScroll();
  }

  String? _extractText(Object? content) {
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

  Future<void> _attachSession() async {
    final id = _sessionIdController.text.trim();
    if (id.isEmpty) return;
    try {
      await widget.connection.subscribe('agent.events', id);
      final detail = await widget.connection.request('sessions.get', {'id': id});
      setState(() {
        _sessionId = id;
        _error = null;
        _lines
          ..clear()
          ..addAll(_historyLines(detail));
      });
      _throttledScroll();
    } catch (err) {
      setState(() => _error = err.toString());
    }
  }

  List<_ChatLine> _historyLines(Map<String, dynamic> detail) {
    final lines = <_ChatLine>[];
    final context = detail['context'];
    final messages = context is Map ? context['messages'] : null;
    if (messages is List) {
      for (final message in messages) {
        if (message is! Map) continue;
        final role = message['role'] as String? ?? 'assistant';
        if (role != 'user' && role != 'assistant') continue;
        final text = _extractText(message['content']);
        if (text == null || text.isEmpty) continue;
        lines.add(_ChatLine(role: role, text: text, done: true));
      }
    }
    return lines;
  }

  Future<void> _send() async {
    final text = _promptController.text.trim();
    if (text.isEmpty || _sessionId == null) return;
    try {
      await widget.connection.agentCommand(_sessionId!, {'type': 'prompt', 'message': text});
      setState(() {
        _lines.add(_ChatLine(role: 'user', text: text, done: true));
        _promptController.clear();
      });
      _throttledScroll();
    } catch (err) {
      setState(() => _error = err.toString());
    }
  }

  Future<void> _abort() async {
    if (_sessionId == null) return;
    try {
      await widget.connection.agentCommand(_sessionId!, {'type': 'abort'});
      setState(() => _lines.add(_ChatLine(role: 'system', text: '— 已发送中止 —', done: true)));
    } catch (err) {
      setState(() => _error = err.toString());
    }
  }

  Future<void> _respondApproval(Map<String, dynamic> approval, bool confirmed) async {
    final requestId = approval['requestId'] as String;
    try {
      final command = {
        'type': 'extension_ui_response',
        'id': requestId,
        'response': {'confirmed': confirmed},
      };
      await widget.connection.agentCommand(approval['sessionId'] as String, command);
      setState(() => _approvals.remove(approval));
    } catch (err) {
      setState(() => _error = err.toString());
    }
  }

  @override
  void dispose() {
    _renderThrottle?.cancel();
    _events?.cancel();
    if (_sessionId != null) {
      widget.connection.unsubscribe('agent.events', _sessionId!);
    }
    _sessionIdController.dispose();
    _promptController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ready = widget.connection.isReady;
    return Scaffold(
      appBar: AppBar(
        title: Text(_sessionId == null ? 'Pi Remote — 未绑定会话' : '会话 $_sessionId'),
        actions: [
          IconButton(
            tooltip: '中止当前回合',
            onPressed: _sessionId == null ? null : _abort,
            icon: const Icon(Icons.stop_circle_outlined),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _sessionIdController,
                    decoration: const InputDecoration(
                      labelText: '会话 ID',
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton.tonal(onPressed: _attachSession, child: const Text('绑定')),
              ],
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
            ),
          for (final approval in _approvals)
            _ApprovalCard(approval: approval, onRespond: _respondApproval),
          Expanded(
            child: ListView.builder(
              controller: _scrollController,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              itemCount: _lines.length,
              itemBuilder: (context, index) {
                final line = _lines[index];
                final isUser = line.role == 'user';
                final isTool = line.role == 'tool';
                return Align(
                  alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
                  child: Container(
                    margin: const EdgeInsets.symmetric(vertical: 4),
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    constraints: const BoxConstraints(maxWidth: 320),
                    decoration: BoxDecoration(
                      color: isUser
                          ? Theme.of(context).colorScheme.primaryContainer
                          : isTool
                              ? Theme.of(context).colorScheme.surfaceContainerHighest
                              : Theme.of(context).colorScheme.surfaceContainerLow,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      line.text.isEmpty && !line.done ? '…' : line.text,
                      style: TextStyle(
                        fontSize: 13,
                        fontStyle: line.done || isTool ? FontStyle.normal : FontStyle.italic,
                      ),
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
                      enabled: ready && _sessionId != null,
                      onSubmitted: (_) => _send(),
                      decoration: const InputDecoration(
                        hintText: '发送指令到 PC 会话…',
                        border: OutlineInputBorder(),
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

class _ChatLine {
  String role;
  String text;
  bool done;
  _ChatLine({required this.role, required this.text, this.done = false});
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
