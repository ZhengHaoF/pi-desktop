/**
 * Tracks a trigger element's viewport rect while a portal popover is open,
 * refreshing on resize/scroll (capture) and on trigger size changes so
 * fixed-position panels stay glued to their anchor. Extracted from the
 * composer model-dropdown positioning logic.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";

export interface PopoverRect {
  top: number;
  left: number;
  width: number;
  bottom: number;
}

export function usePopoverAnchor<T extends HTMLElement>(open: boolean) {
  const anchorRef = useRef<T | null>(null);
  const [rect, setRect] = useState<PopoverRect | null>(null);

  const update = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const next = anchor.getBoundingClientRect();
    const value: PopoverRect = { top: next.top, left: next.left, width: next.width, bottom: next.bottom };
    setRect((previous) =>
      previous &&
      previous.top === value.top &&
      previous.left === value.left &&
      previous.width === value.width &&
      previous.bottom === value.bottom
        ? previous
        : value,
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    update();

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => update());
    if (anchorRef.current) observer?.observe(anchorRef.current);

    const visualViewport = window.visualViewport;
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    visualViewport?.addEventListener("resize", update);
    visualViewport?.addEventListener("scroll", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      visualViewport?.removeEventListener("resize", update);
      visualViewport?.removeEventListener("scroll", update);
    };
  }, [open, update]);

  return { anchorRef, rect, update };
}
