/**
 * Password-style input with a visibility toggle. Internally composed from
 * Input and Button; the toggle keeps a 32px pointer target.
 */
import { useEffect, useState, type KeyboardEventHandler, type CSSProperties, type Ref } from "react";
import { Input } from "./Input";
import { Button } from "./Button";
import { Eye, EyeOff } from "lucide-react";

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
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </Button>
    </div>
  );
}
