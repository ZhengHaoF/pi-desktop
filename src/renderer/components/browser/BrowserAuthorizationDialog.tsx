import { useEffect, useRef, type CSSProperties } from "react";
import { useI18n } from "@/i18n";
import type { BrowserAgentAuthorizationDecision, BrowserAgentAuthorizationRequest } from "../../../contract/browser";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";

export function BrowserAuthorizationDialog({
  request,
  sessionTitle,
  onRespond,
  onManage,
}: {
  request: BrowserAgentAuthorizationRequest;
  sessionTitle: string;
  onRespond: (decision: BrowserAgentAuthorizationDecision) => void;
  onManage: () => void;
}) {
  const { t } = useI18n();
  const denyRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    denyRef.current?.focus();
    const returnFocus = returnFocusRef.current;
    return () => returnFocus?.focus();
  }, []);

  const permissionLabel =
    request.minimumPermission === "read"
      ? t("browserAuthorizationRead", "Read pages")
      : request.minimumPermission === "interact"
        ? t("browserAuthorizationInteract", "Interact with pages")
        : t("browserAuthorizationAdvanced", "Use Advanced Browser Mode");
  const capability =
    request.minimumPermission === "read"
      ? t(
          "browserAuthorizationReadSummary",
          "The Agent can open pages, navigate, read page snapshots, and take screenshots.",
        )
      : request.minimumPermission === "interact"
        ? t(
            "browserAuthorizationInteractSummary",
            "The Agent can also click, type, press keys, and scroll in Browser tabs owned by this session.",
          )
        : t(
            "browserAuthorizationAdvancedSummary",
            "The Agent can also execute JavaScript, inspect captured network data, replay requests, and use CDP.",
          );

  return (
    <Dialog
      open
      onClose={() => onRespond("deny")}
      closeOnEscape={false}
      width={520}
      ariaLabelledBy="browser-agent-authorization-title"
      ariaDescribedBy="browser-agent-authorization-description"
      style={{
        maxHeight: "min(680px, calc(100dvh - 40px))",
        overflowY: "auto",
        gap: 16,
        padding: "22px",
        borderRadius: 12,
        boxShadow: "0 24px 80px rgba(0,0,0,0.35)",
      }}
    >
      <div>
        <h2 id="browser-agent-authorization-title" style={{ margin: 0, fontSize: 18 }}>
          {t("browserAuthorizationTitle", "Allow Agent Browser access?")}
        </h2>
        <p
          id="browser-agent-authorization-description"
          style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: 13, lineHeight: 1.55 }}
        >
          {t(
            "browserAuthorizationDescription",
            "Pi Desktop paused the Browser tool before it made any page, network, or input changes.",
          )}
        </p>
      </div>
      <dl
        style={{
          margin: 0,
          display: "grid",
          gridTemplateColumns: "minmax(90px, auto) minmax(0, 1fr)",
          gap: "8px 14px",
          fontSize: 13,
        }}
      >
        <dt style={{ color: "var(--text-muted)" }}>{t("browserAuthorizationSession", "Session")}</dt>
        <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{sessionTitle}</dd>
        <dt style={{ color: "var(--text-muted)" }}>{t("browserAuthorizationSource", "Source")}</dt>
        <dd style={{ margin: 0 }}>
          {request.source === "channel"
            ? t("browserAuthorizationSourceChannel", "Approved messaging channel")
            : t("browserAuthorizationSourceLocal", "Local desktop session")}
        </dd>
        <dt style={{ color: "var(--text-muted)" }}>{t("browserAuthorizationPermission", "Permission")}</dt>
        <dd style={{ margin: 0 }}>{permissionLabel}</dd>
      </dl>
      <div
        style={{
          padding: 12,
          borderRadius: 8,
          background: "color-mix(in srgb, var(--accent) 8%, var(--bg))",
          fontSize: 13,
          lineHeight: 1.55,
        }}
      >
        {capability}
      </div>
      <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>
        {t(
          "browserAuthorizationSessionOnly",
          "Allowing here lasts only for this running Agent session. Permanent permissions can only be saved in Browser settings.",
        )}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Button type="button" onClick={onManage} style={buttonStyle}>
          {t("browserAuthorizationManage", "Manage permanent permission…")}
        </Button>
        <Button ref={denyRef} type="button" onClick={() => onRespond("deny")} style={buttonStyle}>
          {t("browserDeny", "Deny")}
        </Button>
        <Button type="button" onClick={() => onRespond("allow-session")} variant="primary" style={primaryButtonStyle}>
          {t("browserAllowCurrentAgentSession", "Allow current Agent session")}
        </Button>
      </div>
    </Dialog>
  );
}

const buttonStyle: CSSProperties = {
  minHeight: 34,
  padding: "0 12px",
  borderRadius: 6,
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
};
