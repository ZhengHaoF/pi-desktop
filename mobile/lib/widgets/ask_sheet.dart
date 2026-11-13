/// Ask-question mirror of the desktop `ask_question` tool, rendered as a
/// bottom sheet. Wire shape mirrors packages/protocol ApprovalRequestData
/// (`method: "ask"`); answers go back in request order as
/// `{header, question, selected, other?}`.
library;

import 'package:flutter/material.dart';

class AskOptionData {
  const AskOptionData({required this.label, this.description});

  final String label;
  final String? description;
}

class AskQuestionData {
  const AskQuestionData({
    required this.question,
    required this.options,
    this.header,
    this.multiSelect = false,
  });

  final String? header;
  final String question;
  final List<AskOptionData> options;
  final bool multiSelect;
}

/// Strict parse: null means the payload is unusable, so the caller can settle
/// the request instead of showing an empty sheet forever.
List<AskQuestionData>? parseAskQuestions(Object? raw) {
  if (raw is! List || raw.isEmpty) return null;
  final questions = <AskQuestionData>[];
  for (final entry in raw) {
    if (entry is! Map) return null;
    final text = entry['question'];
    if (text is! String || text.trim().isEmpty) return null;
    final rawOptions = entry['options'];
    if (rawOptions is! List || rawOptions.isEmpty) return null;
    final options = <AskOptionData>[];
    for (final option in rawOptions) {
      if (option is! Map) return null;
      final label = option['label'];
      if (label is! String || label.isEmpty) return null;
      final description = option['description'];
      options.add(AskOptionData(
        label: label,
        description: description is String && description.isNotEmpty ? description : null,
      ));
    }
    final header = entry['header'];
    questions.add(AskQuestionData(
      header: header is String && header.trim().isNotEmpty ? header : null,
      question: text,
      options: options,
      multiSelect: entry['multiSelect'] == true,
    ));
  }
  return questions;
}

/// One question's in-progress answer.
class AskDraft {
  AskDraft(this.question);

  final AskQuestionData question;
  final Set<String> selected = <String>{};
  String other = '';
  bool otherActive = false;

  bool get complete => selected.isNotEmpty || other.trim().isNotEmpty;

  void choose(String label) {
    if (question.multiSelect) {
      if (!selected.remove(label)) selected.add(label);
      return;
    }
    selected
      ..clear()
      ..add(label);
    other = '';
    otherActive = false;
  }

  void toggleOther() {
    if (otherActive) {
      otherActive = false;
      other = '';
      return;
    }
    otherActive = true;
    if (!question.multiSelect) selected.clear();
  }

  Map<String, dynamic> toAnswer() => {
        if (question.header != null) 'header': question.header,
        'question': question.question,
        'selected': selected.toList(growable: false),
        if (other.trim().isNotEmpty) 'other': other.trim(),
      };
}

/// Answers in request order, or null while any question is unanswered.
List<Map<String, dynamic>>? askAnswers(List<AskDraft> drafts) {
  if (drafts.any((draft) => !draft.complete)) return null;
  return drafts.map((draft) => draft.toAnswer()).toList(growable: false);
}

/// Shows the sheet and resolves with answers, or null when the user cancels.
/// `resolvedElsewhere` flips when the desktop (or another device) answered,
/// which closes the sheet without sending a second response.
Future<List<Map<String, dynamic>>?> showAskSheet({
  required BuildContext context,
  required List<AskQuestionData> questions,
  String title = 'AI 需要你的选择',
  ValueNotifier<bool>? resolvedElsewhere,
}) {
  return showModalBottomSheet<List<Map<String, dynamic>>>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
    builder: (sheetContext) => AskSheet(
      questions: questions,
      title: title,
      resolvedElsewhere: resolvedElsewhere,
    ),
  );
}

class AskSheet extends StatefulWidget {
  const AskSheet({
    super.key,
    required this.questions,
    this.title = 'AI 需要你的选择',
    this.resolvedElsewhere,
  });

