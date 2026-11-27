/// WorkBuddy-style navigation drawer: host switcher, quick search, new-task CTA,
/// recent tasks, and collapsible project workspaces.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/app_theme.dart';
import '../core/remote_connection.dart';
import 'session_models.dart';
import 'ui_kit.dart';

class WorkspaceProjectGroup {
  final String root;
  final List<SessionSummary> sessions;
  final DateTime latest;

  const WorkspaceProjectGroup({
    required this.root,
    required this.sessions,
    required this.latest,
  });
}

class WorkspaceDrawer extends StatefulWidget {
  final RemoteHostInfo? currentHost;
  final String hostDisplayName;
  final LinkState linkState;
  final bool isReady;
  final bool isTargetHostOffline;
  final List<SessionSummary> allSessions;
  final List<WorkspaceProjectGroup> projectGroups;
  final Set<String> runningSessionIds;
  final String? activeSessionId;
  final Set<String> expandedProjects;
  final VoidCallback? onOpenHostSelector;
  final VoidCallback? onRefresh;
  final VoidCallback? onNewTask;
  final ValueChanged<String> onSelectProjectToggle;
  final ValueChanged<SessionSummary> onSelectSession;
  final ValueChanged<String> onNewTaskInProject;
  final ValueChanged<SessionSummary> onRenameSession;
  final ValueChanged<SessionSummary> onDeleteSession;
  final ValueChanged<WorkspaceProjectGroup>? onRemoveProject;

  const WorkspaceDrawer({
    required this.currentHost,
    required this.hostDisplayName,
    required this.linkState,
    required this.isReady,
    required this.isTargetHostOffline,
    required this.allSessions,
    required this.projectGroups,
    required this.runningSessionIds,
    required this.activeSessionId,
    required this.expandedProjects,
    required this.onSelectProjectToggle,
    required this.onSelectSession,
    required this.onNewTaskInProject,
    required this.onRenameSession,
    required this.onDeleteSession,
    this.onOpenHostSelector,
    this.onRefresh,
    this.onNewTask,
    this.onRemoveProject,
    super.key,
  });

  @override
  State<WorkspaceDrawer> createState() => _WorkspaceDrawerState();
}

