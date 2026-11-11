/**
 * Shared textarea sharing the `.pi-input` class system with Input. Monospace
 * is the default because textareas here carry JSON configs and import payloads;
 * prose editors opt out with mono={false}.
 */
import type { TextareaHTMLAttributes, CSSProperties, Ref } from "react";

const baseStyle: CSSProperties = {
  minHeight: 80,
  padding: "7px 10px",
  fontSize: 13,
  width: "100%",
  resize: "vertical",
};

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Monospace text; defaults to true (configs and JSON payloads). */
  mono?: boolean;
  /** React 19 ref prop, forwarded to the underlying textarea element. */
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ mono = true, className, style, ref, ...rest }: TextareaProps) {
  const classes = ["pi-input", className].filter(Boolean).join(" ");
  const layout: CSSProperties = {
    ...baseStyle,
    ...(mono ? { fontFamily: "var(--font-mono)" } : undefined),
    ...style,
  };

  return <textarea ref={ref} className={classes} style={layout} {...rest} />;
}
