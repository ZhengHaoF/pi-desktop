/// Floating goal panel mirrored after desktop `GoalPanel.tsx`: renders goal
/// progress, continuation budget, `goal_report` acceptance criteria checklist,
/// and `accept` / `reject` / `extend` / `stop` actions.
library;

import 'package:flutter/material.dart';

import '../core/app_theme.dart';
import 'text_selection_menu.dart';
import 'ui_kit.dart';

class RemoteGoalCriterionReport {
  final String criterion;
  final bool met;
  final String evidence;

  const RemoteGoalCriterionReport({
    required this.criterion,
    required this.met,
    required this.evidence,
  });

  factory RemoteGoalCriterionReport.fromMap(Map<String, dynamic> map) {
    return RemoteGoalCriterionReport(
      criterion: (map['criterion'] as String? ?? '').trim(),
      met: map['met'] == true,
      evidence: (map['evidence'] as String? ?? '').trim(),
    );
  }
}

class RemoteGoalReport {
  final String? summary;
  final List<RemoteGoalCriterionReport> criteria;

  const RemoteGoalReport({
    required this.criteria,
    this.summary,
  });

  static RemoteGoalReport? fromDynamic(Object? raw) {
    if (raw is! Map) return null;
    final map = Map<String, dynamic>.from(raw);
    final rawCriteria = map['criteria'];
    if (rawCriteria is! List || rawCriteria.isEmpty) return null;
    final criteria = [
      for (final item in rawCriteria)
        if (item is Map)
          RemoteGoalCriterionReport.fromMap(Map<String, dynamic>.from(item)),
    ];
    if (criteria.isEmpty) return null;
    final summary = (map['summary'] as String?)?.trim();
    return RemoteGoalReport(
      summary: (summary == null || summary.isEmpty) ? null : summary,
      criteria: criteria,
    );
  }
}

class RemoteGoalState {
  final String goal;
  final List<String> criteria;
  final String status;
  final int continuations;
  final int maxContinuations;
  final RemoteGoalReport? report;
  final String? feedback;

  const RemoteGoalState({
    required this.goal,
    required this.criteria,
    required this.status,
    required this.continuations,
    required this.maxContinuations,
    this.report,
    this.feedback,
  });

  bool get isTerminal => status == 'accepted' || status == 'stopped';

  String get statusKey =>
      '$status:$continuations:$maxContinuations:${report?.criteria.map((c) => '${c.met}:${c.criterion}').join('|') ?? ''}';

  static RemoteGoalState? fromDynamic(Object? raw) {
    if (raw is! Map) return null;
    final map = Map<String, dynamic>.from(raw);
    final goal = (map['goal'] as String? ?? '').trim();
    if (goal.isEmpty) return null;
    final rawCriteria = map['criteria'];
    final criteria = <String>[
      if (rawCriteria is List)
        for (final item in rawCriteria)
          if (item is String && item.trim().isNotEmpty) item.trim(),
    ];
    final feedback = (map['feedback'] as String?)?.trim();
    return RemoteGoalState(
      goal: goal,
      criteria: criteria,
      status: map['status'] as String? ?? 'working',
      continuations: (map['continuations'] as num?)?.toInt() ?? 0,
      maxContinuations: (map['maxContinuations'] as num?)?.toInt() ?? 8,
      report: RemoteGoalReport.fromDynamic(map['report']),
      feedback: (feedback == null || feedback.isEmpty) ? null : feedback,
    );
  }
}

class GoalPanel extends StatefulWidget {
  final RemoteGoalState state;
  final Future<void> Function(String action, {String? feedback}) onAction;
  final VoidCallback? onDismiss;

  const GoalPanel({
    required this.state,
    required this.onAction,
    this.onDismiss,
    super.key,
  });

  @override
  State<GoalPanel> createState() => _GoalPanelState();
}

class _GoalPanelState extends State<GoalPanel> {
  late bool _collapsed;
  bool _collapsedByUser = false;
  bool _feedbackOpen = false;
  final _feedbackController = TextEditingController();
  String? _pendingAction;

  @override
  void initState() {
    super.initState();
    _collapsed = widget.state.isTerminal;
  }

