/// 回归测试：长按菜单只给中文四项，不带英文标签，也不混进系统的
/// ACTION_PROCESS_TEXT 应用（例如「木函翻译」）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/widgets/text_selection_menu.dart';

List<ContextMenuButtonItem> _itemsFor(WidgetTester tester) {
  final state = tester.state<EditableTextState>(find.byType(EditableText));
  final toolbar = buildChineseTextSelectionMenu(tester.element(find.byType(TextField)), state);
  expect(toolbar, isA<AdaptiveTextSelectionToolbar>());
  return (toolbar as AdaptiveTextSelectionToolbar).buttonItems!;
}

void main() {
  testWidgets('选中文字后菜单是中文的剪切/复制/全选，且没有分享与外部应用', (tester) async {
    final controller = TextEditingController(text: 'intervene checkSilentMode give up nlu');
    addTearDown(controller.dispose);
    controller.selection = const TextSelection(baseOffset: 0, extentOffset: 9);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TextField(controller: controller, contextMenuBuilder: buildChineseTextSelectionMenu),
        ),
      ),
    );

    final labels = _itemsFor(tester).map((item) => item.label).toList();
    expect(labels, contains('剪切'));
    expect(labels, contains('复制'));
    expect(labels, contains('全选'));
    expect(labels, isNot(contains('Cut')));
    expect(labels, isNot(contains('Share')));
    expect(labels.length, lessThanOrEqualTo(4), reason: '菜单只保留四项，不追加系统文本处理应用');
  });

  testWidgets('没有选区时不出现剪切/复制', (tester) async {
    final controller = TextEditingController(text: 'abc');
    addTearDown(controller.dispose);
    controller.selection = const TextSelection.collapsed(offset: 3);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TextField(controller: controller, contextMenuBuilder: buildChineseTextSelectionMenu),
        ),
      ),
    );

    final labels = _itemsFor(tester).map((item) => item.label).toList();
    expect(labels, isNot(contains('剪切')));
    expect(labels, isNot(contains('复制')));
    expect(labels, contains('全选'));
  });
}
