/**
 * Ask dialog for the `ask` extension-UI request: one to four questions, each
 * with labeled options (optional descriptions) and a free-text "Other" answer.
 * Multi-select questions toggle rows; single-select replaces the choice. The
 * answers travel back one AskQuestionAnswer per question, in request order.
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import type { AskQuestion, AskQuestionAnswer, ExtensionUiRequest } from "@/lib/types";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Input } from "./ui/Input";

type AskRequest = Extract<ExtensionUiRequest, { method: "ask" }>;

export interface AskUserDialogProps {
  request: AskRequest;
  onRespond: (request: AskRequest, response: { answers: AskQuestionAnswer[] } | { cancelled: true }) => void;
}

interface Draft {
  selected: string[];
  other: string;
  otherActive: boolean;
}

function emptyDrafts(questions: AskQuestion[]): Draft[] {
  return questions.map(() => ({ selected: [], other: "", otherActive: false }));
}

const sectionStyle = { display: "grid", gap: 8 } as const;
const optionStyle = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
  width: "100%",
  padding: "8px 10px",
  whiteSpace: "normal",
  textAlign: "left",
} as const;

export function AskUserDialog({ request, onRespond }: AskUserDialogProps) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Draft[]>(() => emptyDrafts(request.questions));

  useEffect(() => {
    setDrafts(emptyDrafts(request.questions));
  }, [request]);

  const complete = drafts.every((draft, index) => {
    const question = request.questions[index];
    return question ? draft.selected.length > 0 || draft.other.trim().length > 0 : true;
  });

  const chooseOption = (index: number, label: string, multiSelect: boolean) => {
    setDrafts((previous) =>
      previous.map((draft, current) => {
        if (current !== index) return draft;
        if (!multiSelect) return { selected: [label], other: "", otherActive: false };
        const selected = draft.selected.includes(label)
          ? draft.selected.filter((entry) => entry !== label)
          : [...draft.selected, label];
        return { ...draft, selected };
      }),
    );
  };

  const toggleOther = (index: number, multiSelect: boolean) => {
    setDrafts((previous) =>
      previous.map((draft, current) => {
        if (current !== index) return draft;
        if (draft.otherActive) return { ...draft, otherActive: false, other: "" };
        return { ...draft, otherActive: true, selected: multiSelect ? draft.selected : [] };
      }),
    );
  };

  const editOther = (index: number, value: string) => {
    setDrafts((previous) => previous.map((draft, current) => (current === index ? { ...draft, other: value } : draft)));
  };

  const submit = () => {
    if (!complete) return;
    const answers = request.questions.map((question, index) => {
      const draft = drafts[index];
      const other = draft.other.trim();
      return {
        ...(question.header ? { header: question.header } : {}),
        question: question.question,
        selected: draft.selected,
        ...(other ? { other } : {}),
      } satisfies AskQuestionAnswer;
    });
    onRespond(request, { answers });
  };

  const cancel = () => onRespond(request, { cancelled: true });

  return (
    <Dialog
      open
      onClose={cancel}
      ariaLabel={t("askQuestionTitle", "The agent needs your input")}
      width={580}
      closeOnBackdrop={false}
      style={{ padding: 0, gap: 0, background: "var(--bg-panel)" }}
    >
      <header style={{ padding: "13px 16px", borderBottom: "1px solid var(--border)", display: "grid", gap: 3 }}>
        <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>
          {t("askQuestionTitle", "The agent needs your input")}
        </div>
        <div style={{ color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
          {t("askQuestionSubtitle", "Choose an option or type your own answer")}
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gap: 18,
          padding: "14px 16px",
          maxHeight: "min(62vh, 540px)",
          overflowY: "auto",
        }}
      >
        {request.questions.map((question, index) => {
          const draft = drafts[index] ?? { selected: [], other: "", otherActive: false };
          const multiSelect = question.multiSelect === true;
          return (
            <section key={index} style={sectionStyle} aria-label={question.header ?? question.question}>
              {question.header ? (
                <span
                  style={{
                    justifySelf: "start",
                    padding: "1px 7px",
                    borderRadius: 999,
                    background: "var(--accent-chip-bg)",
                    color: "var(--accent-chip-fg)",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  {question.header}
                </span>
              ) : null}
              <div style={{ color: "var(--text)", fontSize: 13.5, lineHeight: 1.55 }}>{question.question}</div>
              <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                {multiSelect ? t("askMultiSelectHint", "Select one or more") : t("askSingleSelectHint", "Select one")}
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {question.options.map((option) => {
                  const pressed = draft.selected.includes(option.label);
                  return (
                    <Button
                      key={option.label}
                      pressed={pressed}
                      onClick={() => chooseOption(index, option.label, multiSelect)}
                      style={optionStyle}
                    >
                      <span style={{ color: "var(--text)", fontSize: 13 }}>{option.label}</span>
                      {option.description ? (
                        <span style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
                          {option.description}
                        </span>
                      ) : null}
                    </Button>
                  );
                })}
                <Button pressed={draft.otherActive} onClick={() => toggleOther(index, multiSelect)} style={optionStyle}>
                  <span style={{ color: "var(--text)", fontSize: 13 }}>{t("askOtherOption", "Other…")}</span>
                </Button>
                {draft.otherActive ? (
                  <Input
                    autoFocus
                    value={draft.other}
                    placeholder={t("askOtherPlaceholder", "Type your answer")}
                    aria-label={t("askOtherOption", "Other…")}
                    onChange={(event) => editOther(index, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && complete) submit();
                    }}
                  />
                ) : null}
              </div>
            </section>
          );
        })}
      </div>

      <footer
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          padding: "11px 16px",
          borderTop: "1px solid var(--border)",
        }}
      >
        <Button onClick={cancel}>{t("cancel", "Cancel")}</Button>
        <Button variant="primary" disabled={!complete} onClick={submit}>
          {t("submit", "Submit")}
        </Button>
      </footer>
    </Dialog>
  );
}
