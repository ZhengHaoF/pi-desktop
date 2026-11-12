/**
 * Centered modal dialog: backdrop + card + real focus trap. Portals to
 * document.body; locks body scroll while open.
 *
 * The shell only — content, buttons and form handling stay with the caller.
 * Escape closes (unless closeOnEscape is false: dialogs whose Escape has its
 * own meaning, like the authorization deny flow); backdrop clicks close
 * (unless closeOnBackdrop is false: gated confirmations).
 */
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  /** Card width; number is treated as px. */
  width?: number | string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  width = 480,
  closeOnBackdrop = true,
  closeOnEscape = true,
  className,
  style,
  children,
}: DialogProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Lock body scroll for the lifetime of the dialog.
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && closeOnEscape) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      // Real focus trap: cycle Tab within the card, never escape it.
      const card = cardRef.current;
      if (!card) return;
      const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.getClientRects().length > 0,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        card.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !card.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !card.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, closeOnEscape, onClose]);

  // Move focus into the card once mounted so Tab cycles from the top.
  useLayoutEffect(() => {
    if (!open) return;
    cardRef.current?.focus();
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.38)",
      }}
      onClick={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        tabIndex={-1}
        className={className}
        style={{
          width: typeof width === "number" ? `min(${width}px, 100%)` : width,
          // Layout-neutral card: density (padding/gap) belongs to callers —
          // confirmation dialogs pass their own, shells (the settings window)
          // run flush so their internal chrome reaches the card edges.
          display: "grid",
          border: "1px solid var(--border)",
          borderRadius: 9,
          background: "var(--bg-panel)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          outline: "none",
          ...style,
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