  @override
  void didUpdateWidget(covariant GoalPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.state.isTerminal) {
      _collapsed = true;
    } else if (!_collapsedByUser && oldWidget.state.status != widget.state.status) {
      _collapsed = false;
    }
    if (widget.state.status != 'awaiting_acceptance' && _feedbackOpen) {
      _feedbackOpen = false;
      _feedbackController.clear();
    }
  }

  @override
  void dispose() {
    _feedbackController.dispose();
    super.dispose();
  }

  Future<void> _run(String action, {String? feedback}) async {
    if (_pendingAction != null) return;
    setState(() => _pendingAction = action);
    try {
      await widget.onAction(action, feedback: feedback);
      if (mounted && action == 'reject') {
        setState(() {
          _feedbackOpen = false;
          _feedbackController.clear();
        });
      }
    } finally {
      if (mounted) setState(() => _pendingAction = null);
    }
  }

  (String, Color, Color) _statusVisual(String status) {
    switch (status) {
      case 'working':
        return ('进行中', AppColors.brandInk, AppColors.brandSoft);
      case 'awaiting_acceptance':
        return ('待验收', AppColors.warning, AppColors.warningBg);
      case 'budget_exhausted':
        return ('预算已用尽', AppColors.danger, AppColors.dangerBg);
      case 'accepted':
        return ('已验收', AppColors.success, AppColors.successBg);
      case 'stopped':
      default:
        return ('已停止', AppColors.textSecondary, AppColors.surfaceMuted);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final (statusLabel, fg, bg) = _statusVisual(state.status);
    final busy = _pendingAction != null;
    final report = state.report;

    return SurfaceCard(
      key: const Key('goal-panel'),
      margin: const EdgeInsets.fromLTRB(12, 6, 12, 4),
      padding: EdgeInsets.zero,
      borderColor: state.status == 'awaiting_acceptance'
          ? AppColors.warningBorder
          : (state.status == 'budget_exhausted'
              ? AppColors.dangerBorder
              : AppColors.border),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          InkWell(
            onTap: () {
              setState(() {
                _collapsed = !_collapsed;
                _collapsedByUser = _collapsed;
              });
            },
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
              child: Row(
                children: [
                  StatusBadge(
                    label: '目标',
                    foreground:
                        state.isTerminal ? AppColors.textMuted : AppColors.brandInk,
                    background: state.isTerminal
                        ? AppColors.surfaceMuted
                        : AppColors.brandSoft,
                  ),
                  const SizedBox(width: 6),
                  StatusBadge(
                    label: statusLabel,
                    foreground: fg,
                    background: bg,
                  ),
                  if (report != null) ...[
                    const SizedBox(width: 6),
                    Text(
                      '${report.criteria.where((item) => item.met).length}/'
                      '${report.criteria.length} 项达成',
                      style: const TextStyle(
                        fontSize: 11.5,
                        fontFamily: 'monospace',
                        color: AppColors.textMuted,
                      ),
                    ),
                  ],
                  const SizedBox(width: 8),
                  if (_collapsed)
                    Expanded(
                      child: Text(
                        state.goal,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 12.5,
                          color: AppColors.textSecondary,
                        ),
                      ),
                    )
                  else
                    Expanded(
                      child: Text(
                        '${state.continuations}/${state.maxContinuations} 次自动续跑',
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 11.5,
                          fontFamily: 'monospace',
                          color: AppColors.textMuted,
                        ),
                      ),
                    ),
                  Icon(
                    _collapsed
                        ? Icons.keyboard_arrow_down_rounded
                        : Icons.keyboard_arrow_up_rounded,
                    size: 18,
                    color: AppColors.textMuted,
                  ),
                  if (widget.onDismiss != null)
                    IconButton(
                      tooltip: '隐藏，目标变化后再显示',
                      visualDensity: VisualDensity.compact,
                      constraints:
                          const BoxConstraints(minWidth: 28, minHeight: 28),
                      padding: EdgeInsets.zero,
                      icon: const Icon(Icons.close_rounded,
                          size: 16, color: AppColors.textMuted),
                      onPressed: widget.onDismiss,
                    ),
                ],
              ),
            ),
          ),
          if (!_collapsed)
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 260),
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      state.goal,
                      style: const TextStyle(
                        fontSize: 13.5,
                        height: 1.45,
                        fontWeight: FontWeight.w500,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    if (report != null) ...[
                      const SizedBox(height: 8),
                      const Text(
                        '验收标准',
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w600,
                          color: AppColors.textMuted,
                        ),
                      ),
                      if (report.summary != null) ...[
                        const SizedBox(height: 4),
                        Text(
                          report.summary!,
                          style: const TextStyle(
                            fontSize: 12.5,
                            height: 1.45,
                            color: AppColors.textSecondary,
                          ),
                        ),
                      ],
                      const SizedBox(height: 6),
                      _CriteriaRail(
                        items: [
                          for (final item in report.criteria)
                            (criterion: item.criterion, met: item.met, evidence: item.evidence),
                        ],
                      ),
                    ] else if (state.criteria.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      const Text(
                        '验收标准',
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w600,
                          color: AppColors.textMuted,
                        ),
                      ),
                      const SizedBox(height: 4),
                      for (final criterion in state.criteria)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 3),
                          child: Text(
                            '• $criterion',
                            style: const TextStyle(
                              fontSize: 12,
                              height: 1.4,
                              color: AppColors.textSecondary,
                            ),
                          ),
                        ),
                    ],
                    if (state.feedback != null && state.status == 'working') ...[
                      const SizedBox(height: 6),
                      Text(
                        '反馈：${state.feedback!}',
                        style: const TextStyle(
                          fontSize: 12,
                          color: AppColors.textSecondary,
                        ),
                      ),
                    ],
                    if (_feedbackOpen && state.status == 'awaiting_acceptance') ...[
                      const SizedBox(height: 8),
                      TextField(
                        controller: _feedbackController,
                        minLines: 2,
                        maxLines: 4,
                        enabled: !busy,
                        contextMenuBuilder: buildChineseTextSelectionMenu,
                        decoration: InputDecoration(
                          hintText: '还需要改什么？',
                          isDense: true,
                          filled: true,
                          fillColor: AppColors.surfaceSubtle,
                          contentPadding: const EdgeInsets.all(10),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(10),
                          ),
                        ),
                      ),
                      const SizedBox(height: 6),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          TextButton(
                            onPressed: busy
                                ? null
                                : () {
                                    setState(() {
                                      _feedbackOpen = false;
                                      _feedbackController.clear();
                                    });
                                  },
                            child: const Text('取消'),
                          ),
                          const SizedBox(width: 6),
                          FilledButton(
                            onPressed: busy
                                ? null
                                : () => _run(
                                      'reject',
                                      feedback: _feedbackController.text,
                                    ),
                            child: const Text('确认打回'),
                          ),
                        ],
                      ),
                    ],
                    if (!state.isTerminal) ...[
                      const SizedBox(height: 8),
                      Wrap(
                        alignment: WrapAlignment.end,
                        spacing: 8,
                        runSpacing: 6,
                        children: [
                          OutlinedButton(
                            onPressed: busy ? null : () => _run('stop'),
                            style: OutlinedButton.styleFrom(
                              visualDensity: VisualDensity.compact,
                              foregroundColor: AppColors.danger,
                              side: const BorderSide(color: AppColors.dangerBorder),
                            ),
                            child: const Text('停止目标'),
                          ),
                          if (state.status == 'awaiting_acceptance') ...[
                            OutlinedButton(
                              onPressed: busy
                                  ? null
                                  : () => setState(
                                        () => _feedbackOpen = !_feedbackOpen,
                                      ),
                              style: OutlinedButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                              ),
                              child: const Text('打回修改'),
                            ),
                            FilledButton(
                              onPressed: busy ? null : () => _run('accept'),
                              style: FilledButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                              ),
                              child: const Text('验收通过'),
                            ),
                          ] else if (state.status == 'budget_exhausted') ...[
                            OutlinedButton(
                              onPressed: busy ? null : () => _run('accept'),
                              style: OutlinedButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                              ),
                              child: const Text('验收通过'),
                            ),
                            FilledButton(
                              onPressed: busy ? null : () => _run('extend'),
                              style: FilledButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                              ),
                              child: const Text('追加预算'),
                            ),
                          ],
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Acceptance-criteria checklist drawn as a vertical progress rail: a node
/// per criterion, connected by a line whose segments are solid when met.
/// Mirrors the desktop `ProgressRail` visual language.
class _CriteriaRail extends StatelessWidget {
  final List<({String criterion, bool met, String evidence})> items;

