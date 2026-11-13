import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/remote_connection.dart';

void main() {
  group('reconnectDelayMs', () {
    test('doubles from 2s and caps at 60s', () {
      expect(RemoteConnection.reconnectDelayMs(0), 2000);
      expect(RemoteConnection.reconnectDelayMs(1), 4000);
      expect(RemoteConnection.reconnectDelayMs(2), 8000);
      expect(RemoteConnection.reconnectDelayMs(3), 16000);
      expect(RemoteConnection.reconnectDelayMs(4), 32000);
      expect(RemoteConnection.reconnectDelayMs(5), 60000);
      expect(RemoteConnection.reconnectDelayMs(6), 60000);
      expect(RemoteConnection.reconnectDelayMs(500), 60000);
    });
  });

  group('buildAuth', () {
    test('carries the one-time pairing token until it is spent', () {
      final connection = RemoteConnection(
        relayUrl: 'ws://127.0.0.1:1/ws',
        deviceId: 'dev-test',
        deviceLabel: 'test',
        pairingToken: 'one-time-token',
      );
      expect(connection.buildAuth(null)['pairingToken'], 'one-time-token');

      // hello_ack 之后令牌已被 relay 消费：重连不再重放，只带长期凭证。
      connection.pairingTokenSpent = true;
      expect(connection.buildAuth(null).containsKey('pairingToken'), isFalse);
      expect(connection.buildAuth('long-term-secret')['deviceSecret'], 'long-term-secret');
    });

    test('omits empty secrets and never carries a token when none was scanned', () {
      final connection = RemoteConnection(
        relayUrl: 'ws://127.0.0.1:1/ws',
        deviceId: 'dev-test',
        deviceLabel: 'test',
      );
      expect(connection.buildAuth(null), isEmpty);
      expect(connection.buildAuth(''), isEmpty);
    });
  });

  group('isTerminalFailureFor', () {
    test('pairing reject and handshake refusal are terminal', () {
      // 同一份凭证/钉扎记录重连只会得到同一个答案，重试没有意义。
      expect(RemoteConnection.isTerminalFailureFor(4003, null), isTrue);
      expect(RemoteConnection.isTerminalFailureFor(null, '主机密钥不符'), isTrue);
      expect(RemoteConnection.isTerminalFailureFor(4003, '主机密钥不符'), isTrue);
    });

    test('recoverable failures are not terminal', () {
      // 协议/版本/频率这类问题靠重连或升级能恢复，列表与缓存应当保留。
      expect(RemoteConnection.isTerminalFailureFor(4002, null), isFalse);
      expect(RemoteConnection.isTerminalFailureFor(4000, null), isFalse);
      expect(RemoteConnection.isTerminalFailureFor(1008, null), isFalse);
      expect(RemoteConnection.isTerminalFailureFor(null, null), isFalse,
          reason: 'a plain link drop carries no verdict');
    });
  });

  group('shouldRetirePairingToken', () {    test('retires only on 4003 pairing-token-rejected close', () {
      expect(
          RemoteConnection.shouldRetirePairingToken(
              4003, 'pairing token rejected: pairing consumed', false),
          isTrue);
      expect(
          RemoteConnection.shouldRetirePairingToken(
              4003, 'pairing token rejected: pairing expired', false),
          isTrue);
      expect(RemoteConnection.shouldRetirePairingToken(4003, 'pairing required', false), isFalse,
          reason: 'plain pairing-required may still succeed once a token arrives');
      expect(RemoteConnection.shouldRetirePairingToken(4002, 'protocol error', false), isFalse);
      expect(RemoteConnection.shouldRetirePairingToken(null, null, false), isFalse);
      expect(
          RemoteConnection.shouldRetirePairingToken(
              4003, 'pairing token rejected: pairing consumed', true),
          isFalse,
          reason: 'already spent: nothing to retire');
    });
  });
}
