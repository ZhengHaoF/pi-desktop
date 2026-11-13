/**
 * The model-facing `ask_question` tool: one to four questions, each with a
 * small set of options plus a free-text answer. It is a host-registered
 * ToolDefinition, so the question never leaves the extension-UI channel the
 * renderer already owns: `ctx.ui.askQuestions` emits one ask request and the
 * desktop dialog answers it. Hosts without that method (pi's own TUI) fall
 * back to `select`/`input` dialogs.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionUiContextLike } from "../shared/pi-types";
import type { AskQuestion, AskQuestionAnswer } from "../shared/types";

export const ASK_QUESTION_TOOL_NAME = "ask_question";
export const MAX_ASK_QUESTIONS = 4;
export const MAX_ASK_OPTIONS = 6;
/** A remote client may never answer: do not suspend the turn indefinitely. */
export const ASK_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

/** Fallback labels for hosts without the desktop ask dialog. */
const OTHER_LABEL = "Other (type my own answer)";
const DONE_LABEL = "Done";

const AskOptionSchema = Type.Object({
  label: Type.String({ description: "Option label the user picks" }),
  description: Type.Optional(Type.String({ description: "Optional detail shown under the label" })),
});

const AskQuestionSchema = Type.Object({
  header: Type.Optional(
    Type.String({ maxLength: 24, description: "Short chip label for the question, for example “Auth method”" }),
  ),
  question: Type.String({ description: "The complete question text, ending with a question mark" }),
  options: Type.Array(AskOptionSchema, {
    minItems: 2,
    maxItems: MAX_ASK_OPTIONS,
    description: "Concrete choices; the user can always type their own answer instead",
  }),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow picking more than one option" })),
});

export interface AskQuestionDetails {
  answered: AskQuestionAnswer[] | null;
  cancelled?: boolean;
}

function askTitle(question: AskQuestion): string {
  return question.header ? `${question.header}: ${question.question}` : question.question;
}

/** Header is optional: omit the key entirely rather than sending `undefined`. */
function withHeader(question: AskQuestion): { header?: string; question: string } {
  return { ...(question.header ? { header: question.header } : {}), question: question.question };
}

/** Picks options one at a time for hosts whose UI context only offers select/input. */
async function askThroughDialogs(
  ui: ExtensionUiContextLike,
  questions: AskQuestion[],
  signal: AbortSignal | undefined,
): Promise<AskQuestionAnswer[] | undefined> {
  const answers: AskQuestionAnswer[] = [];
  for (const question of questions) {
    const title = askTitle(question);
    const labels = question.options.map((option) => option.label);
    if (question.multiSelect) {
      const selected: string[] = [];
      let other: string | undefined;
      for (;;) {
        const remaining = labels.filter((label) => !selected.includes(label));
        const choice = await ui.select(title, [...remaining, OTHER_LABEL, DONE_LABEL], { signal });
        if (choice === undefined) return undefined;
        if (choice === DONE_LABEL) break;
        if (choice === OTHER_LABEL) {
          const typed = await ui.input(`${title} — other answer`, undefined, { signal });
          if (typed === undefined) return undefined;
          other = typed.trim() || other;
          continue;
        }
        selected.push(choice);
      }
      answers.push({ ...withHeader(question), selected, ...(other ? { other } : {}) });
      continue;
    }
    const choice = await ui.select(title, [...labels, OTHER_LABEL], { signal });
    if (choice === undefined) return undefined;
    if (choice === OTHER_LABEL) {
      const typed = await ui.input(`${title} — other answer`, undefined, { signal });
      if (typed === undefined) return undefined;
      const other = typed.trim();
      answers.push({ ...withHeader(question), selected: [], ...(other ? { other } : {}) });
      continue;
    }
    answers.push({ ...withHeader(question), selected: [choice] });
  }
  return answers;
}

function formatAnswers(answers: AskQuestionAnswer[]): string {
  const lines = answers.map((answer) => {
    const chosen = answer.selected.length ? answer.selected.join(", ") : "";
    const other = answer.other ? `Other: ${answer.other}` : "";
    const value = [chosen, other].filter(Boolean).join(" | ") || "(no answer)";
    return `- ${answer.header ? `${answer.header}: ` : ""}${answer.question} → ${value}`;
  });
  return ["The user answered through the question dialog:", ...lines].join("\n");
}

function cancelled(signal: AbortSignal | undefined) {
  return {
    content: [
      {
        type: "text" as const,
        text: signal?.aborted
          ? "The question was cancelled because the turn stopped."
          : "The user dismissed the questions without answering. Do not assume an answer; continue with a stated assumption or ask again later.",
      },
    ],
    details: { answered: null, cancelled: true } satisfies AskQuestionDetails,
  };
}

export function createAskQuestionTool() {
  return defineTool({
    name: ASK_QUESTION_TOOL_NAME,
    label: "Ask the user",
    description:
      "Ask the user one to four multiple-choice questions and wait for their answer. Each question offers 2-6 labeled options with optional descriptions, and the user can also type their own answer. Use this when a decision is genuinely the user's and you want the answer before continuing, such as choosing between approaches, clarifying requirements, or settling a trade-off.",
    promptSnippet: "Ask the user a question with options when their decision is required",
    promptGuidelines: [
      "Use ask_question only when the user must decide something you cannot infer from the codebase; prefer acting on a sensible default when one clearly exists.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      questions: Type.Array(AskQuestionSchema, {
        minItems: 1,
        maxItems: MAX_ASK_QUESTIONS,
        description: "Questions to ask in one dialog; keep it to the ones you need before proceeding",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        throw new Error(
          "ASK_QUESTION_UNAVAILABLE: no interactive UI is available in this session. Ask the user in plain text instead.",
        );
      }
      if (signal?.aborted) return cancelled(signal);
      try {
        const ui = ctx.ui as ExtensionUiContextLike;
        const answers = ui.askQuestions
          ? await ui.askQuestions(params.questions as AskQuestion[], { signal, timeout: ASK_QUESTION_TIMEOUT_MS })
          : await askThroughDialogs(ui, params.questions as AskQuestion[], signal);
        if (!answers) return cancelled(signal);
        return {
          content: [{ type: "text" as const, text: formatAnswers(answers) }],
          details: { answered: answers } satisfies AskQuestionDetails,
        };
      } catch (error) {
        if (signal?.aborted) return cancelled(signal);
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
  });
}
