/**
 * Shared button wrapping the `.pi-btn` class system in globals.css. Colors and
 * interaction states live in those classes; this component only supplies the
 * default layout (padding/size) and the variant/size wiring. Callers override
 * layout via className/style as before.
 */
import type { ButtonHTMLAttributes, CSSProperties, Ref } from "react";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost" | "link" | "dashed";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const variantClass: Record<ButtonVariant, string> = {
  default: "pi-btn",
  primary: "pi-btn pi-btn-primary",
  danger: "pi-btn pi-btn-danger",
  ghost: "pi-btn pi-btn-ghost",
  link: "pi-btn pi-btn-link",
  dashed: "pi-btn pi-btn-dashed",
};

const mdStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  minHeight: 32,
  padding: "5px 12px",
  fontSize: 12,
};

const smStyle: CSSProperties = {
  ...mdStyle,
  minHeight: 26,
  padding: "3px 8px",
  fontSize: 11,
};

/** Settings-form density: 36px-tall rows beside 13px inputs. */
const lgStyle: CSSProperties = {
  ...mdStyle,
  minHeight: 36,
  padding: "7px 14px",
  fontSize: 13,
};

const iconStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  padding: 0,
  flexShrink: 0,
};

const sizeStyle: Record<ButtonSize, CSSProperties> = {
  sm: smStyle,
  md: mdStyle,
  lg: lgStyle,
  icon: iconStyle,
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual variant mapped onto the shared `.pi-btn-*` classes. */
  variant?: ButtonVariant;
  /** Layout preset; callers may still override via style/className. */
  size?: ButtonSize;
  /** Toggle state; maps to `aria-pressed` to pick up the shared pressed styles. */
  pressed?: boolean;
  /** Stretch to fill the parent width (form action rows). */
  block?: boolean;
  /** React 19 ref prop, forwarded to the underlying button element. */
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "default",
  size = "md",
  pressed,
  block,
  type = "button",
  className,
  style,
  disabled,
  ref,
  ...rest
}: ButtonProps) {
  const classes = [variantClass[variant], className].filter(Boolean).join(" ");
  const layout: CSSProperties = { ...sizeStyle[size], ...(block ? { width: "100%" } : undefined), ...style };

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      style={layout}
      disabled={disabled}
      aria-pressed={pressed === undefined ? undefined : pressed}
      {...rest}
    />
  );
}
