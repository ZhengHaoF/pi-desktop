import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/device_label.dart';

void main() {
  group('composeDeviceLabel', () {
    test('model + Android release', () {
      expect(
        composeDeviceLabel(
          manufacturer: 'Google',
          model: 'Pixel 8',
          androidRelease: '15',
        ),
        'Google Pixel 8 · Android 15',
      );
    });

    test('prefixes the vendor when the model is a bare code name', () {
      // Build.MODEL on many OEM builds is only the internal code.
      expect(
        composeDeviceLabel(
          manufacturer: 'samsung',
          model: 'SM-S918B',
          androidRelease: '14',
        ),
        'samsung SM-S918B · Android 14',
      );
      expect(
        composeDeviceLabel(
          manufacturer: 'Xiaomi',
          model: '23127PN0CC',
          androidRelease: '15',
        ),
        'Xiaomi 23127PN0CC · Android 15',
      );
    });

    test('does not repeat a vendor already inside the model', () {
      expect(
        composeDeviceLabel(
          manufacturer: 'Google',
          model: 'Google Pixel 8 Pro',
          androidRelease: '15',
        ),
        'Google Pixel 8 Pro · Android 15',
      );
      expect(
        composeDeviceLabel(
          manufacturer: 'Xiaomi',
          model: 'Xiaomi 14 Ultra',
          androidRelease: '14',
        ),
        'Xiaomi 14 Ultra · Android 14',
      );
    });

    test('falls back gracefully when parts are missing', () {
      expect(composeDeviceLabel(model: 'Pixel 8'), 'Pixel 8');
      expect(composeDeviceLabel(manufacturer: 'Google'), 'Google');
      expect(composeDeviceLabel(androidRelease: '15'), fallbackDeviceLabel);
      expect(composeDeviceLabel(), fallbackDeviceLabel);
      expect(
        composeDeviceLabel(
          manufacturer: '  ',
          model: '  ',
          androidRelease: '15',
        ),
        fallbackDeviceLabel,
      );
    });

    test('caps the length the relay persists and the desktop renders', () {
      final label = composeDeviceLabel(
        manufacturer: 'VeryLongVendorName',
        model: 'ExtremelyLongModelNameThatKeepsGoingAndGoing',
        androidRelease: '15',
      );
      expect(label.length, maxDeviceLabelLength);
    });
  });
}