  final List<AskQuestionData> questions;
  final String title;
  final ValueNotifier<bool>? resolvedElsewhere;

  @override
  State<AskSheet> createState() => _AskSheetState();
}

class _AskSheetState extends State<AskSheet> {
  late final List<AskDraft> _drafts = widget.questions.map(AskDraft.new).toList(growable: false);

  @override
  void initState() {
    super.initState();
    widget.resolvedElsewhere?.addListener(_closeIfResolved);
    // The dialog may already have settled before the sheet mounted.
    WidgetsBinding.instance.addPostFrameCallback((_) => _closeIfResolved());
  }

  @override
  void dispose() {
    widget.resolvedElsewhere?.removeListener(_closeIfResolved);
    super.dispose();
  }

  void _closeIfResolved() {
    if (!mounted || widget.resolvedElsewhere?.value != true) return;
    Navigator.of(context).pop();
  }

  void _submit() {
    final answers = askAnswers(_drafts);
    if (answers == null) return;
    Navigator.of(context).pop(answers);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final canSubmit = _drafts.every((draft) => draft.complete);
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.82),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(widget.title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 2),
                  const Text('选择一个选项，或自己输入回答', style: TextStyle(fontSize: 11, color: Colors.black45)),
                ],
              ),
            ),
            const Divider(height: 1),
            Flexible(
              child: ListView.separated(
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                itemCount: widget.questions.length,
                separatorBuilder: (_, _) => const SizedBox(height: 18),
                itemBuilder: (context, index) => _QuestionBlock(
                  draft: _drafts[index],
                  onChanged: () => setState(() {}),
                ),
              ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('取消'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: canSubmit ? _submit : null,
                    style: FilledButton.styleFrom(backgroundColor: theme.colorScheme.primary),
                    child: const Text('提交'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _QuestionBlock extends StatelessWidget {
  const _QuestionBlock({required this.draft, required this.onChanged});

  final AskDraft draft;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final question = draft.question;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (question.header != null)
          Container(
            margin: const EdgeInsets.only(bottom: 6),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(color: Colors.blue.shade50, borderRadius: BorderRadius.circular(999)),
            child: Text(
              question.header!,
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Colors.blue.shade700),
            ),
          ),
        Text(question.question, style: const TextStyle(fontSize: 14, height: 1.45)),
        const SizedBox(height: 4),
        Text(
          question.multiSelect ? '可多选' : '单选',
          style: const TextStyle(fontSize: 11, color: Colors.black38),
        ),
        const SizedBox(height: 8),
        for (final option in question.options)
          _OptionRow(
            label: option.label,
            description: option.description,
            checked: draft.selected.contains(option.label),
            onTap: () {
              draft.choose(option.label);
              onChanged();
            },
          ),
        _OptionRow(
          label: '其他…',
          checked: draft.otherActive,
          onTap: () {
            draft.toggleOther();
            onChanged();
          },
        ),
        if (draft.otherActive)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: TextField(
              autofocus: true,
              decoration: const InputDecoration(
                isDense: true,
                border: OutlineInputBorder(),
                hintText: '输入你的回答',
              ),
              onChanged: (value) {
                draft.other = value;
                onChanged();
              },
            ),
          ),
      ],
    );
  }
}

class _OptionRow extends StatelessWidget {
  const _OptionRow({
    required this.label,
    required this.checked,
    required this.onTap,
    this.description,
  });

  final String label;
  final String? description;
  final bool checked;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final primary = Theme.of(context).colorScheme.primary;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: checked ? primary : Colors.black12, width: checked ? 1.4 : 1),
          color: checked ? primary.withValues(alpha: 0.06) : Colors.white,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              checked ? Icons.check_circle : Icons.radio_button_unchecked,
              size: 18,
              color: checked ? primary : Colors.black26,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: const TextStyle(fontSize: 13.5)),
                  if (description != null)
                    Text(
                      description!,
                      style: const TextStyle(fontSize: 11, color: Colors.black45, height: 1.4),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}