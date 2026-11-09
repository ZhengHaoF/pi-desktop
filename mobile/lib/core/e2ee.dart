/// E2EE cipher layer for the remote control plane — Dart mirror of
/// `src/agent-host/remote/cipher.ts`. X25519 ECDH + HKDF-SHA256 +
/// AES-256-GCM with envelope-header AAD binding and a sliding-window replay
/// cache. Golden vectors in test/e2ee_test.dart pin the byte-level contract.
library;

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

const String cipherAlg = 'x25519-aes-gcm';
const int replayWindowMs = 120000;

// ---------------------------------------------------------------------------
// Key pairs
// ---------------------------------------------------------------------------

/// Ephemeral device key pair (fresh per connection, never persisted).
class E2eeKeyPair {
  final SimpleKeyPair _keyPair;

  /// base64url raw 32-byte public key (wire form).
  final String publicKey;

  E2eeKeyPair._(this._keyPair, this.publicKey);

  static Future<E2eeKeyPair> generate() async {
    final algorithm = X25519();
    final keyPair = await algorithm.newKeyPair();
    final publicKey = await keyPair.extractPublicKey();
    return E2eeKeyPair._(keyPair, _b64url(publicKey.bytes));
  }

  /// Deterministic from a 32-byte seed (golden tests + future re-use).
  static Future<E2eeKeyPair> fromSeed(List<int> seed) async {
    final algorithm = X25519();
    final keyPair = await algorithm.newKeyPairFromSeed(seed);
    final publicKey = await keyPair.extractPublicKey();
    return E2eeKeyPair._(keyPair, _b64url(publicKey.bytes));
  }

  SimpleKeyPair get keyPair => _keyPair;
}

PublicKey _publicKeyFromB64url(String value) {
  final bytes = _b64urlDecode(value);
  if (bytes.length != 32) {
    throw FormatException('x25519 public key must be 32 raw bytes');
  }
  return SimplePublicKey(bytes, type: KeyPairType.x25519);
}

// ---------------------------------------------------------------------------
// Key schedule
// ---------------------------------------------------------------------------

class _DirectionKeys {
  final SecretKey c2h;
  final SecretKey h2c;
  _DirectionKeys(this.c2h, this.h2c);
}

Future<_DirectionKeys> _deriveKeys({
  required SimpleKeyPair ownKeyPair,
  required String ownPublicB64url,
  required String peerPublicB64url,
  required bool isDevice,
}) async {
  final algorithm = X25519();
  final shared = await algorithm.sharedSecretKey(
    keyPair: ownKeyPair,
    remotePublicKey: _publicKeyFromB64url(peerPublicB64url),
  );
  final devicePub = isDevice ? ownPublicB64url : peerPublicB64url;
  final hostPub = isDevice ? peerPublicB64url : ownPublicB64url;
  final saltDigest = await Sha256().hash(utf8.encode('pi-remote-e2ee-v1|$devicePub|$hostPub'));
  final hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
  final c2h = await hkdf.deriveKey(secretKey: shared, nonce: saltDigest.bytes, info: utf8.encode('device-to-host'));
  final h2c = await hkdf.deriveKey(secretKey: shared, nonce: saltDigest.bytes, info: utf8.encode('host-to-device'));
  return _DirectionKeys(SecretKey(c2h.bytes), SecretKey(h2c.bytes));
}

Future<String> keyIdAsync(String publicKeyB64url) async {
  final digest = await Sha256().hash(utf8.encode(publicKeyB64url));
  return _b64url(digest.bytes).substring(0, 16);
}

// ---------------------------------------------------------------------------
// Canonical AAD (must match cipher.ts byte for byte)
// ---------------------------------------------------------------------------

const List<String> _aadHeaderKeys = ['v', 'traceId', 'ts', 'nonce', 'role', 'deviceId', 'hostId', 'e2eePub'];

String canonicalAadJson(Map<String, dynamic> header) {
  final picked = <String, dynamic>{};
  for (final key in _aadHeaderKeys) {
    if (header[key] != null) picked[key] = header[key];
  }
  return jsonEncode(picked);
}

String canonicalCipherJson(String alg, String keyId, String iv) =>
    jsonEncode({'alg': alg, 'keyId': keyId, 'iv': iv});

// ---------------------------------------------------------------------------
// Replay cache
// ---------------------------------------------------------------------------

class ReplayCache {
  static const int _maxEntries = 4096;
  final Map<String, int> _seen = {};

