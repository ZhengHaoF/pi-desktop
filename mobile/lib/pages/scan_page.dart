/// QR pairing: scan the desktop settings card's relay QR code and hand the
/// validated endpoint (plus pairing token / target host) back to the connect
/// page.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

/// Parsed scan result: relay endpoint and optional pairing material.
class RelayQrTarget {
  final String url;
  final String? hostId;
  final String? pairingToken;
  /// Host's static X25519 public key — the out-of-band E2EE anchor.
  final String? e2eePub;
  const RelayQrTarget(this.url, {this.hostId, this.pairingToken, this.e2eePub});
}

/// Parses a scanned payload into a relay target.
/// Accepts the JSON pairing payload `{v, relayUrl, hostId, token, e2eePub}` or
/// a bare `ws://host:port/ws` / `wss://...` (http(s) variants are normalized
/// too). Returns null when the payload is not a usable relay target.
RelayQrTarget? parseRelayQr(String? raw) {
  final text = raw?.trim();
  if (text == null || text.isEmpty || text.length > 512) return null;
  if (text.startsWith('{')) {
    try {
      final decoded = jsonDecode(text);
      if (decoded is! Map) return null;
      final url = _normalizeRelayUrl(decoded['relayUrl'] as String?);
      if (url == null) return null;
      final hostId = decoded['hostId'];
      final token = decoded['token'];
      final e2eePub = decoded['e2eePub'];
      return RelayQrTarget(
        url,
        hostId: hostId is String && hostId.isNotEmpty ? hostId : null,
        pairingToken: token is String && token.isNotEmpty ? token : null,
        e2eePub: e2eePub is String && e2eePub.isNotEmpty ? e2eePub : null,
      );
    } catch (_) {
      return null;
    }
  }
  final url = _normalizeRelayUrl(text);
  return url == null ? null : RelayQrTarget(url);
}

String? _normalizeRelayUrl(String? raw) {
  final text = raw?.trim();
  if (text == null || text.isEmpty) return null;
  var candidate = text;
  if (candidate.startsWith('http://')) {
    candidate = 'ws://${candidate.substring('http://'.length)}';
  } else if (candidate.startsWith('https://')) {
    candidate = 'wss://${candidate.substring('https://'.length)}';
  }
  final uri = Uri.tryParse(candidate);
  if (uri == null) return null;
  if (uri.scheme != 'ws' && uri.scheme != 'wss') return null;
  if (uri.host.isEmpty) return null;
  // Desktop QR encodes ws://<ip>:<port>/ws; tolerate a missing path.
  final path = uri.path.isEmpty ? '/ws' : uri.path;
  return Uri(
    scheme: uri.scheme,
    host: uri.host,
    port: uri.hasPort ? uri.port : null,
    path: path,
  ).toString();
}

class ScanPage extends StatefulWidget {
  const ScanPage({super.key});

  @override
  State<ScanPage> createState() => _ScanPageState();
}

class _ScanPageState extends State<ScanPage> {
  final MobileScannerController _controller = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  bool _handled = false;
  String? _error;

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    for (final barcode in capture.barcodes) {
      final parsed = parseRelayQr(barcode.rawValue);
      if (parsed == null) {
        // Keep scanning, but tell the user why this code was rejected.
        if (mounted && _error == null) {
          setState(() => _error = '不是有效的 Relay 二维码（需要 ws:// 地址或配对载荷）');
        }
        continue;
      }
      _handled = true;
      _controller.stop();
      if (mounted) Navigator.of(context).pop(parsed);
      return;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('扫描电脑二维码'),
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            tooltip: '手电筒',
            onPressed: () => _controller.toggleTorch(),
            icon: const Icon(Icons.flashlight_on_outlined),
          ),
          IconButton(
            tooltip: '切换摄像头',
            onPressed: () => _controller.switchCamera(),
            icon: const Icon(Icons.cameraswitch_outlined),
          ),
        ],
      ),
      body: Stack(
        children: [
          MobileScanner(controller: _controller, onDetect: _onDetect),
          // Scan frame guide
          Center(
            child: Container(
              width: 240,
              height: 240,
              decoration: BoxDecoration(
                border: Border.all(color: Colors.greenAccent, width: 2),
                borderRadius: BorderRadius.circular(16),
              ),
            ),
          ),
          Positioned(
            left: 24,
            right: 24,
            bottom: 48,
            child: Column(
              children: [
                const Text(
                  '对准电脑「自建托管」卡片中的二维码',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white70, fontSize: 13),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 10),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    decoration: BoxDecoration(
                      color: Colors.red.shade900.withValues(alpha: 0.85),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      _error!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Colors.white, fontSize: 12),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
