/// Remote extension UI request cards (`confirm`, `editor`, `input`, `select`)
/// surfaced by `ApprovalBridge` over `remote.approval`.
library;

import 'package:flutter/material.dart';

import '../core/app_theme.dart';
import 'text_selection_menu.dart';
import 'ui_kit.dart';

class ExtensionUiCard extends StatefulWidget {
  final Map<String, dynamic> request;
  final Future<void> Function(Map<String, dynamic> request, Map<String, dynamic> body)
      onRespond;

  const ExtensionUiCard({
    required this.request,
    required this.onRespond,
    super.key,
  });

  @override
  State<ExtensionUiCard> createState() => _ExtensionUiCardState();
}

class _ExtensionUiCardState extends State<ExtensionUiCard> {
  late final TextEditingController _controller;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(
      text: widget.request['prefill']?.toString() ?? '',
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _send(Map<String, dynamic> body) async {
    if (_submitting) return;
    setState(() => _submitting = true);
    try {
      await widget.onRespond(widget.request, body);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  String _localizeTitle(String rawTitle, String method) {
    if (rawTitle == 'Acceptance criteria (optional, one per line)') {
      return '可选：填写验收标准（每行一条）';
    }
    if (rawTitle.isNotEmpty) return rawTitle;
    if (method == 'editor' || method == 'input') return '请输入内容';
    if (method == 'select') return '请选择一项';
    return '请确认操作';
  }

  @override
  Widget build(BuildContext context) {
    final req = widget.request;
    final method = req['method'] as String? ?? 'confirm';
    final hasExpiry = req['expiresAt'] != null;
    final rawTitle = req['title']?.toString() ?? '';
    final message = req['message']?.toString() ?? '';

    if (method == 'editor' || method == 'input') {
      final isEditor = method == 'editor';
      final isGoalCriteria =
          rawTitle == 'Acceptance criteria (optional, one per line)';
      final placeholder = req['placeholder']?.toString() ??
          (isGoalCriteria ? '留空可直接点「跳过并开始」，Agent 会自动拟定标准' : '输入内容…');
      return SurfaceCard(
        key: const Key('extension-ui-editor-card'),
        margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        borderColor: AppColors.brandBorder,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                const Icon(
                  Icons.edit_note_rounded,
                  size: 18,
                  color: AppColors.brand,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    _localizeTitle(rawTitle, method),
                    style: const TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textPrimary,
                    ),
                  ),
                ),
              ],
            ),
            if (message.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                message,
                style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
              ),
            ],
            const SizedBox(height: 8),
            TextField(
              controller: _controller,
              minLines: isEditor ? 2 : 1,
              maxLines: isEditor ? 5 : 1,
              enabled: !_submitting,
              contextMenuBuilder: buildChineseTextSelectionMenu,
              decoration: InputDecoration(
                hintText: placeholder,
                hintStyle: const TextStyle(fontSize: 12.5, color: AppColors.textMuted),
                isDense: true,
                filled: true,
                fillColor: AppColors.surfaceSubtle,
                contentPadding: const EdgeInsets.all(10),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
              ),
            ),
            if (hasExpiry) ...[
              const SizedBox(height: 4),
              const Text(
                '此请求在桌面端有超时。',
                style: TextStyle(fontSize: 11, color: AppColors.textMuted),
              ),
            ],
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: _submitting ? null : () => _send({'cancelled': true}),
                  child: Text(isGoalCriteria ? '跳过并开始' : '取消'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _submitting
                      ? null
                      : () => _send({'value': _controller.text}),
                  child: Text(isGoalCriteria ? '确认并开始' : '确定'),
                ),
              ],
            ),
          ],
        ),
      );
    }

    if (method == 'select') {
      final rawOptions = req['options'];
      final options = [
        if (rawOptions is List)
          for (final o in rawOptions)
            if (o != null) o.toString(),
      ];
      return SurfaceCard(
        key: const Key('extension-ui-select-card'),
        margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        borderColor: AppColors.brandBorder,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              _localizeTitle(rawTitle, method),
              style: const TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w700,
                color: AppColors.textPrimary,
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final option in options)
                  OutlinedButton(
                    onPressed: _submitting ? null : () => _send({'value': option}),
                    child: Text(option),
                  ),
              ],
            ),
            const SizedBox(height: 4),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: _submitting ? null : () => _send({'cancelled': true}),
                child: const Text('取消'),
              ),
            ),
          ],
        ),
      );
    }

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      color: AppColors.dangerBg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: AppColors.dangerBorder),
      ),
      elevation: 0,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '待审批：$method',
              style: const TextStyle(
                fontWeight: FontWeight.bold,
                color: AppColors.danger,
              ),
            ),
            if (rawTitle.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(rawTitle, style: const TextStyle(fontSize: 13)),
            ],
            if (message.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(message, style: const TextStyle(fontSize: 12.5)),
            ],
            if (hasExpiry)
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text(
                  '此审批在桌面端有超时，到点将自动拒绝。',
                  style: TextStyle(fontSize: 11, color: AppColors.textMuted),
                ),
              ),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: _submitting ? null : () => _send({'confirmed': false}),
                  child: const Text('拒绝'),
                ),
                const SizedBox(width: 6),
                FilledButton(
                  onPressed: _submitting ? null : () => _send({'confirmed': true}),
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
