import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/host_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('relayScope', () {
    test('extracts host and port from ws URLs', () {
      expect(relayScope('ws://82.156.168.149:8788/ws'), '82.156.168.149:8788');
      expect(relayScope('ws://192.168.1.5:8788/ws'), '192.168.1.5:8788');
      expect(relayScope('wss://relay.example.com/ws'), 'relay.example.com');
    });

    test('keeps explicit non-default ports and drops implicit ones', () {
      expect(relayScope('wss://relay.example.com:443/ws'), 'relay.example.com');
      expect(relayScope('ws://relay.example.com:80/ws'), 'relay.example.com');
      expect(relayScope('wss://relay.example.com:8443/ws'), 'relay.example.com:8443');
    });

    test('falls back to the raw string for garbage input', () {
      expect(relayScope('not a url'), 'not a url');
      expect(relayScope(''), '');
    });

    test('distinguishes relays that share a host but not a port', () {
      expect(
        relayScope('ws://10.0.0.2:8788/ws'),
        isNot(relayScope('ws://10.0.0.2:9000/ws')),
      );
    });
  });

  group('device secret per-relay isolation', () {
    test('secrets saved for one relay are invisible to another', () async {
      const vps = 'ws://82.156.168.149:8788/ws';
      const lan = 'ws://192.168.1.5:8788/ws';
      await saveDeviceSecret('android-1', 'secret-vps', relayUrl: vps);

      expect(await loadDeviceSecret('android-1', relayUrl: vps), 'secret-vps');
      expect(await loadDeviceSecret('android-1', relayUrl: lan), isNull);
    });

    test('same device id can hold distinct secrets per relay', () async {
      const vps = 'ws://82.156.168.149:8788/ws';
      const lan = 'ws://192.168.1.5:8788/ws';
      await saveDeviceSecret('android-1', 'secret-vps', relayUrl: vps);
      await saveDeviceSecret('android-1', 'secret-lan', relayUrl: lan);

      expect(await loadDeviceSecret('android-1', relayUrl: vps), 'secret-vps');
      expect(await loadDeviceSecret('android-1', relayUrl: lan), 'secret-lan');
    });
  });

  group('pinned host pub per-relay isolation', () {
    test('pin saved for one relay does not leak into another', () async {
      const vps = 'ws://82.156.168.149:8788/ws';
      const lan = 'ws://192.168.1.5:8788/ws';
      await savePinnedHostPub('host-aaa', 'pubkeyA', relayUrl: vps);

      expect(await loadPinnedHostPub('host-aaa', relayUrl: vps), 'pubkeyA');
      expect(await loadPinnedHostPub('host-aaa', relayUrl: lan), isNull);
    });

    test('same host id pins independently per relay', () async {
      const vps = 'ws://82.156.168.149:8788/ws';
      const lan = 'ws://192.168.1.5:8788/ws';
      await savePinnedHostPub('host-aaa', 'pubkey-vps', relayUrl: vps);
      await savePinnedHostPub('host-aaa', 'pubkey-lan', relayUrl: lan);

      expect(await loadPinnedHostPub('host-aaa', relayUrl: vps), 'pubkey-vps');
      expect(await loadPinnedHostPub('host-aaa', relayUrl: lan), 'pubkey-lan');
    });
  });

  group('last relay url', () {
    test('is empty before the first successful connection', () async {
      expect(await loadLastRelayUrl(), isNull);
    });

    test('round-trips the address without surrounding whitespace', () async {
      await saveLastRelayUrl('  ws://82.156.168.149:8788/ws  ');

      expect(await loadLastRelayUrl(), 'ws://82.156.168.149:8788/ws');
    });

    test('a later success replaces the previous address', () async {
      await saveLastRelayUrl('ws://82.156.168.149:8788/ws');
      await saveLastRelayUrl('ws://192.168.1.5:8788/ws');

      expect(await loadLastRelayUrl(), 'ws://192.168.1.5:8788/ws');
    });

    test('blank input does not erase the stored address', () async {
      await saveLastRelayUrl('ws://82.156.168.149:8788/ws');
      await saveLastRelayUrl('   ');

      expect(await loadLastRelayUrl(), 'ws://82.156.168.149:8788/ws');
    });
  });
}
