import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/Button";

/**
 * Full-screen image preview overlay.
 * Closes on Escape, close-button click, or a click on the backdrop.
 */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  const { t } = useI18n();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("imageLightboxTitle", "Image preview")}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        background: "rgba(0, 0, 0, 0.84)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        cursor: "zoom-out",
      }}
    >
      <img
        src={src}
        alt={alt ?? ""}
        onClick={(event) => event.stopPropagation()}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          borderRadius: 8,
          boxShadow: "0 12px 48px rgba(0, 0, 0, 0.55)",
          cursor: "default",
        }}
      />
      <Button
        type="button"
        variant="ghost"
        onClick={onClose}
        title={t("close", "Close")}
        aria-label={t("close", "Close")}
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          width: 36,
          height: 36,
          borderRadius: 18,
          border: "1px solid rgba(255, 255, 255, 0.35)",
          background: "rgba(0, 0, 0, 0.45)",
          color: "#fff",
          fontSize: 20,
          lineHeight: "32px",
        }}
      >
        ×
      </Button>
    </div>,
    document.body,
  );
}

/**
 * A message image that opens the full-size preview when clicked
 * (or activated with Enter/Space from the keyboard).
 */
export function EnlargableImage({
  onClick,
  onKeyDown,
  tabIndex,
  style,
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  const [open, setOpen] = useState(false);
  const src = typeof props.src === "string" ? props.src : undefined;
  return (
    <>
      <img
        {...props}
        tabIndex={tabIndex ?? 0}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || !src) return;
          event.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || !src) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }
        }}
        style={{ cursor: src ? "zoom-in" : undefined, ...style }}
      />
      {open && src ? (
        <ImageLightbox
          src={src}
          alt={typeof props.alt === "string" ? props.alt : undefined}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
