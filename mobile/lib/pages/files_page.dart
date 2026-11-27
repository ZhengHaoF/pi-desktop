/// Project file browser tab (`文件`): lists directories and previews files
/// on the currently active PC via allowlisted `files.list` and `files.read` RPCs.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../core/app_theme.dart';
import '../core/remote_connection.dart';
import '../widgets/chat_image.dart';
import '../widgets/session_models.dart';
import '../widgets/ui_kit.dart';

class FilesPage extends StatefulWidget {
  final RemoteConnection connection;
  final List<String> projectRoots;
  final String? activeRoot;
  final VoidCallback? onOpenDrawer;

  const FilesPage({
    required this.connection,
    required this.projectRoots,
    this.activeRoot,
    this.onOpenDrawer,
    super.key,
  });

  @override
  State<FilesPage> createState() => _FilesPageState();
}

class _RemoteFileEntry {
  final String name;
  final String path;
  final bool isDir;
  final int size;

  const _RemoteFileEntry({
    required this.name,
    required this.path,
    required this.isDir,
    required this.size,
  });

  factory _RemoteFileEntry.fromMap(Map<String, dynamic> map) {
    final type = map['type'] as String? ?? '';
    return _RemoteFileEntry(
      name: map['name'] as String? ?? '',
      path: map['path'] as String? ?? '',
      isDir: map['isDir'] == true || type == 'directory',
      size: (map['size'] as num?)?.toInt() ?? 0,
    );
  }
}

