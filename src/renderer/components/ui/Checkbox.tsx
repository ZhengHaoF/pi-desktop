/**
 * Shared checkbox wrapping the `.pi-checkbox` class system in globals.css.
 * Renders a native input styled with accent-color — dark-theme correctness
 * and platform a11y come free; no custom check art. With `label` the box is
 * wrapped in a <label> (implicit association); without it the box is bare and
 * `id`/`aria-label` pass through for explicit association.
 */
import type { InputHTMLAttributes, ReactNode, Ref } from "react";

export type CheckboxSize = "sm" | "md";

const sizePx: Record<CheckboxSize, number> = {
  sm: 15,
  md: 18,
};

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "size"> {
  checked: boolean;
  /** Flattened change callback; receives the next checked state directly. */
  onChange: (checked: boolean) => void;
  size?: CheckboxSize;
  /** Optional label rendered after the box inside an implicit <label>. */
  label?: ReactNode;
  /** React 19 ref prop, forwarded to the underlying input element. */
  ref?: Ref<HTMLInputElement>;
}

export function Checkbox({ checked, onChange, size = "md", label, className, style, ref, ...rest }: CheckboxProps) {
  const box = (
    <input
      ref={ref}
      type="checkbox"
      className={["pi-checkbox", className].filter(Boolean).join(" ")}
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      style={{ width: sizePx[size], height: sizePx[size], ...style }}
      {...rest}
    />
  );

  if (label === undefined) return box;

  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth: 0 }}>
      {box}
      <span style={{ minWidth: 0 }}>{label}</span>
    </label>
  );
}
