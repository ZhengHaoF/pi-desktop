/// Workspace root shell: 3 bottom tabs (`任务` / `文件` / `我的`) plus a
/// WorkBuddy-style left drawer for multi-PC host switching, recent tasks, and
/// collapsible per-project session lists.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/app_theme.dart';
import '../core/host_store.dart';
import '../core/remote_connection.dart';
import '../widgets/model_picker_sheet.dart';
import '../widgets/session_models.dart';
import '../widgets/text_selection_menu.dart';
import '../widgets/ui_kit.dart';
import '../widgets/workspace_drawer.dart';
import 'chat_page.dart';
import 'connect_page.dart';
import 'files_page.dart';
import 'settings_page.dart';

class HomePage extends StatefulWidget {
  const HomePage({required this.connection, super.key});

  final RemoteConnection connection;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();

  int _tabIndex = 0;
  List<SessionSummary> _sessions = [];
  List<String> _runningIds = [];
  bool _loading = true;
  String? _error;

  String? _activeSessionId;
  String? _draftProjectRoot;
  Map<String, String>? _draftModel;
  int _draftNonce = 0;
  bool _restoredActiveSession = false;

  final Set<String> _expanded = {};
  bool _defaultsApplied = false;
  List<RemoteHostInfo> _hosts = const [];
  RemoteHostInfo? _currentHost;

  /// 已配对（本机持有该电脑凭证）的 hostId 集合。
  Set<String> _pairedHostIds = const {};
  StreamSubscription<LinkState>? _stateSub;

  @override
  void initState() {
    super.initState();
    _restoreHostSelection();
    _stateSub = widget.connection.onState.listen((state) {
      if (state != LinkState.ready || !mounted) return;
      setState(() => _error = null);
      _syncHostState();
      unawaited(_refresh());
    });
    _refresh();
  }

  @override
  void dispose() {
    _stateSub?.cancel();
    super.dispose();
  }

  String get _hostDisplayName =>
      _currentHost?.displayName ?? widget.connection.hostId ?? '我的电脑';

  void _openDrawer() {
    _scaffoldKey.currentState?.openDrawer();
  }

  /// 列表与本次配对绑定：凭证被拒或解除绑定后，屏幕上的会话属于上一段
  /// 关系，既不能继续展示，也不该留在磁盘上等下次冷启动再冒出来。
  void _discardSessions({String? hostId}) {
    final id = hostId ?? widget.connection.hostId;
    if (id != null) {
      unawaited(deleteCachedSessions(id));
      unawaited(deleteLastActiveSessionId(id));
    }
    if (!mounted) return;
    setState(() {
      _sessions = [];
      _runningIds = [];
      _activeSessionId = null;
      _draftProjectRoot = null;
      _draftModel = null;
      _restoredActiveSession = false;
      _expanded.clear();
      _defaultsApplied = false;
    });
  }

  Future<void> _restoreHostSelection() async {
    final saved = await loadPreferredHost();
    if (saved != null &&
        widget.connection.targetHostId == null &&
        widget.connection.hostId == null) {
      setState(() {
        _hosts = const [];
      });
      await widget.connection.selectHost(saved);
      _refresh();
    }
    final cached = await loadKnownHosts();
    if (mounted && cached.isNotEmpty && _hosts.isEmpty) {
      final currentId = widget.connection.hostId;
      final matched = currentId == null
          ? const <RemoteHostInfo>[]
          : cached.where((h) => h.id == currentId).toList();
      setState(() {
        _hosts = cached;
        if (_currentHost == null && matched.isNotEmpty) {
          _currentHost = matched.first;
        }
      });
    }
    await _reloadPairedHosts();
  }

  Future<void> _reloadPairedHosts() async {
    final ids = await loadPairedHostIds(
      widget.connection.deviceId,
      relayUrl: widget.connection.relayUrl,
    );
    if (mounted) setState(() => _pairedHostIds = ids);
  }

