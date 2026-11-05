import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/remote_connection.dart';
import 'package:pi_remote/protocol/wire.dart';

void main() {
  test('protocol: allowlist mirrors the TypeScript source of truth', () {
    expect(isMethodAllowed('agent.command'), isTrue);
    expect(isMethodAllowed('sessions.contextPage'), isTrue);
    expect(isMethodAllowed('sessions.delete'), isFalse);
    expect(isMethodAllowed('mcp.oauth.submit'), isFalse);
    expect(isAgentCommandTypeAllowed('abort'), isTrue);
    expect(isAgentCommandTypeAllowed('extension_ui_response'), isTrue);
    expect(isAgentCommandTypeAllowed('set_tools'), isFalse);
    expect(isSubscriptionAllowed('agent.events', 's1'), isTrue);
    expect(isSubscriptionAllowed('agent.events', '*'), isFalse);
  });

  test('golden: envelope encodes the expected wire shape', () {
    final envelope = RemoteEnvelope(
      traceId: 'trace-1',
      nonce: 'nonce-1',
      role: 'device',
      deviceId: 'dev-1',
      ts: 1700000000000,
      payload: {'kind': 'hello', 'protocolVersion': protocolVersion, 'role': 'device', 'appVersion': '0.1.0'},
    );
    final json = envelope.toJson();
    expect(json['v'], 1);
    expect(json['traceId'], 'trace-1');
    expect(json['ts'], 1700000000000);
    expect(json['role'], 'device');
    expect(json['deviceId'], 'dev-1');
    expect((json['payload'] as Map)['kind'], 'hello');
  });

  test('golden: hello payload shape', () {
    final hello = helloPayload(role: 'device', label: 'Pixel');
    expect(hello['kind'], 'hello');
    expect(hello['protocolVersion'], 1);
    expect(hello['role'], 'device');
    expect(hello['label'], 'Pixel');
    expect(hello['auth'], isEmpty);
  });

  test('agentCommand rejects non-allowlisted types without connecting', () async {
    final connection = RemoteConnection(relayUrl: 'ws://localhost:1', deviceId: 'd', deviceLabel: 'l');
    await expectLater(
      connection.agentCommand('s1', {'type': 'set_tools'}),
      throwsA(isA<StateError>()),
    );
  });

  test('request rejects non-allowlisted methods without connecting', () async {
    final connection = RemoteConnection(relayUrl: 'ws://localhost:1', deviceId: 'd', deviceLabel: 'l');
    await expectLater(
      connection.request('sessions.delete', {'id': 'x'}),
      throwsA(isA<StateError>()),
    );
  });
}
