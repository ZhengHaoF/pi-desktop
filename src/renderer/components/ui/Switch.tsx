/**
 * Track-and-knob switch for on/off state. Built on Button with the shared
 * `.pi-switch` class; the knob is an absolutely positioned circle animated by
 * `left`. Accessibility uses the switch pattern (`role="switch"` +
 * `aria-checked`) rather than a pressed toggle.
 */
import { useId, type CSSProperties } from "react";
import { Button } from "./Button";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Saved/pending state; renders the busy cursor and dims the track. */
  loading?: boolean;
  /** Accessible name; required because the control has no visible text. */
  "aria-label": string;
  title?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Switch({ checked, onChange, loading, title, disabled, className, style, ...rest }: SwitchProps) {
  const switchId = useId();

  return (
    <Button
      type="button"
      id={switchId}
      role="switch"
      aria-checked={checked}
      aria-label={rest["aria-label"]}
      title={title}
      disabled={disabled || loading}
      className={["pi-switch", className].filter(Boolean).join(" ")}
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        // Button's md preset injects min-height: 32; min-height beats height
        // in CSS, so without pinning this the track renders 32px tall and the
        // 11px radius stops being a pill.
        minHeight: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: loading ? "wait" : "pointer",
        background: checked ? "var(--accent)" : "var(--border)",
        position: "relative",
        outline: "none",
        opacity: loading ? 0.65 : 1,
        ...style,
      }}
      onClick={() => onChange(!checked)}
    >
      <span
        style={{
          position: "absolute",
          top: "50%",
          left: checked ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
          transform: "translateY(-50%)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </Button>
  );
}
