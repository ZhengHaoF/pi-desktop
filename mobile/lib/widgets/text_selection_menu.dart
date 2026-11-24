/// 全 App 统一的文本长按菜单（中文、四项）。
///
/// Flutter 默认的文本选择工具条来自 [DefaultMaterialLocalizations]：本项目没
/// 有接入 `flutter_localizations`，所以按钮标签是英文的 Cut / Copy / Paste /
/// Share / Select all；而 Android 上 [EditableText] 还会把系统里注册了
/// `ACTION_PROCESS_TEXT` 的应用（比如「木函翻译」）追加进同一个工具条。中英
/// 混排加上一长串条目，用起来很吵。
///
/// 这里接管 `contextMenuBuilder`，只给出四项中文按钮。给所有 TextField 用同一
/// 个 builder，菜单行为才一致。
library;

import 'package:flutter/material.dart';

Widget buildChineseTextSelectionMenu(BuildContext context, EditableTextState state) {
  final buttonItems = <ContextMenuButtonItem>[
    if (state.cutEnabled)
      ContextMenuButtonItem(
        label: '剪切',
        onPressed: () => state.cutSelection(SelectionChangedCause.toolbar),
      ),
    if (state.copyEnabled)
      ContextMenuButtonItem(
        label: '复制',
        onPressed: () => state.copySelection(SelectionChangedCause.toolbar),
      ),
    if (state.pasteEnabled)
      ContextMenuButtonItem(
        label: '粘贴',
        onPressed: () => state.pasteText(SelectionChangedCause.toolbar),
      ),
    if (state.selectAllEnabled)
      ContextMenuButtonItem(
        label: '全选',
        onPressed: () => state.selectAll(SelectionChangedCause.toolbar),
      ),
  ];
  return AdaptiveTextSelectionToolbar.buttonItems(
    anchors: state.contextMenuAnchors,
    buttonItems: buttonItems,
  );
}
