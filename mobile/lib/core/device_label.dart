/// 配对设备显示名：把「哪台手机」写进 hello 的 label。
///
/// relay 只在配对那一刻把 label 落库（server/src/pairing.ts），桌面端
/// 「设备配对」列表照搬显示；写死 "Pi Go (Android)" 时多台手机全叫同一个
/// 名字，用户没法区分该撤销哪一台。
library;

import 'package:device_info_plus/device_info_plus.dart';

/// 解析失败或非 Android 平台的兜底：保持历史标签，不让连接因此失败。
const String fallbackDeviceLabel = 'Pi Go (Android)';

/// label 会原样进入 relay 的配对表与诊断日志，桌面端也按单行渲染，
/// 所以留一个有上限的短名字。
const int maxDeviceLabelLength = 48;

/// 纯函数便于单测：`Pixel 8 · Android 15`。
///
/// 型号必须带厂商：Android 的 Build.MODEL 对国产机型常常只是
/// `SM-S918B` / `23127PN0CC` 这类代号，脱离厂商名无法辨认。
String composeDeviceLabel({
  String? manufacturer,
  String? model,
  String? androidRelease,
}) {
  final hardware = _hardwareName(manufacturer: manufacturer, model: model);
  if (hardware.isEmpty) return fallbackDeviceLabel;
  final release = androidRelease?.trim() ?? '';
  final label = release.isEmpty ? hardware : '$hardware · Android $release';
  return label.length <= maxDeviceLabelLength
      ? label
      : label.substring(0, maxDeviceLabelLength);
}

String _hardwareName({String? manufacturer, String? model}) {
  final m = model?.trim() ?? '';
  final maker = manufacturer?.trim() ?? '';
  if (m.isEmpty) return maker;
  if (maker.isEmpty) return m;
  // 型号已含厂商名（如 "Google Pixel 8"）时不再重复前缀。
  if (m.toLowerCase().contains(maker.toLowerCase())) return m;
  return '$maker $m';
}

/// 读本机型号 + 系统版本；插件缺失/平台不支持时不抛错，退回兜底标签。
Future<String> resolveDeviceLabel() async {
  try {
    final info = await DeviceInfoPlugin().androidInfo;
    return composeDeviceLabel(
      manufacturer: info.manufacturer,
      model: info.model,
      androidRelease: info.version.release,
    );
  } catch (_) {
    return fallbackDeviceLabel;
  }
}
