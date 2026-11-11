import { useI18n } from "@/i18n";

export function AuthReplacementNotice({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 6, display: "grid", gap: 10 }}
    >
      <span style={{ fontSize: 12 }}>
        {t(
          "modelAuthReplacementNotice",
          "Switching authentication replaces the credential currently saved for this provider.",
        )}
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="pi-btn pi-btn-primary"
          style={{ padding: "6px 12px", borderRadius: 5, fontSize: 12 }}
          onClick={onConfirm}
        >
          {t("modelConfirmAuthSwitch", "Switch authentication")}
        </button>
        <button className="pi-btn" style={{ padding: "6px 12px", borderRadius: 5, fontSize: 12 }} onClick={onCancel}>
          {t("cancel", "Cancel")}
        </button>
      </div>
    </div>
  );
}