class _WorkspaceDrawerState extends State<WorkspaceDrawer> {
  bool _showSearch = false;
  bool _recentExpanded = true;
  bool _showMoreRecent = false;
  bool _spacesExpanded = true;
  final TextEditingController _searchController = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  List<SessionSummary> _filterSessions(List<SessionSummary> sessions) {
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) return sessions;
    return sessions
        .where(
          (s) =>
              s.title.toLowerCase().contains(q) ||
              s.projectRoot.toLowerCase().contains(q) ||
              projectName(s.projectRoot).toLowerCase().contains(q) ||
              s.id.toLowerCase().contains(q),
        )
        .toList();
  }

  Future<void> _copyId(String id) async {
    await Clipboard.setData(ClipboardData(text: id));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('已复制会话 ID'),
        duration: Duration(seconds: 2),
      ),
    );
  }

  Widget _buildHostHeader(BuildContext context) {
    final hostOnline =
        widget.currentHost?.online ?? (widget.isReady && !widget.isTargetHostOffline);
    final statusColor = widget.isReady
        ? AppColors.success
        : (hostOnline ? AppColors.warning : AppColors.textMuted);

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
      child: Row(
        children: [
          Expanded(
            child: InkWell(
              onTap: widget.onOpenHostSelector,
              borderRadius: BorderRadius.circular(10),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Stack(
                      clipBehavior: Clip.none,
                      children: [
                        const Icon(
                          Icons.computer_rounded,
                          size: 20,
                          color: AppColors.textPrimary,
                        ),
                        Positioned(
                          right: -2,
                          top: -2,
                          child: Container(
                            width: 8,
                            height: 8,
                            decoration: BoxDecoration(
                              color: statusColor,
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: AppColors.surface,
                                width: 1.5,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Text(
                        widget.hostDisplayName,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w700,
                          color: AppColors.textPrimary,
                        ),
                      ),
                    ),
                    if (widget.onOpenHostSelector != null) ...[
                      const SizedBox(width: 2),
                      const Icon(
                        Icons.keyboard_arrow_down_rounded,
                        size: 20,
                        color: AppColors.textSecondary,
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
          IconButton(
            tooltip: _showSearch ? '收起搜索' : '搜索项目或会话',
            onPressed: () {
              setState(() {
                _showSearch = !_showSearch;
                if (!_showSearch) {
                  _searchController.clear();
                  _query = '';
                }
              });
            },
            icon: Icon(
              _showSearch ? Icons.close_rounded : Icons.search_rounded,
              size: 20,
              color: AppColors.textSecondary,
            ),
          ),
          if (widget.onRefresh != null)
            IconButton(
              tooltip: '刷新会话列表',
              onPressed: widget.onRefresh,
              icon: const Icon(
                Icons.refresh_rounded,
                size: 20,
                color: AppColors.textSecondary,
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildSearchBar() {
    if (!_showSearch && _query.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
      child: TextField(
        controller: _searchController,
        autofocus: _showSearch,
        onChanged: (v) => setState(() => _query = v),
        style: const TextStyle(fontSize: 14),
        decoration: InputDecoration(
          hintText: '搜索项目或会话…',
          hintStyle: const TextStyle(fontSize: 13, color: AppColors.textMuted),
          prefixIcon: const Icon(
            Icons.search_rounded,
            size: 18,
            color: AppColors.textMuted,
          ),
          suffixIcon: _query.isEmpty
              ? null
              : IconButton(
                  icon: const Icon(Icons.clear_rounded, size: 16),
                  onPressed: () {
                    _searchController.clear();
                    setState(() => _query = '');
                  },
                ),
          isDense: true,
          filled: true,
          fillColor: AppColors.surfaceMuted,
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide.none,
          ),
        ),
      ),
    );
  }

  Widget _buildNewTaskButton() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 14),
      child: Material(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          onTap: widget.onNewTask,
          borderRadius: BorderRadius.circular(14),
          child: Container(
            height: 44,
            decoration: BoxDecoration(
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
            child: const Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(
                  Icons.add_circle_outline_rounded,
                  size: 18,
                  color: AppColors.textPrimary,
                ),
                SizedBox(width: 8),
                Text(
                  '新建任务',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textPrimary,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildSectionHeader({
    required String title,
    required bool expanded,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: [
            Text(
              title,
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w500,
                color: AppColors.textMuted,
              ),
            ),
            const SizedBox(width: 4),
            Icon(
              expanded
                  ? Icons.keyboard_arrow_down_rounded
                  : Icons.keyboard_arrow_right_rounded,
              size: 16,
              color: AppColors.textMuted,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSessionRow(
    SessionSummary session, {
    bool indent = false,
    bool mutedInactive = false,
  }) {
    final isActive = session.id == widget.activeSessionId;
    final isRunning = widget.runningSessionIds.contains(session.id);

    return Padding(
      padding: EdgeInsets.fromLTRB(indent ? 24 : 12, 2, 12, 2),
      child: Material(
        color: isActive ? AppColors.surfaceMuted : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          onTap: () => widget.onSelectSession(session),
          borderRadius: BorderRadius.circular(10),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 9, 4, 9),
            child: Row(
              children: [
                if (isRunning) ...[
                  const StatusDot(color: AppColors.brand, size: 7, active: true),
                  const SizedBox(width: 8),
                ],
                Expanded(
                  child: Text(
                    session.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14.5,
                      fontWeight: isActive ? FontWeight.w600 : FontWeight.w400,
                      color: isActive
                          ? AppColors.textPrimary
                          : (mutedInactive
                              ? AppColors.textSecondary
                              : AppColors.textPrimary),
                    ),
                  ),
                ),
                const SizedBox(width: 4),
                if (isRunning)
                  const Icon(
                    Icons.error_outline_rounded,
                    size: 15,
                    color: AppColors.warning,
                  ),
                PopupMenuButton<String>(
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                  iconSize: 16,
                  icon: const Icon(
                    Icons.more_horiz_rounded,
                    color: AppColors.textMuted,
                  ),
                  onSelected: (value) {
                    if (value == 'rename') {
                      widget.onRenameSession(session);
                    } else if (value == 'copy') {
                      _copyId(session.id);
                    } else if (value == 'delete') {
                      widget.onDeleteSession(session);
                    }
                  },
                  itemBuilder: (_) => const [
                    PopupMenuItem(value: 'rename', child: Text('重命名')),
                    PopupMenuItem(value: 'copy', child: Text('复制会话 ID')),
                    PopupMenuItem(
                      value: 'delete',
                      child: Text(
                        '删除会话',
                        style: TextStyle(color: AppColors.danger),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildProjectGroup(WorkspaceProjectGroup group) {
    final q = _query.trim().toLowerCase();
    final filteredSessions = q.isEmpty
        ? group.sessions
        : group.sessions.where((s) {
            if (projectName(group.root).toLowerCase().contains(q) ||
                group.root.toLowerCase().contains(q)) {
              return true;
            }
            return s.title.toLowerCase().contains(q) ||
                s.id.toLowerCase().contains(q);
          }).toList();

    if (q.isNotEmpty && filteredSessions.isEmpty) {
      return const SizedBox.shrink();
    }

    final expanded = q.isNotEmpty || widget.expandedProjects.contains(group.root);
    final name = projectName(group.root);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InkWell(
          onTap: () => widget.onSelectProjectToggle(group.root),
          onLongPress: widget.onRemoveProject == null
              ? null
              : () => widget.onRemoveProject!(group),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
            child: Row(
              children: [
                const Icon(
                  Icons.folder_outlined,
                  size: 19,
                  color: AppColors.textPrimary,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w500,
                          color: AppColors.textPrimary,
                        ),
                      ),
                      if (group.root.isNotEmpty && group.root != name)
                        Text(
                          group.root,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 11,
                            color: AppColors.textMuted,
                          ),
                        ),
                    ],
                  ),
                ),
                Icon(
                  expanded
                      ? Icons.keyboard_arrow_down_rounded
                      : Icons.keyboard_arrow_right_rounded,
                  size: 18,
                  color: AppColors.textMuted,
                ),
                IconButton(
                  tooltip: '在此项目新建任务',
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                  constraints:
                      const BoxConstraints(minWidth: 32, minHeight: 32),
                  onPressed: () => widget.onNewTaskInProject(group.root),
                  icon: const Icon(
                    Icons.add_rounded,
                    size: 19,
                    color: AppColors.textSecondary,
                  ),
                ),
              ],
            ),
          ),
        ),
        if (expanded)
          for (final s in filteredSessions) _buildSessionRow(s, indent: true),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final drawerWidth =
        math.min(MediaQuery.of(context).size.width * 0.84, 340.0);
    final recentCandidates = _filterSessions(widget.allSessions);
    final visibleLimit = _showMoreRecent ? 6 : 2;
    final visibleRecent = recentCandidates.take(visibleLimit).toList();

    return Drawer(
      width: drawerWidth,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.horizontal(right: Radius.circular(20)),
      ),
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _buildHostHeader(context),
            _buildSearchBar(),
            _buildNewTaskButton(),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.only(bottom: 16),
                children: [
                  if (recentCandidates.isNotEmpty) ...[
                    _buildSectionHeader(
                      title: '最近任务',
                      expanded: _recentExpanded,
                      onTap: () =>
                          setState(() => _recentExpanded = !_recentExpanded),
                    ),
                    if (_recentExpanded) ...[
                      for (var i = 0; i < visibleRecent.length; i++)
                        _buildSessionRow(
                          visibleRecent[i],
                          mutedInactive: i > 0,
                        ),
                      if (recentCandidates.length > 2)
                        InkWell(
                          onTap: () => setState(
                            () => _showMoreRecent = !_showMoreRecent,
                          ),
                          child: Padding(
                            padding: const EdgeInsets.fromLTRB(24, 6, 16, 10),
                            child: Text(
                              _showMoreRecent ? '收起' : '展开更多',
                              style: const TextStyle(
                                fontSize: 13.5,
                                color: AppColors.textMuted,
                              ),
                            ),
                          ),
                        ),
                    ],
                    const SizedBox(height: 6),
                  ],
                  _buildSectionHeader(
                    title: '空间 (${widget.projectGroups.length})',
                    expanded: _spacesExpanded,
                    onTap: () =>
                        setState(() => _spacesExpanded = !_spacesExpanded),
                  ),
                  if (_spacesExpanded) ...[
                    if (widget.projectGroups.isEmpty)
                      const Padding(
                        padding:
                            EdgeInsets.symmetric(horizontal: 20, vertical: 16),
                        child: Text(
                          '暂无项目会话，点击上方「新建任务」开始。',
                          style: TextStyle(
                            fontSize: 13,
                            color: AppColors.textMuted,
                          ),
                        ),
                      )
                    else
                      for (final group in widget.projectGroups)
                        _buildProjectGroup(group),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
