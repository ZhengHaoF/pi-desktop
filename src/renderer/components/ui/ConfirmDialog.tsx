/**
 * Standard confirmation/alert dialog on the shared Dialog shell: title,
 * optional message, confirm/cancel buttons. Confirmations are gated (backdrop
 * inert, Escape cancels); alerts (cancelLabel: null) show a single
 * acknowledgement button and dismiss on backdrop too.
 *
 * Render `dialog` from useConfirm() once per component; `confirm()` returns a
 * promise resolving true (confirmed) / false (dismissed or superseded), so
 * window.confirm/window.alert call sites become awaited calls.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/i18n";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

export interface ConfirmRequest {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  /** null hides the cancel button (alert style). */
  cancelLabel?: string | null;
  danger?: boolean;
}

export interface ConfirmDialogProps extends ConfirmRequest {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const alertStyle = cancelLabel === null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel={title}
      width={420}
      closeOnBackdrop={alertStyle}
      style={{ padding: 18, gap: 13, background: "var(--bg)", boxShadow: "0 16px 48px rgba(0,0,0,0.3)" }}
    >
      <h3 style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{title}</h3>
      {message != null && message !== "" && (
        <p style={{ margin: "8px 0 16px", fontSize: 12, lineHeight: 1.55, color: "var(--text-muted)" }}>{message}</p>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {!alertStyle && (
          <Button type="button" onClick={onClose}>
            {cancelLabel ?? t("cancel", "Cancel")}
          </Button>
        )}
        <Button type="button" variant={alertStyle ? "default" : danger ? "danger" : "primary"} onClick={onConfirm}>
          {confirmLabel ?? (alertStyle ? t("ok", "OK") : t("confirm", "Confirm"))}
        </Button>
      </div>
    </Dialog>
  );
}

export interface UseConfirmResult {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  dialog: ReactNode;
}

export function useConfirm(): UseConfirmResult {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [open, setOpen] = useState(false);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);
  // Settle a pending confirm as dismissed on unmount so awaiting callers never
  // hang on a dialog that no longer exists.
  useEffect(() => () => resolverRef.current?.(false), []);
  const confirm = useCallback((next: ConfirmRequest) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current?.(false);
      resolverRef.current = resolve;
      setRequest(next);
      setOpen(true);
    });
  }, []);
  // Keep the last request rendered while the shell plays its exit animation —
  // clearing it here would leave the card shrinking with empty content.
  const settle = useCallback((value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setOpen(false);
  }, []);
  const dialog = (
    <ConfirmDialog
      open={open}
      onClose={() => settle(false)}
      onConfirm={() => settle(true)}
      title={request?.title ?? ""}
      message={request?.message}
      confirmLabel={request?.confirmLabel}
      cancelLabel={request?.cancelLabel}
      danger={request?.danger}
    />
  );
  return { confirm, dialog };
}
