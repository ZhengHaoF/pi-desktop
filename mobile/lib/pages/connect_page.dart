/// Connect page: QR pairing first, one-tap quick reconnect for paired hosts,
/// handshake verification before leaving the page, and collapsible manual config.
library;

import 'package:flutter/material.dart';

import '../core/app_theme.dart';
import '../core/device_label.dart';
import '../core/host_store.dart';
import '../core/keep_alive.dart';
import '../core/navigation.dart';
import '../core/remote_connection.dart';
import '../widgets/text_selection_menu.dart';
import '../widgets/ui_kit.dart';
import 'home_page.dart';
import 'scan_page.dart';

/// Factory signature for constructing [RemoteConnection] (overridable in tests).
typedef RemoteConnectionFactory = RemoteConnection Function({
  required String relayUrl,
  required String deviceId,
  required String deviceLabel,
  String? pairingToken,
  String? targetHostId,
});

RemoteConnection _defaultConnectionFactory({
  required String relayUrl,
  required String deviceId,
  required String deviceLabel,
  String? pairingToken,
  String? targetHostId,
}) =>
    RemoteConnection(
      relayUrl: relayUrl,
      deviceId: deviceId,
      deviceLabel: deviceLabel,
      pairingToken: pairingToken,
      targetHostId: targetHostId,
    );

class ConnectPage extends StatefulWidget {
  const ConnectPage({
    this.connectionFactory,
    super.key,
  });

  final RemoteConnectionFactory? connectionFactory;

  @override
  State<ConnectPage> createState() => _ConnectPageState();
}

class _ConnectPageState extends State<ConnectPage> {
  static const String _defaultRelayUrl = 'ws://10.0.2.2:8788/ws';

