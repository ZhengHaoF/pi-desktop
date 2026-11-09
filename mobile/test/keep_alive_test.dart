import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/keep_alive.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('keep-alive defaults to enabled and persists toggles', () async {
    expect(await keepAliveEnabled(), isTrue);

    await setKeepAliveEnabled(false);
    expect(await keepAliveEnabled(), isFalse);

    await setKeepAliveEnabled(true);
    expect(await keepAliveEnabled(), isTrue);
  });
}