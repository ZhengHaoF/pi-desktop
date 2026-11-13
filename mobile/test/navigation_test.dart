import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/navigation.dart';

/// 造一个带 AppBar 的页面：AppBar 的隐式返回箭头只跟随 canPop，所以用它
/// 就能看出栈里是否残留了旧路由。
Widget _page(String title, String body) => Scaffold(
      appBar: AppBar(title: Text(title)),
      body: Text(body),
    );

/// 首页必须永远是根路由：栈底残留旧页面会让 AppBar 画出返回箭头，系统
/// 返回键还会退到一个连接已断开的死页面。
void main() {
  testWidgets('pushAsRoot leaves a single route with no back affordance', (tester) async {
    await tester.pumpWidget(MaterialApp(home: _page('连接', 'connect')));
    final nav = tester.state<NavigatorState>(find.byType(Navigator));
    expect(nav.canPop(), isFalse);

    pushAsRoot(tester.element(find.text('connect')), _page('首页', 'home'));
    await tester.pumpAndSettle();

    expect(find.text('首页'), findsOneWidget);
    expect(nav.canPop(), isFalse, reason: '首页应当不可返回');
    expect(find.byType(BackButton), findsNothing);
  });

  testWidgets('disconnect-then-connect still ends with a single home route', (tester) async {
    // 复现旧 bug 的完整路径：首页 → 设置（push）→ 断开返回 → 再连接。
    // 旧实现两处都用 pushReplacement，旧首页会残留在栈底。
    await tester.pumpWidget(MaterialApp(home: _page('连接', 'connect')));
    final nav = tester.state<NavigatorState>(find.byType(Navigator));

    pushAsRoot(tester.element(find.text('connect')), _page('首页', 'home'));
    await tester.pumpAndSettle();

    // 首页 → 设置
    Navigator.of(tester.element(find.text('首页'))).push(
      MaterialPageRoute<void>(builder: (_) => _page('设置', 'settings')),
    );
    await tester.pumpAndSettle();
    expect(nav.canPop(), isTrue, reason: '设置页是压在首页之上的');

    // 设置 → 断开返回（清栈）
    pushAsRoot(tester.element(find.text('设置')), _page('连接', 'connect2'));
    await tester.pumpAndSettle();
    expect(nav.canPop(), isFalse, reason: '断开后旧的首页必须被清掉');

    // 再连接
    pushAsRoot(tester.element(find.text('connect2')), _page('首页', 'home2'));
    await tester.pumpAndSettle();

    expect(find.byType(BackButton), findsNothing);
    expect(nav.canPop(), isFalse, reason: '反复连接不应让首页变成可返回');
  });
}
