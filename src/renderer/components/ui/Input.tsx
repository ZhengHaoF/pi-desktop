/**
 * Shared text input wrapping the `.pi-input` class system in globals.css.
 * Colors, placeholder, disabled and invalid borders live in those classes;
 * this component supplies the density presets (36px form rows by default,
 * 26px compact for sidebar filters and toolbars). Callers override layout
 * via className/style as usual.
 */
import type { InputHTMLAttributes, CSSProperties, Ref } from "react";

export type InputSize = "sm" | "md";

const mdStyle: CSSProperties = {
  minHeight: 36,
  padding: "7px 10px",
  fontSize: 13,
  width: "100%",
};

const smStyle: CSSProperties = {
  ...mdStyle,
  minHeight: 26,
  padding: "4px 8px",
  fontSize: 12,
};

const sizeStyle: Record<InputSize, CSSProperties> = {
  sm: smStyle,
  md: mdStyle,
};

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** Density preset; md is the settings-form row height paired with Button size="lg". */
  size?: InputSize;
  /** Error state; switches the border to the danger palette. */
  invalid?: boolean;
  /** Monospace text (paths, keys, JSON). */
  mono?: boolean;
  /** React 19 ref prop, forwarded to the underlying input element. */
  ref?: Ref<HTMLInputElement>;
}

export function Input({ size = "md", invalid, mono, type, className, style, ref, ...rest }: InputProps) {
  const classes = ["pi-input", invalid ? "pi-input-invalid" : undefined, className].filter(Boolean).join(" ");
  const layout: CSSProperties = {
    ...sizeStyle[size],
    ...(mono ? { fontFamily: "var(--font-mono)" } : undefined),
    ...style,
  };

  return <input ref={ref} type={type} className={classes} style={layout} {...rest} />;
}
