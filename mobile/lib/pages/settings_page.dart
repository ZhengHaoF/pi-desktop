/// Phone-side settings page: link status, keep-alive toggle, security info,
/// version info, and disconnect control.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../core/app_theme.dart';
import '../core/keep_alive.dart';
import '../core/navigation.dart';
import '../core/remote_connection.dart';
import '../widgets/ui_kit.dart';
import 'connect_page.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({
    required this.connection,
    this.embedded = false,
    this.currentHost,
    this.hostDisplayName,
    this.hostCount = 0,
    this.onSwitchHost,
    this.onScanNewHost,
    this.onOpenDrawer,
    super.key,
  });

  final RemoteConnection connection;
  final bool embedded;
  final RemoteHostInfo? currentHost;
  final String? hostDisplayName;
  final int hostCount;
  final VoidCallback? onSwitchHost;
  final VoidCallback? onScanNewHost;
  final VoidCallback? onOpenDrawer;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  bool _reconnecting = false;
  bool _keepAlive = true;
  bool _keepAliveLoading = true;

  @override
  void initState() {
    super.initState();
    keepAliveEnabled().then((enabled) {
      if (mounted) {
        setState(() {
          _keepAlive = enabled;
          _keepAliveLoading = false;
        });
      }
    });
  }

  Future<void> _toggleKeepAlive(bool enabled) async {
    setState(() => _keepAlive = enabled);
    await setKeepAliveEnabled(enabled);
    if (enabled) {
      await startKeepAlive();
    } else {
      await stopKeepAlive();
    }
  }

  Future<void> _reconnect() async {
    setState(() => _reconnecting = true);
    await widget.connection.reconnect();
    if (mounted) setState(() => _reconnecting = false);
  }

  void _disconnectAndExit() {
    widget.connection.disconnect();
    unawaited(stopKeepAlive());
    pushAsRoot(context, const ConnectPage());
  }

  @override
  Widget build(BuildContext context) {
    final hostLabel = widget.hostDisplayName ??
        widget.currentHost?.displayName ??
        widget.connection.hostId ??
        '当前电脑';
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: !widget.embedded,
        leading: widget.onOpenDrawer == null
            ? null
            : IconButton(
                tooltip: '打开工作区侧栏',
                icon: const Icon(Icons.menu_rounded),
                onPressed: widget.onOpenDrawer,
              ),
        title: Text(widget.embedded ? '我的' : '设置'),
      ),
      body: StreamBuilder<LinkState>(
        stream: widget.connection.onState,
        initialData: widget.connection.state,
        builder: (context, snapshot) {
          final state = snapshot.data ?? LinkState.disconnected;
          final connected = state == LinkState.ready;
          final connecting = state == LinkState.connecting;
          final stateLabel = connected ? '已连接' : (connecting ? '连接中…' : '未连接');
          final stateColor = connected ? AppColors.success : (connecting ? AppColors.warning : AppColors.danger);
          final stateBg = connected ? AppColors.successBg : (connecting ? AppColors.warningBg : AppColors.dangerBg);
          return ListView(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 28),
            children: [
              if (widget.onSwitchHost != null || widget.onScanNewHost != null)
                _sectionCard(
                  title: '我的设备',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Container(
                            width: 38,
                            height: 38,
                            decoration: BoxDecoration(
                              color: AppColors.brandSoft,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: const Icon(
                              Icons.computer_rounded,
                              size: 20,
                              color: AppColors.brand,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  hostLabel,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 15,
                                    fontWeight: FontWeight.w600,
                                    color: AppColors.textPrimary,
                                  ),
                                ),
                                Text(
                                  widget.hostCount > 1
                                      ? '已管理 ${widget.hostCount} 台电脑设备'
                                      : '支持多台电脑扫码配对切换',
                                  style: const TextStyle(
                                    fontSize: 12,
                                    color: AppColors.textMuted,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          if (widget.onSwitchHost != null)
                            Expanded(
                              child: OutlinedButton.icon(
                                onPressed: widget.onSwitchHost,
                                icon: const Icon(Icons.devices_rounded, size: 17),
                                label: const Text('管理 / 切换电脑'),
                              ),
                            ),
                          if (widget.onSwitchHost != null && widget.onScanNewHost != null)
                            const SizedBox(width: 10),
                          if (widget.onScanNewHost != null)
                            Expanded(
                              child: FilledButton.tonalIcon(
                                onPressed: widget.onScanNewHost,
                                icon: const Icon(Icons.qr_code_scanner_rounded, size: 17),
                                label: const Text('扫码配对'),
                              ),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              _sectionCard(
                title: '连接状态',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        StatusDot(color: stateColor, size: 8, active: connected),
                        const SizedBox(width: 8),
                        StatusBadge(label: stateLabel, foreground: stateColor, background: stateBg),
                        const Spacer(),
                        TextButton.icon(
                          onPressed: _reconnecting ? null : _reconnect,
                          icon: const Icon(Icons.refresh_rounded, size: 16),
                          label: Text(_reconnecting ? '重连中…' : '重新连接'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    const Divider(height: 1),
                    const SizedBox(height: 10),
                    _kv('Relay 地址', widget.connection.relayUrl),
                    _kv('设备标识', widget.connection.deviceId),
                    _kv('Host ID', widget.connection.hostId ?? '尚未分配'),
                  ],
                ),
              ),
              _sectionCard(
                title: '后台保活',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('前台服务保持连接', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                      subtitle: const Text(
                        '息屏或切后台时用前台服务与网络锁维持链路，通知栏会常驻一条状态通知',
                        style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
                      ),
                      value: _keepAlive,
                      onChanged: _keepAliveLoading ? null : _toggleKeepAlive,
                    ),
                    const SizedBox(height: 4),
                    const Text(
                      '小米 / 红米等机型建议在系统设置中开启自启动并设为「无限制」省电策略，避免后台被杀。',
                      style: TextStyle(fontSize: 11.5, color: AppColors.textMuted, height: 1.4),
                    ),
                  ],
                ),
              ),
              _sectionCard(
                title: '安全与配对说明',
                child: const Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '• 手机与电脑间默认启用端到端加密（X25519 + AES-256-GCM），中继服务器仅路由密文信封。',
                      style: TextStyle(fontSize: 12.5, color: AppColors.textSecondary, height: 1.5),
                    ),
                    SizedBox(height: 4),
                    Text(
                      '• 首次连接或主机密钥变更时，需在电脑端打开「设备配对」重新扫码绑定。',
                      style: TextStyle(fontSize: 12.5, color: AppColors.textSecondary, height: 1.5),
                    ),
                  ],
                ),
              ),
              _sectionCard(
                title: '关于',
                child: Column(
                  children: [
                    _kv('应用', 'Pi Go'),
                    _kv('版本', appDisplayVersion),
                  ],
                ),
              ),
              const SizedBox(height: 4),
              OutlinedButton.icon(
                onPressed: _disconnectAndExit,
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(46),
                  backgroundColor: AppColors.dangerBg,
                  foregroundColor: AppColors.danger,
                  side: const BorderSide(color: AppColors.dangerBorder),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                icon: const Icon(Icons.link_off_rounded, size: 18),
                label: const Text('断开连接并返回', style: TextStyle(fontWeight: FontWeight.w600)),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _kv(String key, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 86,
            child: Text(key, style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontSize: 12.5, fontFamily: 'monospace', color: AppColors.textPrimary),
            ),
          ),
        ],
      ),
    );
  }

  Widget _sectionCard({required String title, required Widget child}) {
    return SurfaceCard(
      margin: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }
}