class _FilesPageState extends State<FilesPage> {
  String? _selectedRoot;
  String? _currentDir;
  List<_RemoteFileEntry> _entries = const [];
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _syncRootAndLoad();
  }

  @override
  void didUpdateWidget(covariant FilesPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    final activeChanged = oldWidget.activeRoot != widget.activeRoot &&
        widget.activeRoot != null &&
        widget.activeRoot != _selectedRoot;
    final rootsChanged = _selectedRoot == null && widget.projectRoots.isNotEmpty;
    if (activeChanged || rootsChanged) {
      _syncRootAndLoad();
    }
  }

  void _syncRootAndLoad() {
    final nextRoot = widget.activeRoot ??
        (widget.projectRoots.isNotEmpty ? widget.projectRoots.first : null);
    if (nextRoot == null || nextRoot.isEmpty) {
      setState(() {
        _selectedRoot = null;
        _currentDir = null;
        _entries = const [];
        _error = null;
      });
      return;
    }
    _selectedRoot = nextRoot;
    _currentDir = nextRoot;
    _loadDir(nextRoot);
  }

  Future<void> _loadDir(String dirPath) async {
    if (!widget.connection.isReady) {
      setState(() {
        _currentDir = dirPath;
        _entries = const [];
        _loading = false;
        _error = widget.connection.isTargetHostOffline
            ? '电脑当前离线，无法浏览项目文件'
            : '连接未就绪';
      });
      return;
    }

    setState(() {
      _currentDir = dirPath;
      _loading = true;
      _error = null;
    });

    try {
      final res = await widget.connection.request('files.list', {'path': dirPath});
      if (!mounted) return;
      final rawEntries = (res['entries'] as List?) ?? const [];
      final parsed = [
        for (final item in rawEntries)
          if (item is Map) _RemoteFileEntry.fromMap(Map<String, dynamic>.from(item)),
      ];
      parsed.sort((a, b) {
        if (a.isDir != b.isDir) return a.isDir ? -1 : 1;
        return a.name.toLowerCase().compareTo(b.name.toLowerCase());
      });
      setState(() {
        _entries = parsed;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      final rawMsg = e is StateError
          ? e.message.replaceFirst('Bad state: ', '')
          : e.toString();
      final msg = rawMsg.contains('FORBIDDEN')
          ? '该路径未对手机端授权读取，请尝试切换到已有会话的最近项目'
          : rawMsg;
      setState(() {
        _entries = const [];
        _loading = false;
        _error = msg;
      });
    }
  }

  bool get _canGoUp {
    final root = _selectedRoot;
    final dir = _currentDir;
    if (root == null || dir == null) return false;
    return _normalize(dir) != _normalize(root) &&
        _normalize(dir).length > _normalize(root).length;
  }

  String _normalize(String p) => p.replaceAll('\\', '/').replaceAll(RegExp(r'/+$'), '');

  void _goUp() {
    final root = _selectedRoot;
    final dir = _currentDir;
    if (root == null || dir == null || !_canGoUp) return;
    final sep = dir.contains('\\') ? '\\' : '/';
    final normalized = _normalize(dir);
    final idx = normalized.lastIndexOf('/');
    if (idx <= 0) {
      _loadDir(root);
      return;
    }
    var parent = normalized.substring(0, idx);
    if (sep == '\\') {
      parent = parent.replaceAll('/', '\\');
      if (parent.endsWith(':')) parent = '$parent\\';
    }
    final normRoot = _normalize(root);
    if (_normalize(parent).length < normRoot.length) {
      parent = root;
    }
    _loadDir(parent);
  }

  Future<void> _openFile(_RemoteFileEntry entry) async {
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => const Center(child: CircularProgressIndicator()),
    );
    try {
      final res = await widget.connection.request('files.read', {'path': entry.path});
      if (!mounted) return;
      Navigator.of(context).pop();

      final encoding = res['encoding'] as String? ?? 'utf8';
      final mime = res['mime'] as String? ?? 'text/plain';
      final content = res['content'] as String?;
      final truncated = res['truncated'] == true;

      if (encoding == 'base64' && mime.startsWith('image/') && content != null) {
        final bytes = Uint8List.fromList(base64Decode(content));
        if (!mounted) return;
        await Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => ImageViewer(bytes: bytes, mimeType: mime),
          ),
        );
        return;
      }

      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => _FilePreviewPage(
            title: entry.name,
            path: entry.path,
            content: content,
            encoding: encoding,
            truncated: truncated,
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('打开文件失败：$e')),
      );
    }
  }

  void _pickProjectRoot() {
    showModalBottomSheet<void>(
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
                '选择项目空间',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final root in widget.projectRoots)
                    ListTile(
                      leading: Icon(
                        root == _selectedRoot
                            ? Icons.folder_open_rounded
                            : Icons.folder_outlined,
                        color: root == _selectedRoot
                            ? AppColors.brand
                            : AppColors.textSecondary,
                      ),
                      title: Text(
                        projectName(root),
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                      subtitle: Text(
                        root,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: root == _selectedRoot
                          ? const Icon(Icons.check_rounded, color: AppColors.brand)
                          : null,
                      onTap: () {
                        Navigator.of(ctx).pop();
                        setState(() => _selectedRoot = root);
                        _loadDir(root);
                      },
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _formatSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  @override
  Widget build(BuildContext context) {
    final root = _selectedRoot;
    final dir = _currentDir;
    final hasRoots = widget.projectRoots.isNotEmpty;

    return Scaffold(
      appBar: AppBar(
        leading: widget.onOpenDrawer == null
            ? null
            : IconButton(
                tooltip: '打开工作区侧栏',
                icon: const Icon(Icons.menu_rounded),
                onPressed: widget.onOpenDrawer,
              ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              root == null ? '项目文件' : projectName(root),
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w600),
            ),
            if (dir != null && dir.isNotEmpty)
              Text(
                dir,
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
          if (widget.projectRoots.length > 1)
            IconButton(
              tooltip: '切换项目',
              icon: const Icon(Icons.swap_horiz_rounded),
              onPressed: _pickProjectRoot,
            ),
          if (dir != null)
            IconButton(
              tooltip: '刷新目录',
              icon: const Icon(Icons.refresh_rounded),
              onPressed: () => _loadDir(dir),
            ),
        ],
      ),
      body: !hasRoots || root == null
          ? const EmptyStateView(
              icon: Icons.folder_off_outlined,
              title: '暂无可浏览的项目空间',
              subtitle: '在电脑端打开项目或发起对话后，可在此浏览项目目录与源码文件。',
            )
          : Column(
              children: [
                if (_canGoUp)
                  Material(
                    color: AppColors.surface,
                    child: InkWell(
                      onTap: _goUp,
                      child: const Padding(
                        padding:
                            EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                        child: Row(
                          children: [
                            Icon(
                              Icons.arrow_upward_rounded,
                              size: 18,
                              color: AppColors.brand,
                            ),
                            SizedBox(width: 8),
                            Text(
                              '返回上级目录',
                              style: TextStyle(
                                fontSize: 13.5,
                                fontWeight: FontWeight.w500,
                                color: AppColors.brand,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                if (_canGoUp) const Divider(height: 1),
                Expanded(
                  child: _loading
                      ? const Center(child: CircularProgressIndicator())
                      : _error != null
                          ? ErrorBanner(
                              margin: const EdgeInsets.all(14),
                              message: _error!,
                              action: dir == null
                                  ? null
                                  : TextButton(
                                      onPressed: () => _loadDir(dir),
                                      child: const Text('重试'),
                                    ),
                            )
                          : _entries.isEmpty
                              ? const EmptyStateView(
                                  icon: Icons.folder_open_rounded,
                                  title: '空目录',
                                  subtitle: '该目录下没有可见的文件或子文件夹。',
                                )
                              : ListView.separated(
                                  padding: const EdgeInsets.symmetric(vertical: 6),
                                  itemCount: _entries.length,
                                  separatorBuilder: (_, _) => const Divider(
                                    height: 1,
                                    indent: 52,
                                  ),
                                  itemBuilder: (_, index) {
                                    final entry = _entries[index];
                                    return ListTile(
                                      leading: Icon(
                                        entry.isDir
                                            ? Icons.folder_rounded
                                            : Icons.description_outlined,
                                        color: entry.isDir
                                            ? AppColors.brand
                                            : AppColors.textSecondary,
                                      ),
                                      title: Text(
                                        entry.name,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                          fontSize: 14.5,
                                          fontWeight: FontWeight.w500,
                                        ),
                                      ),
                                      trailing: entry.isDir
                                          ? const Icon(
                                              Icons.chevron_right_rounded,
                                              color: AppColors.textMuted,
                                            )
                                          : Text(
                                              _formatSize(entry.size),
                                              style: const TextStyle(
                                                fontSize: 12,
                                                color: AppColors.textMuted,
                                              ),
                                            ),
                                      onTap: entry.isDir
                                          ? () => _loadDir(entry.path)
                                          : () => _openFile(entry),
                                    );
                                  },
                                ),
                ),
              ],
            ),
    );
  }
}

class _FilePreviewPage extends StatelessWidget {
  final String title;
  final String path;
  final String? content;
  final String encoding;
  final bool truncated;

  const _FilePreviewPage({
    required this.title,
    required this.path,
    required this.content,
    required this.encoding,
    required this.truncated,
  });

  @override
  Widget build(BuildContext context) {
    final bodyText = encoding == 'too_large'
        ? '文件体积过大，暂不支持在移动端直接预览。'
        : (encoding == 'base64'
            ? '二进制文件，暂不支持文本预览。'
            : (content ?? '(空文件)'));

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, overflow: TextOverflow.ellipsis),
            Text(
              path,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
            ),
          ],
        ),
      ),
      body: Column(
        children: [
          if (truncated)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              color: AppColors.warningBg,
              child: const Text(
                '文件较长，已截断显示前段内容',
                style: TextStyle(fontSize: 12, color: AppColors.warning),
              ),
            ),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(14),
              child: SelectableText(
                bodyText,
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12.5,
                  height: 1.5,
                  color: AppColors.textPrimary,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
