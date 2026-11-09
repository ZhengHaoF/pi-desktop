import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/pages/scan_page.dart';

void main() {
  group('parseRelayQr', () {
    test('accepts the desktop ws URL', () {
      expect(parseRelayQr('ws://192.168.31.68:8787/ws')?.url, 'ws://192.168.31.68:8787/ws');
    });

    test('defaults a missing path to /ws', () {
      expect(parseRelayQr('ws://192.168.31.68:8787')?.url, 'ws://192.168.31.68:8787/ws');
    });

    test('normalizes http(s) schemes to ws(s)', () {
      expect(parseRelayQr('http://10.0.0.5:8787/ws')?.url, 'ws://10.0.0.5:8787/ws');
      expect(parseRelayQr('https://relay.example.com/ws')?.url, 'wss://relay.example.com/ws');
    });

    test('trims whitespace', () {
      expect(parseRelayQr('  ws://127.0.0.1:8787/ws \n')?.url, 'ws://127.0.0.1:8787/ws');
    });

    test('parses the JSON pairing payload with hostId and token', () {
      final payload = jsonEncode({
        'v': 1,
        'relayUrl': 'ws://192.168.8.185:8787/ws',
        'hostId': 'host-abc123',
        'token': 'pair-token-xyz',
      });
      final parsed = parseRelayQr(payload);
      expect(parsed, isNotNull);
      expect(parsed!.url, 'ws://192.168.8.185:8787/ws');
      expect(parsed.hostId, 'host-abc123');
      expect(parsed.pairingToken, 'pair-token-xyz');
      expect(parsed.e2eePub, isNull);
    });

    test('parses the pairing payload with the host e2ee public key', () {
      final payload = jsonEncode({
        'v': 1,
        'relayUrl': 'ws://192.168.8.185:8787/ws',
        'hostId': 'host-abc123',
        'token': 'pair-token-xyz',
        'e2eePub': 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw',
      });
      final parsed = parseRelayQr(payload);
      expect(parsed, isNotNull);
      expect(parsed!.e2eePub, 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw');
    });

    test('JSON payload without token still yields a plain target', () {
      final parsed = parseRelayQr(jsonEncode({'v': 1, 'relayUrl': 'wss://relay.example.com/ws', 'hostId': 'h1'}));
      expect(parsed?.url, 'wss://relay.example.com/ws');
      expect(parsed?.pairingToken, isNull);
      expect(parsed?.hostId, 'h1');
    });

    test('rejects non-relay payloads', () {
      expect(parseRelayQr(null), isNull);
      expect(parseRelayQr(''), isNull);
      expect(parseRelayQr('hello world'), isNull);
      expect(parseRelayQr('ftp://example.com/ws'), isNull);
      expect(parseRelayQr('ws://'), isNull);
      expect(parseRelayQr('ws://${'a' * 600}/ws'), isNull);
      expect(parseRelayQr('{not-json'), isNull);
      expect(parseRelayQr(jsonEncode({'v': 1, 'relayUrl': 'ftp://x'})), isNull);
    });
  });
}