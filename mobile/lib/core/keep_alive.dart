/// 息屏保活：Android 前台服务 + WifiLock，防止息屏/后台时 WS 连接被系统冻结。
///
/// 服务只持有进程存活与网络锁，WS 连接仍由 UI isolate 的 RemoteConnection
/// 管理——跨 isolate 搬运连接收益低、破坏面大，不做。
library;

import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _kKeepAliveEnabled = 'remote.keepAlive';

/// 插件要求注册的后台任务体：保活场景下不执行任何周期任务。
class KeepAliveTaskHandler extends TaskHandler {
  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {}

  @override
  void onRepeatEvent(DateTime timestamp) {}

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {}
}

/// 后台 isolate 入口：TaskHandler 必须在服务 isolate 里注册（11.x 约定）。
@pragma('vm:entry-point')
void keepAliveCallback() {
  FlutterForegroundTask.setTaskHandler(KeepAliveTaskHandler());
}

/// main() 里调用一次：初始化服务参数与 isolate 通信端口。
/// 不在此处 setTaskHandler——那是服务 isolate 的职责，主 isolate 注册会向
/// 主引擎发一个无 handler 的 start 调用（MissingPluginException 噪音）。
void initKeepAlive() {
  FlutterForegroundTask.initCommunicationPort();
  FlutterForegroundTask.init(
    androidNotificationOptions: AndroidNotificationOptions(
      channelId: 'pi_remote_link',
      channelName: '远程连接',
      channelDescription: '保持手机与电脑的连接（息屏不断链）',
      onlyAlertOnce: true,
    ),
    iosNotificationOptions: const IOSNotificationOptions(showNotification: false, playSound: false),
    foregroundTaskOptions: ForegroundTaskOptions(
      eventAction: ForegroundTaskEventAction.nothing(),
      autoRunOnBoot: false,
      autoRunOnMyPackageReplaced: false,
      allowWakeLock: true,
      allowWifiLock: true,
    ),
  );
}

/// 用户开关（手机端本地偏好，默认开启——远程控制的核心场景就是息屏待命）。
Future<bool> keepAliveEnabled() async {
  final prefs = await SharedPreferences.getInstance();
  return prefs.getBool(_kKeepAliveEnabled) ?? true;
}

Future<void> setKeepAliveEnabled(bool enabled) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setBool(_kKeepAliveEnabled, enabled);
}

Future<void> startKeepAlive() async {
  if (await FlutterForegroundTask.isRunningService) return;
  final permission = await FlutterForegroundTask.checkNotificationPermission();
  if (permission != NotificationPermission.granted) {
    await FlutterForegroundTask.requestNotificationPermission();
  }
  await FlutterForegroundTask.startService(
    serviceTypes: [ForegroundServiceTypes.connectedDevice],
    notificationTitle: 'Pi Remote 连接中',
    notificationText: '保持与电脑的连接，息屏不中断',
    callback: keepAliveCallback,
  );
}

Future<void> stopKeepAlive() async {
  if (await FlutterForegroundTask.isRunningService) {
    await FlutterForegroundTask.stopService();
  }
}