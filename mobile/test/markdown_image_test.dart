/// Markdown images in chat bubbles.
///
/// The agent's usual way of "sending" a picture is not an image content block
/// but a line of prose: `![CarHome 当前图标](D:\work\app\res\icon-512.png)`.
/// The renderer used to feed that to the link rule, so the phone showed
/// `!CarHome 当前图标` in blue and never the picture.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/widgets/markdown_text.dart';

const baseStyle = TextStyle(fontSize: 13, height: 1.35);

/// A builder that records what it was asked to render and draws a stand-in
/// picture, so the tests assert on the renderer alone.
List<(String alt, String target)> asked = [];

Widget? recordImage(String alt, String target) {
  asked.add((alt, target));
  return SizedBox(key: ValueKey('img:$target'), width: 40, height: 30);
}

Future<void> pump(WidgetTester tester, String markdown) async {
  asked = [];
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: MarkdownText(data: markdown, baseStyle: baseStyle, buildImage: recordImage),
      ),
    ),
  );
  await tester.pump();
}

Finder picture(String target) => find.byKey(ValueKey('img:$target'));

void main() {
  group('image syntax is recognised', () {
    testWidgets('a Windows drive path renders a picture, not a link', (tester) async {
      await pump(tester, r'当前 logo：' '\n' r'![CarHome 当前图标](D:\work\carhome\res\icon-512.png)');

      expect(picture(r'D:\work\carhome\res\icon-512.png'), findsOneWidget);
      expect(asked.single.$1, 'CarHome 当前图标');
      // The alt must not be left behind as a blue link with a stray "!".
      expect(find.textContaining('!CarHome', findRichText: true), findsNothing);
      expect(find.textContaining('CarHome', findRichText: true), findsNothing);
      expect(find.textContaining('当前 logo', findRichText: true), findsOneWidget);
    });

    testWidgets('the target reaches the builder exactly as written', (tester) async {
      await pump(tester, r'![预览](res/mipmap-xxxhdpi/ic_launcher.png)');

      expect(asked.single, ('预览', 'res/mipmap-xxxhdpi/ic_launcher.png'));
    });

    testWidgets('a relative path and a file URL are handed over too', (tester) async {
      await pump(tester, '![a](./design/a.png)\n\n![b](file:///D:/pics/b.png)');

      expect(asked, [('a', './design/a.png'), ('b', 'file:///D:/pics/b.png')]);
      expect(picture('./design/a.png'), findsOneWidget);
      expect(picture('file:///D:/pics/b.png'), findsOneWidget);
    });

    testWidgets('an empty alt is allowed', (tester) async {
      await pump(tester, '![](D:\\a.png)');

      expect(asked.single.$1, '');
      expect(picture(r'D:\a.png'), findsOneWidget);
    });

    testWidgets('a path with spaces is kept whole', (tester) async {
      await pump(tester, r'![a](D:\my pics\a b.png)');

      expect(asked.single.$2, r'D:\my pics\a b.png');
    });

    testWidgets('two pictures on one line render in order', (tester) async {
      await pump(tester, r'对比 ![前](D:\before.png) 和 ![后](D:\after.png)');

      final before = tester.getTopLeft(picture(r'D:\before.png'));
      final after = tester.getTopLeft(picture(r'D:\after.png'));
      expect(after.dy, greaterThan(before.dy), reason: 'pictures stack in reading order');
      expect(find.textContaining('对比', findRichText: true), findsOneWidget);
      expect(find.textContaining('和', findRichText: true), findsOneWidget);
    });

    testWidgets('a picture among paragraphs stays in place', (tester) async {
      await pump(tester, '第一段\n\n![a](D:\\a.png)\n\n第二段');

      expect(find.textContaining('第一段', findRichText: true), findsOneWidget);
      expect(find.textContaining('第二段', findRichText: true), findsOneWidget);
      final first = tester.getTopLeft(find.textContaining('第一段', findRichText: true));
      final last = tester.getTopLeft(find.textContaining('第二段', findRichText: true));
      final middle = tester.getTopLeft(picture(r'D:\a.png'));
      expect(middle.dy, greaterThan(first.dy));
      expect(last.dy, greaterThan(middle.dy));
    });

    testWidgets('a picture inside a list item keeps its marker', (tester) async {
      await pump(tester, '- 第一张 ![a](D:\\a.png)');

      expect(find.text('•'), findsOneWidget);
      expect(picture(r'D:\a.png'), findsOneWidget);
      expect(find.textContaining('第一张', findRichText: true), findsOneWidget);
    });
  });

  group('things that must stay as they were', () {
    testWidgets('a real link is still a link', (tester) async {
      await pump(tester, '看[文档](https://example.com/a)这里');

      expect(asked, isEmpty);
      expect(find.textContaining('文档', findRichText: true), findsOneWidget);
    });

    testWidgets('an image inside a code fence is code', (tester) async {
      await pump(tester, '```\n![not an image](D:\\a.png)\n```');

      expect(asked, isEmpty);
      expect(find.textContaining('not an image'), findsOneWidget);
    });

    testWidgets('inline code is not an image', (tester) async {
      await pump(tester, '写法是 `![x](D:\\a.png)`');

      expect(asked, isEmpty);
      // The syntax is still there, as one code span inside the line.
      final text = tester.widget<RichText>(find.byType(RichText)).text.toPlainText();
      expect(text, '写法是 ![x](D:\\a.png)');
    });

    testWidgets('a header does not take a picture', (tester) async {
      await pump(tester, '# ![x](D:\\a.png)');

      expect(asked, isEmpty);
    });

    testWidgets('without a builder the syntax stays as literal text', (tester) async {
      await tester.pumpWidget(
        MaterialApp(home: Scaffold(body: MarkdownText(data: r'![a](D:\a.png)', baseStyle: baseStyle))),
      );
      await tester.pump();

      expect(find.textContaining('![a]', findRichText: true), findsOneWidget);
    });

    testWidgets('a builder that declines leaves the syntax as written', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MarkdownText(data: '![x](https://example.com/a.png)', baseStyle: baseStyle, buildImage: (_, _) => null),
          ),
        ),
      );
      await tester.pump();

      // Falls back to the plain text, where the link rule shows the alt.
      expect(find.textContaining('x', findRichText: true), findsOneWidget);
    });

    testWidgets('bold and italics still work on a line with a picture', (tester) async {
      await pump(tester, r'**粗体** 和 *斜体* ![a](D:\a.png)');

      final rich = tester.widget<RichText>(find.byType(RichText).first);
      final text = rich.text.toPlainText();
      expect(text, contains('粗体'));
      expect(text, contains('斜体'));
    });
  });
}