  final _urlController = TextEditingController(text: _defaultRelayUrl);
  final _deviceController = TextEditingController();
  String? _pairingToken;
  String? _targetHostId;
  String? _savedHostName;
  bool _canQuickReconnect = false;
  bool _advancedExpanded = true;
  LinkState _state = LinkState.disconnected;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadSavedConnectionInfo();
  }

  Future<void> _loadSavedConnectionInfo() async {
    final deviceId = await loadOrCreateDeviceId();
    if (mounted && _deviceController.text.isEmpty) {
      _deviceController.text = deviceId;
    }
    final url = await loadLastRelayUrl();
    final preferredId = await loadPreferredHost();
    final hosts = await loadKnownHosts();
    final pairedIds = url == null ? const <String>{} : await loadPairedHostIds(deviceId, relayUrl: url);
    if (!mounted) return;
    String? hostName;
    if (preferredId != null) {
      for (final h in hosts) {
        if (h.id == preferredId) {
          hostName = h.displayName;
          break;
        }
      }
      hostName ??= preferredId;
    }
    final hasPairedHost = url != null &&
        (preferredId != null ? pairedIds.contains(preferredId) : pairedIds.isNotEmpty);
    setState(() {
      if (url != null) {
        if (_urlController.text == _defaultRelayUrl) _urlController.text = url;
        _advancedExpanded = !hasPairedHost;
      }
      _canQuickReconnect = hasPairedHost;
      _savedHostName = hostName;
    });
  }

  Future<void> _scanQr() async {
    FocusScope.of(context).unfocus();
    final scanned = await Navigator.of(context).push<RelayQrTarget>(
      MaterialPageRoute(builder: (_) => const ScanPage()),
    );
    if (!mounted || scanned == null || scanned.url.isEmpty) return;
    setState(() {
      _urlController.text = scanned.url;
      _pairingToken = scanned.pairingToken;
      _targetHostId = scanned.hostId;
      _error = null;
    });
    if (scanned.e2eePub != null && scanned.hostId != null) {
      await savePinnedHostPub(scanned.hostId!, scanned.e2eePub!, relayUrl: scanned.url);
    }
    await _connect();
  }

  Future<void> _connect() async {
    if (_state == LinkState.connecting) return;
    setState(() {
      _state = LinkState.connecting;
      _error = null;
    });
    final relayUrl = _urlController.text.trim();
    final deviceId = _deviceController.text.trim();
    final factory = widget.connectionFactory ?? _defaultConnectionFactory;
    final connection = factory(
      relayUrl: relayUrl,
      deviceId: deviceId,
      deviceLabel: await resolveDeviceLabel(),
      pairingToken: _pairingToken,
      targetHostId: _targetHostId,
    );
    try {
      final ready = await connection.connectAndWaitHandshake();
      if (!mounted) {
        connection.disconnect();
        return;
      }
      if (!ready) {
        final pairingRejected = connection.lastFailureWasPairingReject;
        final message = connection.describeLastFailure() ?? '连接超时或未响应，请检查 Relay 地址后重试';
        final rejectedHostId = connection.hostId ?? _targetHostId;
        connection.disconnect();
        if (pairingRejected && rejectedHostId != null && rejectedHostId.isNotEmpty) {
          await deleteDeviceSecret(deviceId, relayUrl: relayUrl, hostId: rejectedHostId);
          await deleteCachedSessions(rejectedHostId);
        }
        if (!mounted) return;
        setState(() {
          _state = LinkState.disconnected;
          _error = message;
          if (pairingRejected) {
            _pairingToken = null;
            _canQuickReconnect = false;
          }
        });
        return;
      }
      if (await keepAliveEnabled()) {
        await startKeepAlive();
      }
      if (!mounted) return;
      pushAsRoot(context, HomePage(connection: connection));
    } catch (err) {
      final message = connection.describeLastFailure() ??
          (err is StateError ? err.message.replaceFirst('Bad state: ', '') : err.toString());
      connection.disconnect();
      if (!mounted) return;
      setState(() {
        _state = LinkState.disconnected;
        _error = message;
      });
    }
  }

  @override
  void dispose() {
    _urlController.dispose();
    _deviceController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final connecting = _state == LinkState.connecting;
    final relaySummary = relayScope(_urlController.text.trim());
    return Scaffold(
      appBar: AppBar(title: const Text('Pi Go — 连接')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          children: [
            SurfaceCard(
              padding: const EdgeInsets.all(18),
              child: Row(
                children: [
                  Image.asset(
                    'assets/app_icon.png',
                    width: 52,
                    height: 52,
                    fit: BoxFit.contain,
                  ),
                  const SizedBox(width: 14),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Text(
                              'Pi Go',
                              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: AppColors.textPrimary),
                            ),
                            SizedBox(width: 8),
                            StatusBadge(
                              label: '端到端加密',
                              foreground: AppColors.brandInk,
                              background: AppColors.brandSoft,
                            ),
                          ],
                        ),
                        SizedBox(height: 4),
                        Text(
                          '远程管理电脑端 Pi Agent 会话与任务',
                          style: TextStyle(fontSize: 12.5, color: AppColors.textSecondary),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            SurfaceCard(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  FilledButton.icon(
                    onPressed: connecting ? null : _scanQr,
                    style: FilledButton.styleFrom(
                      backgroundColor: AppColors.brand,
                      minimumSize: const Size.fromHeight(48),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                    icon: const Icon(Icons.qr_code_scanner_rounded, size: 20),
                    label: const Text('扫描电脑屏幕上的二维码', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                  ),
                  if (_canQuickReconnect) ...[
                    const SizedBox(height: 10),
                    OutlinedButton.icon(
                      onPressed: connecting ? null : _connect,
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size.fromHeight(46),
                        side: const BorderSide(color: AppColors.borderStrong),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                      icon: connecting
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.bolt_rounded, size: 19, color: AppColors.brand),
                      label: Text(
                        connecting
                            ? '正在校验配对…'
                            : _savedHostName != null
                                ? '快速重连 $_savedHostName（$relaySummary）'
                                : '快速连接（$relaySummary）',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    ErrorBanner(message: _error!),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 12),
            SurfaceCard(
              padding: EdgeInsets.zero,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  InkWell(
                    onTap: () => setState(() => _advancedExpanded = !_advancedExpanded),
                    borderRadius: BorderRadius.circular(14),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
                      child: Row(
                        children: [
                          const Icon(Icons.tune_rounded, size: 18, color: AppColors.textSecondary),
                          const SizedBox(width: 8),
                          const Text(
                            '手动配置与设备标识',
                            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.textPrimary),
                          ),
                          const Spacer(),
                          AnimatedRotation(
                            turns: _advancedExpanded ? 0 : -0.25,
                            duration: const Duration(milliseconds: 140),
                            child: const Icon(Icons.expand_more, size: 20, color: AppColors.textMuted),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (_advancedExpanded)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const Divider(height: 1),
                          const SizedBox(height: 14),
                          TextField(
                            controller: _urlController,
                            contextMenuBuilder: buildChineseTextSelectionMenu,
                            decoration: InputDecoration(
                              labelText: 'Relay 地址',
                              hintText: 'ws://192.168.x.x:8788/ws',
                              filled: true,
                              fillColor: AppColors.surfaceSubtle,
                              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                              suffixIcon: IconButton(
                                tooltip: '扫描电脑二维码',
                                onPressed: _scanQr,
                                icon: const Icon(Icons.qr_code_scanner),
                              ),
                            ),
                          ),
                          const SizedBox(height: 12),
                          TextField(
                            controller: _deviceController,
                            contextMenuBuilder: buildChineseTextSelectionMenu,
                            decoration: InputDecoration(
                              labelText: '设备标识',
                              filled: true,
                              fillColor: AppColors.surfaceSubtle,
                              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                            ),
                          ),
                          const SizedBox(height: 14),
                          FilledButton.tonal(
                            onPressed: connecting ? null : _connect,
                            style: FilledButton.styleFrom(
                              minimumSize: const Size.fromHeight(44),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                            ),
                            child: Text(connecting ? '连接中…' : '使用当前配置连接'),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 4),
              child: Text(
                '配对成功后所有会话内容均在手机与电脑间端到端加密传输，中继服务器无法读取。首次连接请使用电脑端「设备配对」二维码。',
                style: TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.5),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
