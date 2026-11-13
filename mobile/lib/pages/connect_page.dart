/// Connect page: relay address + device id, then straight to the PC home.
library;

import 'package:flutter/material.dart';

import '../core/device_label.dart';
import '../core/host_store.dart';
import '../core/keep_alive.dart';
import '../core/remote_connection.dart';
import 'home_page.dart';
import 'scan_page.dart';

class ConnectPage extends StatefulWidget {
  const ConnectPage({super.key});

  @override
  State<ConnectPage> createState() => _ConnectPageState();
}

class _ConnectPageState extends State<ConnectPage> {
  static const String _defaultRelayUrl = 'ws://10.0.2.2:8788/ws';

  final _urlController = TextEditingController(text: _defaultRelayUrl);
  final _deviceController = TextEditingController();
  /// 扫码载荷带入的配对材料：一次性 token 与目标 PC（hostId）。
  String? _pairingToken;
  String? _targetHostId;
  LinkState _state = LinkState.disconnected;
  String? _error;

  @override
  void initState() {
    super.initState();
    loadOrCreateDeviceId().then((id) {
      if (mounted) _deviceController.text = id;
    });
    // 回填上次成功连接的 relay 地址；用户已手动改过输入框时不覆盖。
    loadLastRelayUrl().then((url) {
      if (!mounted || url == null) return;
      if (_urlController.text == _defaultRelayUrl) _urlController.text = url;
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
    // 配对二维码带的主机公钥是带外锚点：先钉扎，hello_ack 不符即拒连。
    // 钉扎按 relay 地址隔离，换 relay 不互相污染。
    if (scanned.e2eePub != null && scanned.hostId != null) {
      await savePinnedHostPub(scanned.hostId!, scanned.e2eePub!, relayUrl: scanned.url);
    }
    // Scanning is an explicit intent to connect — go straight through.
    await _connect();
  }

  Future<void> _connect() async {
    if (_state == LinkState.connecting) return;
    setState(() {
      _state = LinkState.connecting;
      _error = null;
    });
    final connection = RemoteConnection(
      relayUrl: _urlController.text.trim(),
      deviceId: _deviceController.text.trim(),
      // 型号 + Android 版本进 hello 的 label，电脑端配对列表才分得清是哪台。
      deviceLabel: await resolveDeviceLabel(),
      pairingToken: _pairingToken,
      targetHostId: _targetHostId,
    );
    try {
      await connection.connect();
      if (!mounted) return;
      // 连接成功且用户开启保活 → 前台服务 + WifiLock，息屏不断链。
      if (await keepAliveEnabled()) {
        await startKeepAlive();
      }
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => HomePage(connection: connection)),
      );
    } catch (err) {
      setState(() {
        _state = LinkState.disconnected;
        _error = err.toString();
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
    return Scaffold(
      appBar: AppBar(title: const Text('Pi Go — 连接')),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _urlController,
              decoration: InputDecoration(
                labelText: 'Relay 地址',
                hintText: 'ws://192.168.x.x:8788/ws',
                border: const OutlineInputBorder(),
                suffixIcon: IconButton(
                  tooltip: '扫描电脑二维码',
                  onPressed: _scanQr,
                  icon: const Icon(Icons.qr_code_scanner),
                ),
              ),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _scanQr,
              icon: const Icon(Icons.qr_code_2, size: 18),
              label: const Text('扫描电脑屏幕上的二维码'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _deviceController,
              decoration: const InputDecoration(labelText: '设备标识', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: _state == LinkState.connecting ? null : _connect,
              child: Text(_state == LinkState.connecting ? '连接中…' : '连接'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(_error!, style: const TextStyle(color: Colors.red)),
            ],
            const Spacer(),
            Text(
              '端到端加密：配对成功后所有会话内容在手机与电脑间加密传输，'
              '中继服务器无法读取。\n首次连接请用电脑端「设备配对」二维码扫码配对。',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}
