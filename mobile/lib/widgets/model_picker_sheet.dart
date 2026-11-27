/// Shared bottom-sheet model picker used by both HomePage (new task) and
/// ChatPage (live session switch).
library;

import 'package:flutter/material.dart';

import '../core/app_theme.dart';
import 'ui_kit.dart';

/// Pi thinking level id -> Chinese display name.
const Map<String, String> thinkingLevelLabels = {
  'off': '关闭',
  'minimal': '极简',
  'low': '低',
  'medium': '中',
  'high': '高',
  'xhigh': '极高',
  'max': '最大',
};

/// Polished bottom-sheet model picker backed by `models.preferences.get`.
class ModelPickerSheet extends StatefulWidget {
  final Map<String, dynamic>? prefs;
  final Map<String, String>? current;
  final String? thinkingLevel;
  final List<String> thinkingLevels;
  final Future<void> Function(String provider, String modelId, BuildContext) onPick;
  final Future<void> Function(String level)? onThinkingLevel;
  final VoidCallback? onPickDefault;
  final String title;

  const ModelPickerSheet({
    required this.prefs,
    required this.onPick,
    this.current,
    this.thinkingLevel,
    this.thinkingLevels = const [],
    this.onThinkingLevel,
    this.onPickDefault,
    this.title = '选择模型',
    super.key,
  });

  @override
  State<ModelPickerSheet> createState() => _ModelPickerSheetState();
}

class _ModelPickerSheetState extends State<ModelPickerSheet> {
  String? _level;

  @override
  void initState() {
    super.initState();
    _level = widget.thinkingLevel;
  }

  List<Map<String, dynamic>> _models() {
    final raw = widget.prefs?['models'];
    return <Map<String, dynamic>>[
      if (raw is List)
        for (final m in raw)
          if (m is Map) Map<String, dynamic>.from(m),
    ];
  }

  Future<void> _chooseLevel(String level) async {
    final onThinkingLevel = widget.onThinkingLevel;
    if (onThinkingLevel == null) return;
    setState(() => _level = level);
    await onThinkingLevel(level);
  }

  @override
  Widget build(BuildContext context) {
    final models = _models();
    final prefs = widget.prefs;
    final defaultModel = prefs?['defaultModel'];
    bool isDefault(Map<String, dynamic> m) {
      if (defaultModel is! Map) return false;
      return defaultModel['provider'] == m['provider'] && defaultModel['modelId'] == m['id'];
    }

    bool isCurrent(Map<String, dynamic> m) =>
        widget.current?['provider'] == m['provider'] && widget.current?['modelId'] == m['id'];

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.65),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 8, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close, size: 20),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            if (widget.thinkingLevels.isNotEmpty && widget.onThinkingLevel != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Text('思考强度', style: TextStyle(fontSize: 13, color: AppColors.textSecondary)),
                        const Spacer(),
                        Text(
                          _level == null ? '跟随默认' : (thinkingLevelLabels[_level] ?? _level!),
                          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final level in widget.thinkingLevels)
                          ChoiceChip(
                            label: Text(thinkingLevelLabels[level] ?? level),
                            selected: _level == level,
                            showCheckmark: false,
                            visualDensity: VisualDensity.compact,
                            labelStyle: const TextStyle(fontSize: 12.5),
                            onSelected: (_) => _chooseLevel(level),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            const Divider(height: 1),
            Flexible(
              child: prefs == null
                  ? const Padding(
                      padding: EdgeInsets.symmetric(vertical: 40),
                      child: Center(
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                            SizedBox(width: 10),
                            Text('正在加载模型列表…', style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
                          ],
                        ),
                      ),
                    )
                  : models.isEmpty
                  ? const Padding(
                      padding: EdgeInsets.all(24),
                      child: Center(child: Text('没有可用模型', style: TextStyle(color: AppColors.textMuted))),
                    )
                  : ListView(
                      shrinkWrap: true,
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      children: [
                        if (widget.onPickDefault != null)
                          InkWell(
                            onTap: widget.onPickDefault,
                            child: Padding(
                              padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
                              child: Row(
                                children: [
                                  Container(
                                    width: 34,
                                    height: 34,
                                    alignment: Alignment.center,
                                    decoration: BoxDecoration(
                                      color: AppColors.brandSoft,
                                      borderRadius: BorderRadius.circular(10),
                                    ),
                                    child: const Icon(Icons.auto_awesome, size: 18, color: AppColors.brand),
                                  ),
                                  const SizedBox(width: 12),
                                  const Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          '默认模型（跟随 PC 设置）',
                                          style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                                        ),
                                        SizedBox(height: 2),
                                        Text(
                                          '使用电脑端当前配置的默认模型',
                                          style: TextStyle(fontSize: 11, color: AppColors.textMuted),
                                        ),
                                      ],
                                    ),
                                  ),
                                  const Icon(Icons.chevron_right, size: 18, color: AppColors.textMuted),
                                ],
                              ),
                            ),
                          ),
                        for (final m in models)
                          _modelRow(
                            context,
                            m,
                            isCurrent: isCurrent(m),
                            isDefault: isDefault(m),
                          ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _modelRow(
    BuildContext context,
    Map<String, dynamic> m, {
    required bool isCurrent,
    required bool isDefault,
  }) {
    final provider = m['provider'] as String? ?? '';
    final hue = provider.hashCode.abs() % 360;
    final avatarBg = HSLColor.fromAHSL(1, hue.toDouble(), 0.4, 0.94).toColor();
    final avatarFg = HSLColor.fromAHSL(1, hue.toDouble(), 0.5, 0.36).toColor();
    final label = (m['name'] as String?)?.trim().isNotEmpty == true
        ? m['name'] as String
        : (m['id'] as String? ?? '');
    final initial = label.isEmpty ? '?' : label.substring(0, 1).toUpperCase();
    return InkWell(
      onTap: isCurrent ? null : () => widget.onPick(provider, m['id'] as String, context),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
        child: Row(
          children: [
            Container(
              width: 34,
              height: 34,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: avatarBg, borderRadius: BorderRadius.circular(10)),
              child: Text(
                initial,
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: avatarFg),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: isCurrent ? FontWeight.w700 : FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '$provider / ${m['id']}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            if (isCurrent)
              const Icon(Icons.check_circle, size: 20, color: AppColors.brand)
            else if (isDefault)
              const StatusBadge(
                label: '默认',
                foreground: AppColors.success,
                background: AppColors.successBg,
              )
            else
              const SizedBox(width: 20),
          ],
        ),
      ),
    );
  }
}
