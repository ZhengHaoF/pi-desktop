import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps } from "react";
import { useI18n } from "@/i18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Button } from "@/components/ui/Button";
import { DIALOG_EXIT_MS, dialogMotionEnabled } from "@/components/ui/dialog-motion";

type SettingsConfigModule = { default: typeof import("./SettingsConfig").SettingsConfig };

let settingsConfigLoad: Promise<SettingsConfigModule> | null = null;

// Shared by the idle/hover preload and React.lazy so the chunk is fetched once; a failed preload resets so the
// next attempt (including the click itself) retries.
export function preloadSettingsConfig(): Promise<SettingsConfigModule> {
  settingsConfigLoad ??= import("./SettingsConfig").then(
    (module) => ({ default: module.SettingsConfig }),
    (error: unknown) => {
      settingsConfigLoad = null;
      throw error;
    },
  );
  return settingsConfigLoad;
}

// Synchronous peek at the shared cache: non-null only when the chunk has
// already fully loaded, so a dialog can render without any loading frame.
let settingsConfigModule: SettingsConfigModule | null = null;
preloadSettingsConfig().then(
  (module) => {
    settingsConfigModule = module;
  },
  () => undefined,
);
export function peekSettingsConfigModule(): SettingsConfigModule | null {
  return settingsConfigModule;
}

export function scheduleSettingsConfigPreload(): () => void {
  const handle = window.requestIdleCallback(
    () => {
      void preloadSettingsConfig().catch(() => undefined);
    },
    { timeout: 5000 },
  );
  return () => window.cancelIdleCallback(handle);
}

const LazyTerminalDock = lazy(() =>
  import("./herdr/TerminalDock").then((module) => ({ default: module.TerminalDock })),
);

function PanelLoading() {
  const { t } = useI18n();
  return (
    <div role="status" style={{ padding: 16 }}>
      {t("loading", "Loading…")}
    </div>
  );
}

// Mirrors the SettingsConfig backdrop and dialog frame so a slow chunk load never covers the window opaquely, and
// stays dismissible (close button, Escape, backdrop click) with focus held on its close button.
function SettingsLoading({
  onClose,
  returnFocusTarget,
}: {
  onClose: () => void;
  returnFocusTarget: HTMLElement | null;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    // When the real dialog replaces this frame its own mount effect moves focus again, so restoring here only
    // sticks when Settings closes before the chunk arrives.
    return () => {
      returnFocusTarget?.focus();
    };
  }, [returnFocusTarget]);

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-busy="true"
        aria-label={t("settings", "Settings")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "Tab") {
            event.preventDefault();
            closeButtonRef.current?.focus();
          }
        }}
        tabIndex={-1}
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 960,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "82vh",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "13px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{t("settings", "Settings")}</div>
            {!isMobile && (
              <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-dim)" }}>
                {t("settingsDescription", "Manage app preferences, models, skills, and plugins.")}
              </div>
            )}
          </div>
          <Button
            ref={closeButtonRef}
            type="button"
            variant="ghost"
            onClick={onClose}
            aria-label={t("close", "Close")}
            style={{
              fontSize: 20,
              lineHeight: 1,
              width: 36,
              height: 36,
              padding: 0,
              borderRadius: 7,
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ×
          </Button>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <div
            style={{
              width: isMobile ? 112 : 168,
              borderRight: "1px solid var(--border)",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          />
          <div
            role="status"
            style={{
              flex: 1,
              display: "grid",
              placeItems: "center",
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            {t("loading", "Loading…")}
          </div>
        </div>
      </div>
    </div>
  );
}

type SettingsConfigProps = ComponentProps<typeof import("./SettingsConfig").SettingsConfig>;

// Deferred visibility mirror: keeps the resolved panel mounted through the
// Dialog's exit fade. AppShell always renders this wrapper and only `open`
// flips, so the closing card animates out instead of disappearing in one
// commit; reopening mid-fade cancels the drop, and motion-disabled
// environments drop the panel immediately. The panel itself still remounts per
// open cycle (the hold drops it after the fade), preserving the
// fresh-state-per-open behavior of the old conditional render.
export function SettingsConfig(props: SettingsConfigProps) {
  // Per-open-cycle scratch: the wrapper is persistent, so these are
  // re-captured on each false→true edge instead of at mount.
  const focusTargetRef = useRef<HTMLElement | null>(null);
  const moduleAtOpenRef = useRef<SettingsConfigModule | null>(null);
  const animate = dialogMotionEnabled();
  const [heldOpen, setHeldOpen] = useState(props.open);
  useEffect(() => {
    if (props.open) {
      setHeldOpen(true);
      return;
    }
    if (!animate) {
      setHeldOpen(false);
      return;
    }
    const timer = setTimeout(() => setHeldOpen(false), DIALOG_EXIT_MS);
    return () => clearTimeout(timer);
  }, [props.open, animate]);

  // Resolve the chunk by hand instead of going through Suspense: when the
  // module is cached (hover/idle preload won the race) the real dialog renders
  // synchronously with its full enter animation; when it is not, the loading
  // frame shows and the real dialog takes over WITHOUT replaying the enter —
  // animating in over the already-visible frame read as the dialog popping
  // up twice. Read through a ref every render — the wrapper outlives open
  // cycles, so a mount-time useState snapshot would miss later preloads.
  const loadedModuleRef = useRef<SettingsConfigModule | null>(null);
  loadedModuleRef.current = peekSettingsConfigModule();
  const [chunkReady, setChunkReady] = useState(false);
  useEffect(() => {
    if (chunkReady || !heldOpen) return;
    let cancelled = false;
    void preloadSettingsConfig().then(
      () => {
        if (!cancelled) setChunkReady(true);
      },
      () => {
        // Keep the dismissible loading frame; the next open retries the load.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [chunkReady, heldOpen]);

  // Per-open-cycle snapshots, captured on the false→true edge during render
  // (the wrapper is persistent, so mount-time capture would go stale).
  const wasOpenRef = useRef(props.open);
  if (props.open && !wasOpenRef.current) {
    // Captured before the loading frame or the dialog takes focus, so closing
    // returns to the original opener.
    focusTargetRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A module already available on the open edge had no loading frame before
    // it, so its enter animation plays; one resolved after the frame showed
    // must skip it, or the handoff reads as a second dialog popping up.
    moduleAtOpenRef.current = loadedModuleRef.current;
  }
  wasOpenRef.current = props.open;

  const skipEnter = loadedModuleRef.current !== null && moduleAtOpenRef.current === null;
  if (!heldOpen) return null;
  if (loadedModuleRef.current) {
    const SettingsConfigPanel = loadedModuleRef.current.default;
    return <SettingsConfigPanel {...props} returnFocusTarget={focusTargetRef.current} animateEnter={!skipEnter} />;
  }
  return <SettingsLoading onClose={props.onClose} returnFocusTarget={focusTargetRef.current} />;
}
export function TerminalDock(props: ComponentProps<typeof LazyTerminalDock>) {
  return (
    <Suspense fallback={<PanelLoading />}>
      <LazyTerminalDock {...props} />
    </Suspense>
  );
}
