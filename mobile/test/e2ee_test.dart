/// E2EE golden vectors — must match src/agent-host/remote/cipher.test.mjs and
/// cipher.ts byte for byte (same keys, same IV, same AAD, same outputs).
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/e2ee.dart';

// Raw 32-byte private scalars: device = 1..32, host = 0xa0..0xbf.
final devSeed = List<int>.generate(32, (i) => i + 1);
final hostSeed = List<int>.generate(32, (i) => 0xa0 + i);

const devPub = 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw';
const hostPub = 'YFpyXSpK3-6xop4X7dYhwbdZPujNvESsbEq24vgF0jw';
const fixedIvHex = '00112233445566778899aabb';
const fixedTs = 1762656000000;

void main() {
  test('key derivation matches the TS golden public keys', () async {
    final d = await E2eeKeyPair.fromSeed(devSeed);
    final h = await E2eeKeyPair.fromSeed(hostSeed);
    expect(d.publicKey, devPub);
    expect(h.publicKey, hostPub);
    expect(await keyIdAsync(devPub), 'VSr9Bdp8PA7hhIDN');
    expect(await keyIdAsync(hostPub), 'GOj1R9-MjdbSWLaw');
  });

  test('device->host seal matches the TS golden vector', () async {
    final d = await E2eeKeyPair.fromSeed(devSeed);
    final seal = await E2eeSeal.create(own: d, peerPublicKey: hostPub, isDevice: true);
    final header = <String, dynamic>{
      'v': 1,
      'traceId': 'trace-golden',
      'ts': fixedTs,
      'nonce': 'nonce-golden',
      'role': 'device',
      'deviceId': 'device-golden',
      'hostId': 'host-golden',
    };
    final iv = _hexToBytes(fixedIvHex);
    final sealed = await seal.seal(
      jsonDecode('{"kind":"request","id":"g-1","method":"sessions.list","params":null}'),
      header,
      iv: iv,
    );
    expect(sealed.cipher['alg'], 'x25519-aes-gcm');
    expect(sealed.cipher['keyId'], 'VSr9Bdp8PA7hhIDN');
    expect(sealed.cipher['iv'], 'ABEiM0RVZneImaq7');
    expect(sealed.cipher['tag'], '51mwZsz9PSqxG3cMkcaGtA==');
    expect(
      sealed.payload,
      'tj/Axjpv9MGFSw1nvJ73do2KVQg4z7Wce7iZqzEebG0oC/tbg68GXalX2pWyTOYmQS8g88/JX40NpZ1GNhri/zHv8cw=',
    );
    expect(sealed.e2eePub, devPub);
  });

  test('host->device seal matches the TS golden vector', () async {
    final h = await E2eeKeyPair.fromSeed(hostSeed);
    final seal = await E2eeSeal.create(own: h, peerPublicKey: devPub, isDevice: false);
    final header = <String, dynamic>{
      'v': 1,
      'traceId': 'trace-golden-h',
      'ts': fixedTs,
      'nonce': 'nonce-golden-h',
      'role': 'host',
      'deviceId': 'device-golden',
    };
    final sealed = await seal.seal(
      jsonDecode('{"kind":"response","id":"g-1","ok":true}'),
      header,
      iv: _hexToBytes(fixedIvHex),
    );
    expect(sealed.cipher['keyId'], 'GOj1R9-MjdbSWLaw');
    expect(sealed.cipher['iv'], 'ABEiM0RVZneImaq7');
    expect(sealed.cipher['tag'], '5yKUEScaAg3009Yi+JXBKA==');
    expect(sealed.payload, 'eytog4Bdme1xdJyIab3t58mpD0LMgUPNvIt2hVUR7JkQd/V4ypScxA==');
    expect(sealed.e2eePub, hostPub);
  });

  test('seal/open round trip + header binding + replay rejection', () async {
    final d = await E2eeKeyPair.fromSeed(devSeed);
    final h = await E2eeKeyPair.fromSeed(hostSeed);
    final sealD = await E2eeSeal.create(own: d, peerPublicKey: hostPub, isDevice: true);
    final openH = await E2eeOpen.create(own: h, peerPublicKey: devPub, isDevice: false);
    final header = <String, dynamic>{
      'v': 1,
      'traceId': 't1',
      'ts': DateTime.now().millisecondsSinceEpoch,
      'nonce': 'n1',
      'role': 'device',
      'deviceId': 'dev-1',
      'hostId': 'host-1',
    };
    final sealed = await sealD.seal({'kind': 'request', 'method': 'x'}, header);
    final opened = await openH.open(cipher: sealed.cipher, payload: sealed.payload, header: {...header, 'e2eePub': sealed.e2eePub});
    expect((opened as Map)['method'], 'x');

    // Replay: same nonce rejected.
    expect(
      () => openH.open(cipher: sealed.cipher, payload: sealed.payload, header: {...header, 'e2eePub': sealed.e2eePub}),
      throwsA(isA<FormatException>()),
    );

    // Header tamper: swapped deviceId.
    final sealed2 = await sealD.seal({'kind': 'request', 'method': 'y'}, {...header, 'nonce': 'n2'});
    expect(
      () => openH.open(
        cipher: sealed2.cipher,
        payload: sealed2.payload,
        header: {...header, 'nonce': 'n2', 'deviceId': 'evil', 'e2eePub': sealed2.e2eePub},
      ),
      throwsA(isA<Object>()),
    );
  });

  test('canonicalAadJson field order matches the TS golden AAD', () {
    final header = <String, dynamic>{
      'v': 1,
      'traceId': 'trace-golden',
      'ts': fixedTs,
      'nonce': 'nonce-golden',
      'role': 'device',
      'deviceId': 'device-golden',
      'hostId': 'host-golden',
      'e2eePub': devPub,
    };
    expect(
      canonicalAadJson(header),
      '{"v":1,"traceId":"trace-golden","ts":1762656000000,"nonce":"nonce-golden","role":"device","deviceId":"device-golden","hostId":"host-golden","e2eePub":"B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw"}',
    );
  });
}

List<int> _hexToBytes(String hex) {
  final out = <int>[];
  for (var i = 0; i < hex.length; i += 2) {
    out.add(int.parse(hex.substring(i, i + 2), radix: 16));
  }
  return out;
}