  void _syncHostState() {
    final hosts = widget.connection.knownHosts;
    final currentId = widget.connection.hostId;
    final current = hosts.where((h) => h.id == currentId).toList();
    setState(() {
      if (hosts.isNotEmpty) _hosts = hosts;
      _currentHost = current.isNotEmpty
          ? current.first
          : (_currentHost?.id == currentId ? _currentHost : null);
    });
    if (hosts.isNotEmpty) {
      saveKnownHosts(hosts);
      final id = widget.connection.hostId;
      if (id != null) savePreferredHost(id);
    }
    unawaited(_reloadPairedHosts());
  }

  Future<void> _selectInitialSessionIfNeeded(
    String? hostId,
    List<SessionSummary> sessions,
  ) async {
    if (sessions.isEmpty || _draftProjectRoot != null) return;
    if (_activeSessionId != null &&
        sessions.any((s) => s.id == _activeSessionId)) {
      return;
    }

    String? targetId;
    if (!_restoredActiveSession && hostId != null) {
      _restoredActiveSession = true;
      final lastSaved = await loadLastActiveSessionId(hostId);
      if (lastSaved != null && sessions.any((s) => s.id == lastSaved)) {
        targetId = lastSaved;
      }
    }
    targetId ??= sessions.first.id;
    final chosen = sessions.firstWhere(
      (s) => s.id == targetId,
      orElse: () => sessions.first,
    );

    if (!mounted) return;
    setState(() {
      _activeSessionId = chosen.id;
      _expanded.add(chosen.projectRoot);
    });
  }

  Future<void> _refresh() async {
    final hostId = widget.connection.hostId;
    final terminal = widget.connection.isTerminalFailure;
    if (terminal) {
      _discardSessions(hostId: hostId);
    } else if (hostId != null && _sessions.isEmpty) {
      final cached = await loadCachedSessions(hostId);
      if (mounted && cached.isNotEmpty && _sessions.isEmpty) {
        setState(() {
          _sessions = cached;
          if (!_defaultsApplied) {
            _expanded.add(cached.first.projectRoot);
            _defaultsApplied = true;
          }
        });
        await _selectInitialSessionIfNeeded(hostId, cached);
      }
    }
    if (!mounted) return;
    setState(() {
      _loading = _sessions.isEmpty;
      _error = null;
    });
    try {
      final result = await widget.connection.request('sessions.list', null);
      final raw = result['sessions'];
      final sessions = <SessionSummary>[];
      if (raw is List) {
        for (final item in raw) {
          if (item is Map) {
            sessions.add(
              SessionSummary.fromMap(Map<String, dynamic>.from(item)),
            );
          }
        }
      }
      sessions.sort((a, b) => b.modified.compareTo(a.modified));
      final running = result['runningSessionIds'];
      if (hostId != null) {
        unawaited(saveCachedSessions(hostId, sessions));
      }
      if (!mounted) return;
      setState(() {
        _sessions = sessions;
        _runningIds =
            running is List ? running.map((e) => e.toString()).toList() : [];
        _loading = false;
        _error = null;
        if (_activeSessionId != null &&
            !sessions.any((s) => s.id == _activeSessionId)) {
          _activeSessionId = null;
        }
        if (!_defaultsApplied && sessions.isNotEmpty) {
          _expanded.add(sessions.first.projectRoot);
          _defaultsApplied = true;
        }
        _syncHostState();
      });
      await _selectInitialSessionIfNeeded(hostId, sessions);
    } catch (err) {
      final message = err is StateError
          ? err.message.replaceFirst('Bad state: ', '')
          : err.toString();
      if (widget.connection.isTerminalFailure) {
        _discardSessions(hostId: hostId);
      }
      if (!mounted) return;
      setState(() {
        _error = widget.connection.isTargetHostOffline
            ? null
            : widget.connection.describeLastFailure() ?? message;
        _loading = false;
      });
    }
  }

