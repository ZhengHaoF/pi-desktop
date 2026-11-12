/**
 * Decorative status dot: a small circle whose color carries state (running,
 * error, unread…). Purely presentational — it renders no accessible content
 * of its own, so pair it with adjacent text or a title when the state must
 * be announced.
 */
import type { CSSProperties } from "react";

export type StatusDotSize = "sm" | "md";

const SEMANTIC: Record<string, string> = {
  accent: "var(--accent)",
  success: "var(--success)",
  danger: "var(--danger)",
  warning: "var(--warning)",
  muted: "var(--text-dim)",
  border: "var(--border)",
};

const sizePx: Record<StatusDotSize, number> = {
  sm: 6,
  md: 8,
};

export interface StatusDotProps {
  /** Semantic name or any CSS color; semantic names win over raw values. */
  color?: keyof typeof SEMANTIC | (string & {});
  size?: StatusDotSize;
  /** Loop the shared pulse animation (running states). */
  pulse?: boolean;
  /** Optional glow ring, e.g. watch indicators. */
  boxShadow?: CSSProperties["boxShadow"];
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function StatusDot({ color = "muted", size = "md", pulse, boxShadow, title, className, style }: StatusDotProps) {
  const background = SEMANTIC[color] ?? color;

  return (
    <span
      role="presentation"
      title={title}
      className={["pi-status-dot", className].filter(Boolean).join(" ")}
      data-pulse={pulse ? "true" : undefined}
      style={{ width: sizePx[size], height: sizePx[size], background, boxShadow, ...style }}
    />
  );
}
