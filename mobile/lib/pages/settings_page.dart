/// Phone-side settings page: link status, relay params, reconnect controls.
library;

import 'package:flutter/material.dart';

import '../core/remote_connection.dart';
import 'connect_page.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({required this.connection, super.key});

  final RemoteConnection connection;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  bool _reconnecting = false;

  Future<void> _reconnect() async {
    setState(() => _reconnecting = true);
    await widget.connection.reconnect();
    if (mounted) setState(() => _reconnecting = false);
  }

  void _disconnectAndExit() {
    widget.connection.disconnect();
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const ConnectPage()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: StreamBuilder<LinkState>(
        stream: widget.connection.onState,
        initialData: widget.connection.state,
        builder: (context, snapshot) {
          final state = snapshot.data ?? LinkState.disconnected;
          final connected = state == LinkState.ready;
          final stateLabel = connected
              ? '已连接'
              : state == LinkState.connecting
                  ? '连接中…'
                  : '未连接';
          final stateColor = connected ? Colors.green : (state == LinkState.connecting ? Colors.orange : Colors.red);
          return ListView(
            padding: const EdgeInsets.all(12),
            children: [
              _card(
                title: '连接状态',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 10,
                          height: 10,
                          decoration: BoxDecoration(color: stateColor, shape: BoxShape.circle),
                        ),
                        const SizedBox(width: 8),
                        Text(stateLabel, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
                        const Spacer(),
                        TextButton(
                          onPressed: _reconnecting ? null : _reconnect,
                          child: Text(_reconnecting ? '重连中…' : '重新连接'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    _kv('Relay 地址', widget.connection.relayUrl),
                    _kv('设备标识', widget.connection.deviceId),
                    _kv('Host ID', widget.connection.hostId ?? '（未获取，未连接或握手未完成）'),
                  ],
                ),
              ),
              _card(
                title: '连接信息',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: const [
                    Text('• Relay 与 PC 宿主需在电脑侧手动/随桌面应用启动', style: TextStyle(fontSize: 12, color: Colors.black54)),
                    SizedBox(height: 4),
                    Text('• 诊断模式：本地/内网明文，正式配对与 E2EE 后续提供', style: TextStyle(fontSize: 12, color: Colors.black54)),
                    SizedBox(height: 4),
                    Text('• PC 局域网 IP 变化后需修改 Relay 地址', style: TextStyle(fontSize: 12, color: Colors.black54)),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              FilledButton.tonalIcon(
                onPressed: _disconnectAndExit,
                icon: const Icon(Icons.link_off),
                label: const Text('断开连接并返回'),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _kv(String key, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 88,
            child: Text(key, style: const TextStyle(fontSize: 12, color: Colors.black45)),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _card({required String title, required Widget child}) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      elevation: 0,
      color: Colors.white,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Colors.black54)),
            const SizedBox(height: 8),
            child,
          ],
        ),
      ),
    );
  }
}