  void _openChatInShell(SessionSummary session) {
    final hostId = widget.connection.hostId;
    if (hostId != null) {
      unawaited(saveLastActiveSessionId(hostId, session.id));
    }
    setState(() {
      _activeSessionId = session.id;
      _draftProjectRoot = null;
      _draftModel = null;
      _expanded.add(session.projectRoot);
      _tabIndex = 0;
    });
  }

  void _startNewTaskDraft(
    String projectRoot, {
    String? provider,
    String? modelId,
  }) {
    setState(() {
      _activeSessionId = null;
      _draftProjectRoot = projectRoot;
      _draftModel = provider != null && modelId != null
          ? {'provider': provider, 'modelId': modelId}
          : null;
      _draftNonce++;
      _expanded.add(projectRoot);
      _tabIndex = 0;
    });
  }

  Future<void> _rescanPairing() async {
    _discardSessions();
    widget.connection.disconnect();
    if (!mounted) return;
    await Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const ConnectPage()),
      (route) => false,
    );
  }

  Future<void> _renameSession(SessionSummary session, String name) async {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return;
    try {
      await widget.connection
          .request('sessions.rename', {'id': session.id, 'name': trimmed});
      await _refresh();
    } catch (err) {
      if (mounted) setState(() => _error = err.toString());
    }
  }

  Future<void> _deleteSession(SessionSummary session) async {
    try {
      await widget.connection.request('sessions.delete', {'id': session.id});
      final hostId = widget.connection.hostId;
      if (_activeSessionId == session.id) {
        if (hostId != null) unawaited(deleteLastActiveSessionId(hostId));
        if (mounted) {
          setState(() => _activeSessionId = null);
        }
      }
      await _refresh();
    } catch (err) {
      if (mounted) setState(() => _error = err.toString());
    }
  }

  void _confirmDelete(SessionSummary session) {
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('删除会话'),
        content: Text('确定删除「${session.title}」？该操作不可撤销。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade600),
            onPressed: () {
              Navigator.of(dialogContext).pop();
              _deleteSession(session);
            },
            child: const Text('删除'),
          ),
        ],
      ),
    );
  }

  Future<void> _confirmRemoveProject(WorkspaceProjectGroup group) async {
    final projectRoot = group.root;
    final count = group.sessions.length;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('移除项目'),
        content: Text(
          count > 0
              ? '移除「${projectName(projectRoot)}」？其 $count 条会话记录将被删除；磁盘上的代码不受影响。该操作不可撤销。'
              : '从列表中移除「${projectName(projectRoot)}」？',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade600),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('移除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    final targets =
        _sessions.where((s) => s.projectRoot == projectRoot).toList();
    final failures = <String>[];
    for (final session in targets) {
      try {
        await widget.connection
            .request('sessions.delete', {'id': session.id, 'force': true});
        if (_activeSessionId == session.id) {
          _activeSessionId = null;
        }
      } catch (err) {
        failures.add(
          err is StateError
              ? err.message.replaceFirst('Bad state: ', '')
              : err.toString(),
        );
      }
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          failures.isEmpty
              ? '已移除「${projectName(projectRoot)}」'
              : '部分会话记录删除失败：${failures.first}${failures.length > 1 ? '（等 ${failures.length} 条）' : ''}',
        ),
      ),
    );
    await _refresh();
  }

  void _renameDialog(SessionSummary session) {
    final controller = TextEditingController(text: session.name ?? '');
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('重命名会话'),
        content: TextField(
          controller: controller,
          autofocus: true,
          contextMenuBuilder: buildChineseTextSelectionMenu,
          decoration: const InputDecoration(
            hintText: '输入新名称',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(dialogContext).pop();
              _renameSession(session, controller.text);
            },
            child: const Text('重命名'),
          ),
        ],
      ),
    );
  }

  Future<void> _pickModelAndCreate(String projectRoot) async {
    if (!widget.connection.isReady) {
      _startNewTaskDraft(projectRoot);
      return;
    }
    try {
      final prefs =
          await widget.connection.request('models.preferences.get', null);
      if (!mounted) return;
      await showModalBottomSheet<void>(
        context: context,
        builder: (sheetContext) => ModelPickerSheet(
          title: '新建任务 · ${projectName(projectRoot)}',
          prefs: prefs,
          onPickDefault: () {
            Navigator.of(sheetContext).pop();
            _startNewTaskDraft(projectRoot);
          },
          onPick: (provider, modelId, ctx) async {
            Navigator.of(ctx).pop();
            _startNewTaskDraft(
              projectRoot,
              provider: provider,
              modelId: modelId,
            );
          },
        ),
      );
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('拉取模型失败，已使用默认模型：$err')),
        );
        _startNewTaskDraft(projectRoot);
      }
    }
  }

  Future<void> _pickProjectAndCreate(List<WorkspaceProjectGroup> groups) async {
    if (groups.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('请先在电脑端至少打开过一个项目')),
        );
      }
      return;
    }
    if (groups.length == 1) {
      await _pickModelAndCreate(groups.first.root);
      return;
    }
    final activeRoot = _activeProjectRoot(groups);
    final chosen = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: Text(
                '选择项目空间新建任务',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final group in groups)
                    ListTile(
                      leading: Icon(
                        Icons.folder_outlined,
                        color: group.root == activeRoot
                            ? AppColors.brand
                            : AppColors.textSecondary,
                      ),
                      title: Text(
                        projectName(group.root),
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                      subtitle: Text(
                        group.root,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: group.root == activeRoot
                          ? const Icon(Icons.check_rounded, color: AppColors.brand)
                          : null,
                      onTap: () => Navigator.of(ctx).pop(group.root),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    if (chosen != null && mounted) {
      await _pickModelAndCreate(chosen);
    }
  }

  List<WorkspaceProjectGroup> _buildProjectGroups() {
    final grouped = groupByProject(_sessions);
    final roots = grouped.keys.toList()
      ..sort((a, b) => grouped[b]!.first.modified.compareTo(grouped[a]!.first.modified));
    return [
      for (final root in roots)
        WorkspaceProjectGroup(
          root: root,
          sessions: grouped[root]!,
          latest: grouped[root]!.first.modified,
        ),
    ];
  }

  SessionSummary? get _activeSession {
    final id = _activeSessionId;
    if (id == null) return null;
    for (final s in _sessions) {
      if (s.id == id) return s;
    }
    return null;
  }

  String? _activeProjectRoot(List<WorkspaceProjectGroup> groups) {
    final active = _activeSession;
    if (active != null) return active.projectRoot;
    if (_draftProjectRoot != null) return _draftProjectRoot;
    if (groups.isNotEmpty) return groups.first.root;
    return null;
  }

  List<RemoteHostInfo> _mergedHosts() {
    final hosts = [
      ...widget.connection.knownHosts,
      ..._hosts.where(
        (h) => !widget.connection.knownHosts.any((k) => k.id == h.id),
      ),
    ];
    hosts.sort((a, b) {
      if (a.online != b.online) return a.online ? -1 : 1;
      return a.id.compareTo(b.id);
    });
    return hosts;
  }

  /// 多 PC：设备选择器 sheet（在线优先，离线带上次在线时间）。
  Future<void> _openHostSelector() async {
    widget.connection.refreshHosts();
    await _reloadPairedHosts();
    if (!mounted) return;
    final currentId = widget.connection.hostId;
    final hosts = _mergedHosts();
    showModalBottomSheet<void>(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (sheetContext) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.55,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
                child: Row(
                  children: [
                    const Text(
                      '选择电脑',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                    ),
                    const Spacer(),
                    IconButton(
                      icon: const Icon(Icons.refresh, size: 20),
                      onPressed: () {
                        widget.connection.refreshHosts();
                        Future.delayed(const Duration(milliseconds: 600), () {
                          if (sheetContext.mounted) {
                            Navigator.of(sheetContext).pop();
                            unawaited(_openHostSelector());
                          }
                        });
                      },
                      tooltip: '刷新',
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              Flexible(
                child: hosts.isEmpty
                    ? const Padding(
                        padding: EdgeInsets.all(24),
                        child: Center(
                          child: Text(
                            '暂无已知电脑',
                            style: TextStyle(color: Colors.black38),
                          ),
                        ),
                      )
                    : ListView(
                        shrinkWrap: true,
                        children: [
                          for (final host in hosts)
                            ListTile(
                              dense: true,
                              leading: Icon(
                                host.online
                                    ? Icons.computer
                                    : Icons.computer_outlined,
                                color: host.online
                                    ? Colors.green.shade600
                                    : Colors.black26,
                              ),
                              title: Text(
                                host.displayName,
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: host.id == currentId
                                      ? FontWeight.bold
                                      : FontWeight.w500,
                                ),
                              ),
                              subtitle: Text(
                                '${host.online ? '在线' : (host.lastSeenAt != null ? '离线 · 上次在线 ${relativeTime(DateTime.fromMillisecondsSinceEpoch(host.lastSeenAt!))}' : '离线')}'
                                '${_pairedHostIds.contains(host.id) ? '' : ' · 未配对'}',
                                style: TextStyle(
                                  fontSize: 11,
                                  color: host.online
                                      ? Colors.green.shade700
                                      : Colors.black38,
                                ),
                              ),
                              trailing: host.id == currentId
                                  ? Icon(
                                      Icons.check_circle,
                                      size: 20,
                                      color:
                                          Theme.of(context).colorScheme.primary,
                                    )
                                  : const Icon(
                                      Icons.chevron_right,
                                      size: 18,
                                      color: Colors.black26,
                                    ),
                              onLongPress: () =>
                                  _confirmDeleteHost(host, sheetContext),
                              onTap: host.id == currentId
                                  ? null
                                  : () async {
                                      if (!_pairedHostIds.contains(host.id)) {
                                        Navigator.of(sheetContext).pop();
                                        if (mounted) {
                                          ScaffoldMessenger.of(context)
                                              .showSnackBar(
                                            const SnackBar(
                                              content:
                                                  Text('这台电脑尚未配对，请先在连接页扫码配对'),
                                            ),
                                          );
                                        }
                                        return;
                                      }
                                      Navigator.of(sheetContext).pop();
                                      setState(() {
                                        _loading = true;
                                        _sessions = [];
                                        _runningIds = [];
                                        _activeSessionId = null;
                                        _draftProjectRoot = null;
                                        _draftModel = null;
                                        _restoredActiveSession = false;
                                        _error = null;
                                        _expanded.clear();
                                        _defaultsApplied = false;
                                      });
                                      await widget.connection
                                          .selectHost(host.id);
                                      _refresh();
                                    },
                            ),
                        ],
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _confirmDeleteHost(
    RemoteHostInfo host,
    BuildContext sheetContext,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('删除电脑'),
        content: Text(
          '确定删除「${host.displayName}」？\n\n删除后，需要重新扫码才能再次连接。'
          '${host.id == widget.connection.hostId ? '\n\n这台电脑当前正在连接，删除后会断开。' : ''}',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade600),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final wasCurrent = host.id == widget.connection.hostId;
    widget.connection.unbindHost(host.id);
    await deleteDeviceSecret(
      widget.connection.deviceId,
      relayUrl: widget.connection.relayUrl,
      hostId: host.id,
    );
    await deleteCachedSessions(host.id);
    await deleteLastActiveSessionId(host.id);
    if (wasCurrent && mounted) {
      setState(() {
        _sessions = [];
        _runningIds = [];
        _activeSessionId = null;
        _draftProjectRoot = null;
        _expanded.clear();
        _defaultsApplied = false;
      });
    }
    await _reloadPairedHosts();
    if (wasCurrent) widget.connection.disconnect();
    if (sheetContext.mounted) Navigator.of(sheetContext).pop();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已删除，需要重新扫码才能再次连接')),
      );
    }
  }

  Widget? _buildOfflineBanner() {
    if (widget.connection.lastFailureWasPairingReject) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
        child: ErrorBanner(
          message: '设备配对已失效，请重新扫码配对',
          action: TextButton(
            onPressed: _rescanPairing,
            child: const Text('重新扫码'),
          ),
        ),
      );
    }
    if (widget.connection.isTargetHostOffline) {
      return Container(
        margin: const EdgeInsets.fromLTRB(12, 4, 12, 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.border),
          boxShadow: const [
            BoxShadow(
              color: Color(0x0A000000),
              blurRadius: 8,
              offset: Offset(0, 2),
            ),
          ],
        ),
        child: Row(
          children: [
            const Icon(
              Icons.error_rounded,
              size: 20,
              color: AppColors.warning,
            ),
            const SizedBox(width: 10),
            const Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '电脑设备已离线',
                    style: TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  Text(
                    '可切换在线电脑或稍后重试',
                    style: TextStyle(
                      fontSize: 11.5,
                      color: AppColors.textMuted,
                    ),
                  ),
                ],
              ),
            ),
            OutlinedButton(
              onPressed: _openHostSelector,
              style: OutlinedButton.styleFrom(
                visualDensity: VisualDensity.compact,
                padding: const EdgeInsets.symmetric(horizontal: 10),
              ),
              child: const Text('切换'),
            ),
            const SizedBox(width: 6),
            FilledButton(
              onPressed: _refresh,
              style: FilledButton.styleFrom(
                visualDensity: VisualDensity.compact,
                padding: const EdgeInsets.symmetric(horizontal: 12),
              ),
              child: const Text('重试'),
            ),
          ],
        ),
      );
    }
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
        child: ErrorBanner(
          message: _error!,
          action: TextButton(
            onPressed: _refresh,
            child: const Text('重试'),
          ),
        ),
      );
    }
    return null;
  }

  Widget _buildTasksTab(List<WorkspaceProjectGroup> groups) {
    final activeSession = _activeSession;
    final activeRoot = _activeProjectRoot(groups);

    if (activeSession != null || _draftProjectRoot != null) {
      final sessionId = activeSession?.id;
      final cwd = sessionId == null ? _draftProjectRoot : null;
      final effectiveRoot = activeSession?.projectRoot ?? _draftProjectRoot ?? '';
      final subtitle = effectiveRoot.isEmpty
          ? _hostDisplayName
          : '$_hostDisplayName · ${projectName(effectiveRoot)}';
      final title =
          activeSession?.title ?? '${projectName(effectiveRoot)} · 新任务';
      final hostId = widget.connection.hostId ?? 'host';

      return ChatPage(
        key: ValueKey(
          'chat-$hostId-${sessionId ?? 'draft-$effectiveRoot-$_draftNonce'}',
        ),
        connection: widget.connection,
        sessionId: sessionId,
        newTaskCwd: cwd,
        newTaskModel: sessionId == null ? _draftModel : null,
        title: title,
        subtitle: subtitle,
        onOpenDrawer: _openDrawer,
        onSubtitleTap: _openDrawer,
        offlineBanner: _buildOfflineBanner(),
        onSessionCreated: (createdId) {
          final id = widget.connection.hostId;
          if (id != null) unawaited(saveLastActiveSessionId(id, createdId));
          if (!mounted) return;
          setState(() {
            _activeSessionId = createdId;
            _draftProjectRoot = null;
          });
          unawaited(_refresh());
        },
        headerActions: [
          if (activeRoot != null)
            IconButton(
              tooltip: '在此项目新建任务',
              icon: const Icon(Icons.maps_ugc_outlined),
              onPressed: () => _pickModelAndCreate(activeRoot),
            ),
          PopupMenuButton<String>(
            tooltip: '更多操作',
            icon: const Icon(Icons.more_horiz_rounded),
            onSelected: (value) async {
              if (value == 'refresh') {
                await _refresh();
              } else if (value == 'rename' && activeSession != null) {
                _renameDialog(activeSession);
              } else if (value == 'copy' && activeSession != null) {
                await Clipboard.setData(ClipboardData(text: activeSession.id));
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('已复制会话 ID')),
                  );
                }
              } else if (value == 'delete' && activeSession != null) {
                _confirmDelete(activeSession);
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'refresh', child: Text('刷新会话列表')),
              if (activeSession != null) ...[
                const PopupMenuItem(value: 'rename', child: Text('重命名')),
                const PopupMenuItem(value: 'copy', child: Text('复制会话 ID')),
                const PopupMenuItem(
                  value: 'delete',
                  child: Text(
                    '删除会话',
                    style: TextStyle(color: AppColors.danger),
                  ),
                ),
              ],
            ],
          ),
        ],
      );
    }

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: '打开工作区侧栏',
          icon: const Icon(Icons.menu_rounded),
          onPressed: _openDrawer,
        ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              '任务',
              style: TextStyle(fontSize: 16.5, fontWeight: FontWeight.w600),
            ),
            Text(
              _hostDisplayName,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 11.5,
                color: AppColors.textMuted,
                fontWeight: FontWeight.w400,
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: '切换电脑',
            icon: const Icon(Icons.devices_rounded),
            onPressed: _openHostSelector,
          ),
          IconButton(
            tooltip: '刷新',
            icon: const Icon(Icons.refresh_rounded),
            onPressed: _refresh,
          ),
        ],
      ),
      body: _loading
          ? const _HomeSkeletonList()
          : _error != null
              ? EmptyStateView(
                  icon: widget.connection.lastFailureWasPairingReject
                      ? Icons.qr_code_2_rounded
                      : Icons.link_off_rounded,
                  iconColor: widget.connection.lastFailureWasPairingReject
                      ? AppColors.warning
                      : AppColors.danger,
                  iconBg: widget.connection.lastFailureWasPairingReject
                      ? AppColors.warningBg
                      : AppColors.dangerBg,
                  title: widget.connection.lastFailureWasPairingReject
                      ? '设备配对已失效'
                      : '连接未就绪',
                  subtitle: _error!,
                  actions: widget.connection.lastFailureWasPairingReject
                      ? [
                          FilledButton.icon(
                            onPressed: _rescanPairing,
                            icon: const Icon(
                              Icons.qr_code_scanner_rounded,
                              size: 18,
                            ),
                            label: const Text('重新扫码配对'),
                          ),
                        ]
                      : [
                          FilledButton(
                            onPressed: _refresh,
                            child: const Text('重试'),
                          ),
                        ],
                )
              : EmptyStateView(
                  icon: widget.connection.isTargetHostOffline
                      ? Icons.computer_outlined
                      : Icons.forum_outlined,
                  iconColor: widget.connection.isTargetHostOffline
                      ? AppColors.textMuted
                      : AppColors.brand,
                  iconBg: widget.connection.isTargetHostOffline
                      ? AppColors.surfaceMuted
                      : AppColors.brandSoft,
                  title: widget.connection.isTargetHostOffline
                      ? '电脑当前离线'
                      : '暂无任务会话',
                  subtitle: widget.connection.isTargetHostOffline
                      ? '电脑上线后会自动同步项目和会话记录，也可点击切换其他在线电脑。'
                      : '在电脑端打开项目或发送一次消息后，点击左上角即可切换所有项目。',
                  actions: widget.connection.isTargetHostOffline
                      ? [
                          OutlinedButton(
                            onPressed: _openHostSelector,
                            child: const Text('切换电脑'),
                          ),
                          FilledButton(
                            onPressed: _refresh,
                            child: const Text('重试'),
                          ),
                        ]
                      : [
                          FilledButton.icon(
                            onPressed: _openDrawer,
                            icon: const Icon(Icons.menu_open_rounded, size: 18),
                            label: const Text('打开项目侧栏'),
                          ),
                        ],
                ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final groups = _buildProjectGroups();
    final projectRoots = [for (final g in groups) g.root];
    final activeRoot = _activeProjectRoot(groups);
    final hosts = _mergedHosts();

    return Scaffold(
      key: _scaffoldKey,
      drawerEdgeDragWidth: 24,
      drawer: WorkspaceDrawer(
        currentHost: _currentHost,
        hostDisplayName: _hostDisplayName,
        linkState: widget.connection.state,
        isReady: widget.connection.isReady,
        isTargetHostOffline: widget.connection.isTargetHostOffline,
        allSessions: _sessions,
        projectGroups: groups,
        runningSessionIds: _runningIds.toSet(),
        activeSessionId: _activeSessionId,
        expandedProjects: _expanded,
        onOpenHostSelector: () {
          Navigator.of(context).pop();
          unawaited(_openHostSelector());
        },
        onRefresh: () {
          unawaited(_refresh());
        },
        onNewTask: () {
          Navigator.of(context).pop();
          unawaited(_pickProjectAndCreate(groups));
        },
        onSelectProjectToggle: (root) {
          setState(() {
            if (!_expanded.remove(root)) _expanded.add(root);
          });
        },
        onSelectSession: (session) {
          Navigator.of(context).pop();
          _openChatInShell(session);
        },
        onNewTaskInProject: (root) {
          Navigator.of(context).pop();
          unawaited(_pickModelAndCreate(root));
        },
        onRenameSession: (session) {
          Navigator.of(context).pop();
          _renameDialog(session);
        },
        onDeleteSession: (session) {
          Navigator.of(context).pop();
          _confirmDelete(session);
        },
        onRemoveProject: (group) {
          Navigator.of(context).pop();
          unawaited(_confirmRemoveProject(group));
        },
      ),
      body: IndexedStack(
        index: _tabIndex,
        children: [
          _buildTasksTab(groups),
          FilesPage(
            connection: widget.connection,
            projectRoots: projectRoots,
            activeRoot: activeRoot,
            onOpenDrawer: _openDrawer,
          ),
          SettingsPage(
            connection: widget.connection,
            embedded: true,
            currentHost: _currentHost,
            hostDisplayName: _hostDisplayName,
            hostCount: hosts.length,
            onSwitchHost: _openHostSelector,
            onScanNewHost: _rescanPairing,
            onOpenDrawer: _openDrawer,
          ),
        ],
      ),
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          color: AppColors.surface,
          border: Border(top: BorderSide(color: AppColors.border)),
        ),
        child: NavigationBar(
          height: 62,
          elevation: 0,
          backgroundColor: AppColors.surface,
          indicatorColor: AppColors.brandSoft,
          selectedIndex: _tabIndex,
          onDestinationSelected: (idx) => setState(() => _tabIndex = idx),
          destinations: const [
            NavigationDestination(
              icon: Icon(Icons.chat_bubble_outline_rounded),
              selectedIcon: Icon(Icons.chat_bubble_rounded, color: AppColors.brand),
              label: '任务',
            ),
            NavigationDestination(
              icon: Icon(Icons.folder_outlined),
              selectedIcon: Icon(Icons.folder_rounded, color: AppColors.brand),
              label: '文件',
            ),
            NavigationDestination(
              icon: Icon(Icons.person_outline_rounded),
              selectedIcon: Icon(Icons.person_rounded, color: AppColors.brand),
              label: '我的',
            ),
          ],
        ),
      ),
    );
  }
}

class _HomeSkeletonList extends StatelessWidget {
  const _HomeSkeletonList();

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(12, 16, 12, 24),
      itemCount: 3,
      itemBuilder: (_, index) => SurfaceCard(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 140,
              height: 14,
              decoration: BoxDecoration(
                color: AppColors.surfaceMuted,
                borderRadius: BorderRadius.circular(6),
              ),
            ),
            const SizedBox(height: 8),
            Container(
              width: 220,
              height: 11,
              decoration: BoxDecoration(
                color: AppColors.surfaceSubtle,
                borderRadius: BorderRadius.circular(5),
              ),
            ),
            const SizedBox(height: 14),
            Container(
              width: double.infinity,
              height: 13,
              decoration: BoxDecoration(
                color: AppColors.surfaceMuted,
                borderRadius: BorderRadius.circular(6),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
