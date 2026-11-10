import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/pages/chat_page.dart';

void main() {
  group('turnRunningFromAgentState', () {
    test('missing agentState means idle', () {
      expect(turnRunningFromAgentState(null), isFalse);
      expect(turnRunningFromAgentState(<String, dynamic>{}), isFalse);
      expect(turnRunningFromAgentState('not-a-map'), isFalse);
    });

    test('agentState.running alone is not a turn', () {
      // PC sets running = isAlive(): the session object is resident in
      // memory, which is true for any opened session — not a running turn.
      expect(turnRunningFromAgentState(<String, dynamic>{'running': true}), isFalse);
      expect(
        turnRunningFromAgentState(<String, dynamic>{
          'running': true,
          'state': <String, dynamic>{'isStreaming': false, 'isPromptRunning': false},
        }),
        isFalse,
      );
    });

    test('runtime snapshot flags drive the mirror', () {
      expect(
        turnRunningFromAgentState(<String, dynamic>{
          'running': true,
          'state': <String, dynamic>{'isStreaming': true, 'isPromptRunning': false},
        }),
        isTrue,
      );
      // Tool-execution phase: streaming pauses but the prompt is still running.
      expect(
        turnRunningFromAgentState(<String, dynamic>{
          'running': true,
          'state': <String, dynamic>{'isStreaming': false, 'isPromptRunning': true},
        }),
        isTrue,
      );
    });
  });
}
