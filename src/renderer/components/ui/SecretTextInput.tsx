/**
 * Password-style input with a visibility toggle. Internally composed from
 * Input and Button; the toggle keeps a 32px pointer target.
 */
import { useEffect, useState, type KeyboardEventHandler, type CSSProperties, type Ref } from "react";
import { Input } from "./Input";
import { Button } from "./Button";

export interface SecretTextInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  autoComplete?: string;
  spellCheck?: boolean;
  autoFocus?: boolean;
  /** Forwarded to Input; a Field-wrapped SecretTextInput gets its label id here. */
  id?: string;
  style?: CSSProperties;
  disabled?: boolean;
  /** Forwarded to Input; lets dialogs re-focus the field after the shell. */
  ref?: Ref<HTMLInputElement>;
}

export function SecretTextInput({
  value,
  onChange,
  placeholder,
  mono,
  onKeyDown,
  autoComplete = "off",
  spellCheck = false,
  autoFocus,
  id,
  style,
  disabled,
  ref,
}: SecretTextInputProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  return (
    <div style={{ position: "relative", width: "100%", ...style }}>
      <Input
        id={id}
        ref={ref}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        mono={mono}
        disabled={disabled}
        autoFocus={autoFocus}
        style={{ paddingRight: 40 }}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide API key" : "Show API key"}
        title={visible ? "Hide API key" : "Show API key"}
        style={{
          position: "absolute",
          right: 2,
          top: "50%",
          transform: "translateY(-50%)",
        }}
      >
        {visible ? (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12a18.45 18.45 0 0 1 5.06-6.94" />
            <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c5 0 9.27 3.11 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
            <path d="M1 1l22 22" />
          </svg>
        ) : (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </Button>
    </div>
  );
}