  const _CriteriaRail({required this.items});

  static const _nodeSize = 15.0;
  static const _rowGap = 7.0;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: _nodeSize,
          child: Column(
            children: [
              for (var index = 0; index < items.length; index++)
                _railSegment(index),
            ],
          ),
        ),
        const SizedBox(width: _rowGap),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var index = 0; index < items.length; index++)
                Padding(
                  padding: EdgeInsets.only(
                    top: index == 0 ? 0 : 7,
                    bottom: index == items.length - 1 ? 0 : 7,
                  ),
                  child: _itemText(index),
                ),
            ],
          ),
        ),
      ],
    );
  }

  /// One rail slice: connector from the previous node, then this node.
  Widget _railSegment(int index) {
    final met = items[index].met;
    return Column(
      children: [
        if (index > 0)
          Container(
            width: 2,
            height: 7,
            margin: const EdgeInsets.symmetric(vertical: 1),
            color: items[index - 1].met ? AppColors.success : AppColors.border,
          ),
        Container(
          width: _nodeSize,
          height: _nodeSize,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: met ? AppColors.success : Colors.transparent,
            border: met ? null : Border.all(color: AppColors.border, width: 1.5),
          ),
          alignment: Alignment.center,
          child: met
              ? const Icon(
                  Icons.check_rounded,
                  size: 11,
                  color: Colors.white,
                )
              : null,
        ),
      ],
    );
  }

  Widget _itemText(int index) {
    final item = items[index];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          item.criterion,
          style: TextStyle(
            fontSize: 12.5,
            height: 1.4,
            color: item.met ? AppColors.textPrimary : AppColors.textSecondary,
          ),
        ),
        if (item.evidence.isNotEmpty)
          Text(
            item.evidence,
            style: const TextStyle(
              fontSize: 11,
              height: 1.35,
              color: AppColors.textMuted,
            ),
          ),
      ],
    );
  }
}