  bool checkAndRecord(String nonce, int ts, int nowMs, {int windowMs = replayWindowMs}) {
    final drift = nowMs - ts;
    if (drift.abs() > windowMs) return false;
    if (nonce.isNotEmpty && _seen.containsKey(nonce)) return false;
    if (_seen.length >= _maxEntries) _seen.remove(_seen.keys.first);
    if (nonce.isNotEmpty) _seen[nonce] = ts;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Session (one per peer key pair)
// ---------------------------------------------------------------------------

class E2eeSeal {
  final String peerPub;
  final String keyId;
  final String ownPub;
  final SecretKey _key;

  E2eeSeal._(this.peerPub, this.keyId, this.ownPub, this._key);

  static Future<E2eeSeal> create({
    required E2eeKeyPair own,
    required String peerPublicKey,
    required bool isDevice,
  }) async {
    final keys = await _deriveKeys(
      ownKeyPair: own.keyPair,
      ownPublicB64url: own.publicKey,
      peerPublicB64url: peerPublicKey,
      isDevice: isDevice,
    );
    return E2eeSeal._(peerPublicKey, await keyIdAsync(own.publicKey), own.publicKey, isDevice ? keys.c2h : keys.h2c);
  }

  /// Returns cipher block + payload string for `payload` under `header`
  /// (all envelope fields except payload/cipher). `iv` is for golden tests
  /// only; production calls generate a fresh 12-byte nonce.
  Future<({Map<String, String> cipher, String payload, String e2eePub})> seal(
    Object? payload,
    Map<String, dynamic> header, {
    List<int>? iv,
  }) async {
    final nonce = iv ?? _randomBytes(12);
    final aad = utf8.encode(
      canonicalAadJson({...header, 'e2eePub': ownPub}) + canonicalCipherJson(cipherAlg, keyId, _b64(nonce)),
    );
    final box = await AesGcm.with256bits().encrypt(
      utf8.encode(jsonEncode(payload)),
      secretKey: _key,
      nonce: nonce,
      aad: aad,
    );
    return (
      cipher: {
        'alg': cipherAlg,
        'keyId': keyId,
        'iv': _b64(box.nonce),
        'tag': _b64(box.mac.bytes),
      },
      payload: _b64(box.cipherText),
      e2eePub: ownPub,
    );
  }
}

class E2eeOpen {
  final String peerPub;
  final String keyId;
  final SecretKey _key;
  final ReplayCache _replay = ReplayCache();

  E2eeOpen._(this.peerPub, this.keyId, this._key);

  static Future<E2eeOpen> create({
    required E2eeKeyPair own,
    required String peerPublicKey,
    required bool isDevice,
  }) async {
    final keys = await _deriveKeys(
      ownKeyPair: own.keyPair,
      ownPublicB64url: own.publicKey,
      peerPublicB64url: peerPublicKey,
      isDevice: isDevice,
    );
    return E2eeOpen._(peerPublicKey, await keyIdAsync(peerPublicKey), isDevice ? keys.h2c : keys.c2h);
  }

  /// Decrypts one ciphertext envelope. Throws on tamper/replay/clock drift.
  Future<Object?> open({
    required Map<String, String> cipher,
    required String payload,
    required Map<String, dynamic> header,
  }) async {
    if (cipher['alg'] != cipherAlg) {
      throw const FormatException('cipher alg mismatch');
    }
    final ts = header['ts'];
    final ok = _replay.checkAndRecord(
      (header['nonce'] ?? '').toString(),
      ts is int ? ts : -1,
      DateTime.now().millisecondsSinceEpoch,
    );
    if (!ok) throw const FormatException('replay detected or timestamp outside window');
    final iv = _b64Decode(cipher['iv']!);
    final tag = _b64Decode(cipher['tag']!);
    if (iv.length != 12 || tag.length != 16) {
      throw const FormatException('invalid IV or tag length');
    }
    final aad = utf8.encode(
      canonicalAadJson({...header, 'e2eePub': peerPub}) +
          canonicalCipherJson(cipher['alg']!, cipher['keyId']!, cipher['iv']!),
    );
    final clear = await AesGcm.with256bits().decrypt(
      SecretBox(_b64Decode(payload), nonce: iv, mac: Mac(tag)),
      secretKey: _key,
      aad: aad,
    );
    return jsonDecode(utf8.decode(clear));
  }
}

// ---------------------------------------------------------------------------
// Base64 helpers (wire uses padded base64; key ids use unpadded base64url)
// ---------------------------------------------------------------------------

String _b64(List<int> bytes) => base64Encode(bytes);

String _b64url(List<int> bytes) => base64UrlEncode(bytes).replaceAll('=', '');

List<int> _b64Decode(String value) => base64Decode(value);

List<int> _b64urlDecode(String value) {
  var normalized = value;
  while (normalized.length % 4 != 0) {
    normalized = '$normalized=';
  }
  return base64Url.decode(normalized);
}

Uint8List _randomBytes(int length) {
  final bytes = Uint8List(length);
  for (var i = 0; i < length; i++) {
    bytes[i] = _secureRandom.nextInt(256);
  }
  return bytes;
}

final _secureRandom = Random.secure();
