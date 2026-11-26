/// Resolving a Markdown image target to a path on the PC. The rules follow the
/// desktop `resolveLocalFileHref` so the phone shows the same pictures the
/// desktop does, and fetches nothing for the references the desktop declines.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/widgets/image_block.dart';

void main() {
  const cwd = r'D:\work\carhome';

  group('local files resolve to a PC path', () {
    test('a Windows drive path with backslashes', () {
      expect(resolveLocalImagePath(r'D:\work\carhome\res\icon-512.png'), r'D:/work/carhome/res/icon-512.png');
    });

    test('a Windows drive path with forward slashes', () {
      expect(resolveLocalImagePath('D:/work/carhome/res/icon-512.png'), 'D:/work/carhome/res/icon-512.png');
    });

    test('a lowercase drive letter keeps the path', () {
      expect(resolveLocalImagePath(r'd:\pics\a.png'), 'D:/pics/a.png'.replaceAll('D:', 'd:'));
    });

    test('a file URL', () {
      expect(resolveLocalImagePath('file:///D:/work/carhome/res/a.png'), 'D:/work/carhome/res/a.png');
    });

    test('a POSIX absolute path', () {
      expect(resolveLocalImagePath('/home/me/pics/a.png'), '/home/me/pics/a.png');
    });

    test('a relative path resolves against the session cwd', () {
      expect(resolveLocalImagePath('res/mipmap-xxxhdpi/ic_launcher.png', cwd: cwd), 'D:/work/carhome/res/mipmap-xxxhdpi/ic_launcher.png');
    });

    test('a ./ and ../ relative path is normalised', () {
      expect(resolveLocalImagePath('./design/../res/a.png', cwd: cwd), 'D:/work/carhome/res/a.png');
    });

    test('a path with a title after it drops the title', () {
      expect(resolveLocalImagePath(r'D:\pics\a.png "the logo"'), 'D:/pics/a.png');
    });

    test('a path with an anchor or query drops it', () {
      expect(resolveLocalImagePath('D:/pics/a.png#frag'), 'D:/pics/a.png');
      expect(resolveLocalImagePath('D:/pics/a.png?v=2'), 'D:/pics/a.png');
    });

    test('duplicate slashes and dot segments collapse', () {
      expect(resolveLocalImagePath('D://pics//./a.png'), 'D:/pics/a.png');
    });

    test('a percent-encoded path is decoded', () {
      expect(resolveLocalImagePath('D:/pics/my%20logo.png'), 'D:/pics/my logo.png');
    });

    test('spaces inside the path are kept (Markdown allows them unencoded)', () {
      expect(resolveLocalImagePath(r'D:\my pics\a b.png'), 'D:/my pics/a b.png');
    });
  });

  group('not a local file: nothing is fetched', () {
    test('a web URL', () {
      expect(resolveLocalImagePath('https://example.com/a.png'), isNull);
    });

    test('a data URL (already inline, and not a file)', () {
      expect(resolveLocalImagePath('data:image/png;base64,AAAA'), isNull);
    });

    test('a protocol-relative URL names a host, not the PC', () {
      expect(resolveLocalImagePath('//example.com/a.png'), isNull);
    });

    test('app-internal routes', () {
      expect(resolveLocalImagePath('/api/files/a.png'), isNull);
      expect(resolveLocalImagePath('/_next/image?url=a.png'), isNull);
    });

    test('an empty target', () {
      expect(resolveLocalImagePath(''), isNull);
      expect(resolveLocalImagePath('   '), isNull);
    });

    test('a bare word with no cwd to resolve against', () {
      expect(resolveLocalImagePath('a.png'), isNull);
    });

    test('a bare word that does not look like a file', () {
      expect(resolveLocalImagePath('notes', cwd: cwd), isNull);
    });
  });

  group('a relative path may not leave the session directory', () {
    test('climbing above the cwd is refused', () {
      expect(resolveLocalImagePath('../secrets/a.png', cwd: cwd), isNull);
    });

    test('a sneaky in-path climb is refused', () {
      expect(resolveLocalImagePath('res/../../other/a.png', cwd: cwd), isNull);
    });

    test('staying inside is allowed', () {
      expect(resolveLocalImagePath('res/../design/a.png', cwd: cwd), 'D:/work/carhome/design/a.png');
    });

    test('an absolute path is not subject to the cwd limit', () {
      expect(resolveLocalImagePath('E:/elsewhere/a.png', cwd: cwd), 'E:/elsewhere/a.png');
    });
  });
}
