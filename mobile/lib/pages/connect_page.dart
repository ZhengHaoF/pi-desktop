/// Connect page: relay address + device id, then straight to the PC home.
library;

import 'package:flutter/material.dart';

import '../core/remote_connection.dart';
import 'home_page.dart';
import 'scan_page.dart';

class ConnectPage extends StatefulWidget {
  const ConnectPage({super.key});

  @override
  State<ConnectPage> createState() => _ConnectPageState();
}

class _ConnectPageState extends State<ConnectPage> {
  final _urlController = TextEditingController(text: 'ws://10.0.2.2:8787/ws');
  final _deviceController = TextEditingController();
  LinkState _state = LinkState.disconnected;
  String? _error;

  @override
  void initState() {
    super.initState();
    _deviceController.text = 'android-${DateTime.now().millisecondsSinceEpoch % 100000}';
  }

  Future<void> _scanQr() async {
    FocusScope.of(context).unfocus();
    final scanned = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const ScanPage()),
    );
    if (!mounted || scanned == null || scanned.isEmpty) return;
    setState(() {
      _urlController.text = scanned;
      _error = null;
    });
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
      deviceLabel: 'Pi Remote (Android)',
    );
    try {
      await connection.connect();
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
      appBar: AppBar(title: const Text('Pi Remote — 连接')),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _urlController,
              decoration: InputDecoration(
                labelText: 'Relay 地址',
                hintText: 'ws://192.168.x.x:8787/ws',
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
              'M1a 链路验证版：本地/内网 Relay（诊断模式，无 E2EE）。\n'
              '正式配对、E2EE 与公网 Relay 属于 M1b。',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}
