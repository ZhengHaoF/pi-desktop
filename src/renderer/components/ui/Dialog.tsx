/**
 * Centered modal dialog: backdrop + card + real focus trap. Portals to
 * document.body; locks body scroll while open. Enters with a plain scale +
 * fade and exits back into it; motion is skipped outright when the OS asks
 * for reduced motion (and in stub test environments, where the shell mounts
 * and unmounts instantly).
 *
 * The shell only — content, buttons and form handling stay with the caller.
 * Escape closes (unless closeOnEscape is false: dialogs whose Escape has its
 * own meaning, like the authorization deny flow); backdrop clicks close
 * (unless closeOnBackdrop is false: gated confirmations).
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DIALOG_EXIT_MS, dialogMotionEnabled } from "./dialog-motion";

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
  /**
   * Skip the enter animation but keep the exit. For a dialog that replaces an
   * already-visible loading frame: animating in again reads as a second
   * dialog popping up. Enter is skipped only on first mount; later open
   * cycles animate as usual.
   */
  animateEnter?: boolean;
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
  animateEnter = true,
  className,
  style,
  children,
}: DialogProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(open);
  const [exiting, setExiting] = useState(false);
  const animate = dialogMotionEnabled();
  // animateEnter=false skips only the FIRST appearance (loading-frame
  // handoff); once the shell has closed once, later opens animate as usual.
  const skipEnterRef = useRef(!animateEnter);
  const skipEnter = skipEnterRef.current && !exiting;
  if (exiting) skipEnterRef.current = false;

  // Mount/unmount state machine: hold the portal through the exit animation
  // before dropping it. Reopening mid-exit cancels the drop and replays the
  // enter animation.
  useEffect(() => {
    if (open) {
      setExiting(false);
      setMounted(true);
      return;
    }
    if (!animate) {
      setExiting(false);
      setMounted(false);
      return;
    }
    setExiting(true);
    const timer = setTimeout(() => {
      setExiting(false);
      setMounted(false);
    }, DIALOG_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, animate]);

  // Lock body scroll for the lifetime of the portal (through the exit too).
  useLayoutEffect(() => {
    if (!mounted) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mounted]);

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

  if (!mounted || typeof document === "undefined") return null;

  // Enter classes are suppressed when the caller asked to skip the first
  // enter (loading-frame handoff); the exit always animates.
  const entering = animate && !skipEnter && !exiting;
  const backdropClassName = animate
    ? exiting
      ? "pi-dialog-backdrop-exit"
      : entering
        ? "pi-dialog-backdrop-enter"
        : undefined
    : undefined;
  const cardClassName = [
    animate ? (exiting ? "pi-dialog-card-exit" : entering ? "pi-dialog-card-enter" : "") : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return createPortal(
    <div
      className={backdropClassName}
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
        if (exiting) return;
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
        className={cardClassName}
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
