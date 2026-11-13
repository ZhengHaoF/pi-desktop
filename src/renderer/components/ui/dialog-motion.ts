/**
 * Motion plumbing for the shared Dialog shell. Motion is skipped outright
 * without a real window.matchMedia — stub test environments assert instant
 * mount/unmount — and when the OS asks for reduced motion.
 */

/**
 * Motion is skipped without a real window.matchMedia — stub test
 * environments assert instant mount/unmount, and reduce-motion users get
 * dialogs without the scale/fade.
 */
export function dialogMotionEnabled(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Keep in sync with the `pi-dialog-*-exit` animation durations in globals.css. */
export const DIALOG_EXIT_MS = 150;
