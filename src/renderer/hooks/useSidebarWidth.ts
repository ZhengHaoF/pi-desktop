import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { clampSidebarWidth } from "@/lib/layout-preferences";
import { initialSidebarPreferredWidth, persistSidebarPreferredWidth } from "@/lib/panel-preferences";
import { useIsMobile } from "./useIsMobile";

export interface SidebarWidthControls {
  /** Current sidebar width in pixels; CSS ignores it while the sidebar is closed. */
  sidebarWidth: number;
  /** True while a pointer drag is in flight, so the width transition can be suppressed. */
  sidebarResizing: boolean;
  /** Pointer-down handler for the drag separator on the sidebar's right edge. */
  startSidebarResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

/**
 * Owns the resizable desktop sidebar width: pointer dragging, viewport clamping
 * and localStorage persistence. Mirrors the right panel's resize contract
 * without keyboard resizing.
 */
export function useSidebarWidth(): SidebarWidthControls {
  const isMobile = useIsMobile();
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clampSidebarWidth(initialSidebarPreferredWidth(), window.innerWidth),
  );
  // The width the user asked for, kept unclamped by later viewport changes so a
  // temporarily narrow window does not forget a wider preference.
  const preferredWidthRef = useRef(sidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  const startSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isMobile || event.button !== 0) return;
      event.preventDefault();
      resizeCleanupRef.current?.();

      const startX = event.clientX;
      const startWidth = sidebarWidth;
      let finalWidth = startWidth;
      let didResize = false;

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.clientX !== startX) didResize = true;
        // The separator sits on the sidebar's right edge: dragging right widens it.
        finalWidth = clampSidebarWidth(startWidth + (moveEvent.clientX - startX), window.innerWidth);
        setSidebarWidth(finalWidth);
      };
      const cleanup = (commit: boolean) => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerCancel);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setSidebarResizing(false);
        resizeCleanupRef.current = null;
        if (commit && didResize) {
          preferredWidthRef.current = finalWidth;
          persistSidebarPreferredWidth(finalWidth);
        }
      };
      const handlePointerUp = () => cleanup(true);
      const handlePointerCancel = () => cleanup(false);

      resizeCleanupRef.current = () => cleanup(false);
      setSidebarResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerCancel);
    },
    [isMobile, sidebarWidth],
  );

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  // A narrower viewport (or the window moving to a smaller screen) must pull an
  // over-wide sidebar back inside its bounds. The preferred width survives, so
  // widening the window again restores it.
  useEffect(() => {
    const fitToWindow = () => setSidebarWidth(clampSidebarWidth(preferredWidthRef.current, window.innerWidth));
    window.addEventListener("resize", fitToWindow);
    return () => window.removeEventListener("resize", fitToWindow);
  }, []);

  return { sidebarWidth, sidebarResizing, startSidebarResize };
}
