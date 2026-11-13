import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/widgets/ask_sheet.dart';

void main() {
  group('parseAskQuestions', () {
    test('reads headers, descriptions and multiSelect', () {
      final questions = parseAskQuestions([
        {
          'header': 'Auth',
          'question': 'Which auth?',
          'options': [
            {'label': 'OAuth', 'description': 'Browser login'},
            {'label': 'API key'},
          ],
        },
        {
          'question': 'Scopes?',
          'options': [
            {'label': 'Read'},
          ],
          'multiSelect': true,
        },
      ]);
      expect(questions, isNotNull);
      expect(questions!.length, 2);
      expect(questions[0].header, 'Auth');
      expect(questions[0].options[0].description, 'Browser login');
      expect(questions[0].options[1].description, isNull);
      expect(questions[0].multiSelect, isFalse);
      expect(questions[1].header, isNull);
      expect(questions[1].multiSelect, isTrue);
    });

    test('rejects unusable payloads instead of rendering an empty sheet', () {
      expect(parseAskQuestions(null), isNull);
      expect(parseAskQuestions('nope'), isNull);
      expect(parseAskQuestions(<Object?>[]), isNull);
      expect(parseAskQuestions([<String, dynamic>{}]), isNull);
      expect(parseAskQuestions([
        {'question': '   ', 'options': [{'label': 'A'}]},
      ]), isNull);
      expect(parseAskQuestions([
        {'question': 'Q?', 'options': <Object?>[]},
      ]), isNull);
      expect(parseAskQuestions([
        {'question': 'Q?', 'options': ['A']},
      ]), isNull);
      expect(parseAskQuestions([
        {
          'question': 'Q?',
          'options': [{'label': ''}],
        },
      ]), isNull);
    });
  });

  group('AskDraft', () {
    const question = AskQuestionData(
      header: 'Target',
      question: 'Where?',
      options: [AskOptionData(label: 'Staging'), AskOptionData(label: 'Prod')],
    );

    test('single select replaces the previous choice and clears Other', () {
      final draft = AskDraft(question)..other = 'typed';
      draft.choose('Staging');
      expect(draft.selected, {'Staging'});
      // Picking an option is the whole answer: stale Other text must not ride along.
      expect(draft.other, isEmpty);
      draft.choose('Prod');
      expect(draft.selected, {'Prod'});
      draft.toggleOther();
      expect(draft.selected, isEmpty);
      expect(draft.complete, isFalse);
    });

    test('multi select toggles and keeps Other text alongside choices', () {
      const multi = AskQuestionData(
        question: 'Scopes?',
        options: [AskOptionData(label: 'Read'), AskOptionData(label: 'Write')],
        multiSelect: true,
      );
      final draft = AskDraft(multi);
      draft.choose('Read');
      draft.choose('Write');
      draft.choose('Read');
      expect(draft.selected, {'Write'});
      draft.toggleOther();
      draft.other = 'Admin';
      expect(draft.selected, {'Write'});
      expect(draft.toAnswer(), {
        'question': 'Scopes?',
        'selected': ['Write'],
        'other': 'Admin',
      });
    });

    test('answers are null until every question is answered', () {
      final drafts = [AskDraft(question), AskDraft(question)];
      drafts[0].choose('Staging');
      expect(askAnswers(drafts), isNull);
      drafts[1].toggleOther();
      drafts[1].other = '  Local ring  ';
      final answers = askAnswers(drafts);
      expect(answers, isNotNull);
      expect(answers![0]['header'], 'Target');
      expect(answers[0]['selected'], ['Staging']);
      expect(answers[1].containsKey('selected'), isTrue);
      expect(answers[1]['selected'], isEmpty);
      expect(answers[1]['other'], 'Local ring');
    });

    test('cancelling a multi-select Other drops the typed text', () {
      final draft = AskDraft(question)
        ..toggleOther()
        ..other = 'typed';
      draft.toggleOther();
      expect(draft.otherActive, isFalse);
      expect(draft.other, isEmpty);
      expect(draft.complete, isFalse);
    });
  });
}