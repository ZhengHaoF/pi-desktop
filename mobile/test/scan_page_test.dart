import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/pages/scan_page.dart';

void main() {
  group('parseRelayQr', () {
    test('accepts the desktop ws URL', () {
      expect(parseRelayQr('ws://192.168.31.68:8787/ws'), 'ws://192.168.31.68:8787/ws');
    });

    test('defaults a missing path to /ws', () {
      expect(parseRelayQr('ws://192.168.31.68:8787'), 'ws://192.168.31.68:8787/ws');
    });

    test('normalizes http(s) schemes to ws(s)', () {
      expect(parseRelayQr('http://10.0.0.5:8787/ws'), 'ws://10.0.0.5:8787/ws');
      expect(parseRelayQr('https://relay.example.com/ws'), 'wss://relay.example.com/ws');
    });

    test('trims whitespace', () {
      expect(parseRelayQr('  ws://127.0.0.1:8787/ws \n'), 'ws://127.0.0.1:8787/ws');
    });

    test('rejects non-relay payloads', () {
      expect(parseRelayQr(null), isNull);
      expect(parseRelayQr(''), isNull);
      expect(parseRelayQr('hello world'), isNull);
      expect(parseRelayQr('ftp://example.com/ws'), isNull);
      expect(parseRelayQr('ws://'), isNull);
      expect(parseRelayQr('ws://${'a' * 600}/ws'), isNull);
    });
  });
}
