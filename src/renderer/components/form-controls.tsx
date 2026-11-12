/**
 * Shared form controls for settings-style panels (fields, inputs, selects).
 * Extracted from ModelsConfig so detail panes can stay focused on domain logic.
 * The input primitives delegate to components/ui; this module owns the Field
 * label-association context and the Select option-mapping API.
 */
import { createContext, useContext, useId, type ReactNode } from "react";
import { Input } from "@/components/ui/Input";
import { SecretTextInput as UiSecretTextInput } from "@/components/ui/SecretTextInput";
import { Select as UiSelect } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";

const FieldControlIdContext = createContext<string | undefined>(undefined);

function useFieldControlId(): string | undefined {
  return useContext(FieldControlIdContext);
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  const controlId = useId();

  return (
    <FieldControlIdContext.Provider value={controlId}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label htmlFor={controlId} style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
          {label}
        </label>
        {children}
      </div>
    </FieldControlIdContext.Provider>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  const controlId = useFieldControlId();

  return (
    <Input
      id={controlId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      mono={mono}
    />
  );
}

export function SecretTextInput({
  value,
  onChange,
  placeholder,
  mono,
  onKeyDown,
  autoComplete,
  spellCheck,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoComplete?: string;
  spellCheck?: boolean;
  style?: React.CSSProperties;
}) {
  const controlId = useFieldControlId();

  return (
    <UiSecretTextInput
      id={controlId}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      mono={mono}
      onKeyDown={onKeyDown}
      autoComplete={autoComplete}
      spellCheck={spellCheck}
      style={style}
    />
  );
}

export function NumInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const controlId = useFieldControlId();

  return (
    <Input
      id={controlId}
      type="number"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  required,
  labels,
  emptyLabel,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly (string | { value: string; label: string })[];
  required?: boolean;
  /** Display text per option value; falls back to the raw value. */
  labels?: Record<string, string>;
  /** Text for the empty "inherit / none" option. */
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const controlId = useFieldControlId();

  const mapped = options.map((o) => {
    const value = typeof o === "string" ? o : o.value;
    const label = typeof o === "string" ? o : o.label;
    return { value, label: labels?.[value] ?? label };
  });
  const selectOptions = required ? mapped : [{ value: "", label: emptyLabel ?? "— inherit / none —" }, ...mapped];

  return (
    <UiSelect
      id={controlId}
      value={value}
      onChange={onChange}
      options={selectOptions}
      placeholder={emptyLabel ?? "— inherit / none —"}
      disabled={disabled}
    />
  );
}

export function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ minHeight: 36, padding: "4px 0", fontSize: 13, color: "var(--text-muted)" }}>
      <Checkbox checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: "var(--text-dim)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        marginBottom: 2,
      }}
    >
      {children}
    </div>
  );
}
