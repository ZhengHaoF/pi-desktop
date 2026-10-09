import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { call } from "@/lib/api-client";
import type { ModelEntry, ProviderEntry } from "@/lib/models-config-state";
import type { ProviderModelInfo } from "@contract/types";

type ImportPhase =
  | { kind: "loading" }
  | { kind: "ready"; models: ProviderModelInfo[] }
  | { kind: "error"; message: string; unsupported: boolean };

type ImportRequest = { providerName: string; provider: ProviderEntry };

/**
 * Inline "fetch model list" panel for a provider. Lists the provider's remote
 * catalog and merges the chosen entries into the provider's model list; the
 * editor still owns persistence, so nothing is written until the user saves.
 */
export function ImportModelsPanel({
  providerName,
  provider,
  onImport,
  onClose,
}: {
  providerName: string;
  provider: ProviderEntry;
  onImport: (models: ModelEntry[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // Capture the form values at open time; retry re-reads the latest ones.
  const [request, setRequest] = useState<ImportRequest>(() => ({ providerName, provider }));
  const [phase, setPhase] = useState<ImportPhase>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const filterInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "loading" });
    setSelected(new Set());
    call("modelsConfig.listModels", { providerName: request.providerName, provider: request.provider })
      .then((result) => {
        if (cancelled) return;
        if (result.ok && result.models) {
          setPhase({ kind: "ready", models: result.models });
          setTimeout(() => filterInputRef.current?.focus(), 30);
          return;
        }
        setPhase({
          kind: "error",
          message: result.error ?? t("modelImportFailed", "Failed to fetch the model list."),
          unsupported: result.unsupported === true,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
          unsupported: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [request, t]);

  const addedIds = useMemo(
    () => new Set((provider.models ?? []).map((model) => model.id).filter(Boolean)),
    [provider.models],
  );
  const models = phase.kind === "ready" ? phase.models : [];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleModels = normalizedQuery
    ? models.filter(
        (model) =>
          model.id.toLowerCase().includes(normalizedQuery) || model.name?.toLowerCase().includes(normalizedQuery),
      )
    : models;
  // Selections that are still pending (already-imported rows flip to "Added").
  const pendingSelected = visibleModels.filter((model) => selected.has(model.id) && !addedIds.has(model.id));
  const selectableVisible = visibleModels.filter((model) => !addedIds.has(model.id));
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((model) => selected.has(model.id));

  const toggle = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleImport = () => {
    if (pendingSelected.length === 0) return;
    onImport(pendingSelected.map((model) => (model.name ? { id: model.id, name: model.name } : { id: model.id })));
    setSelected(new Set());
  };

  const panelStyle: React.CSSProperties = {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-panel)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  };
  const headerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "8px 12px",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  };
  const secondaryButtonStyle: React.CSSProperties = {
    minHeight: 30,
    padding: "0 12px",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: 5,
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 12,
  };

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
          {t("modelImportTitle", "Fetch model list")}
        </span>
        <button
          type="button"
          onClick={onClose}
          title={t("modelImportClose", "Done")}
          aria-label={t("modelImportClose", "Done")}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            width: 28,
            height: 28,
            padding: 0,
            borderRadius: 5,
          }}
        >
          ×
        </button>
      </div>

      {phase.kind === "loading" && (
        <div style={{ padding: "18px 12px", fontSize: 12, color: "var(--text-muted)" }}>
          {t("modelImportLoading", "Fetching model list…")}
        </div>
      )}

      {phase.kind === "error" && (
        <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 12, color: "#f87171", lineHeight: 1.5, overflowWrap: "anywhere" }}>
            {phase.unsupported
              ? t(
                  "modelImportUnsupported",
                  "This provider API does not support fetching the model list. Add models manually.",
                )
              : phase.message}
          </span>
          {!phase.unsupported && (
            <button
              type="button"
              onClick={() => setRequest({ providerName, provider })}
              style={{ ...secondaryButtonStyle, alignSelf: "flex-start" }}
            >
              {t("modelImportRetry", "Retry")}
            </button>
          )}
        </div>
      )}

      {phase.kind === "ready" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", flexShrink: 0 }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={allVisibleSelected}
                disabled={selectableVisible.length === 0}
                onChange={(event) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    for (const model of selectableVisible) {
                      if (event.target.checked) next.add(model.id);
                      else next.delete(model.id);
                    }
                    return next;
                  })
                }
                style={{ width: 15, height: 15, margin: 0, accentColor: "var(--accent)", cursor: "pointer" }}
              />
              {t("modelImportSelectAll", "Select all results")}
            </label>
            <input
              ref={filterInputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("modelImportFilter", "Filter {count} models…").replace("{count}", String(models.length))}
              aria-label={t("modelImportFilterAria", "Filter fetched models")}
              style={{
                flex: 1,
                minWidth: 0,
                boxSizing: "border-box",
                padding: "5px 9px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: "var(--text)",
                fontSize: 12,
                outline: "none",
              }}
            />
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              maxHeight: 260,
              overflowY: "auto",
              borderTop: "1px solid var(--border)",
            }}
          >
            {visibleModels.length === 0 && (
              <span style={{ padding: "12px", color: "var(--text-muted)", fontSize: 12 }}>
                {models.length === 0
                  ? t("modelImportEmpty", "The provider returned an empty model list.")
                  : t("modelNoMatchingModels", "No matching models.")}
              </span>
            )}
            {visibleModels.map((model, index) => {
              const added = addedIds.has(model.id);
              return (
                <label
                  key={`${model.id}-${index}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    padding: "7px 12px",
                    borderTop: index > 0 ? "1px solid var(--border)" : undefined,
                    cursor: added ? "default" : "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={added || selected.has(model.id)}
                    disabled={added}
                    onChange={(event) => toggle(model.id, event.target.checked)}
                    style={{
                      width: 15,
                      height: 15,
                      margin: 0,
                      accentColor: "var(--accent)",
                      flexShrink: 0,
                      cursor: added ? "default" : "pointer",
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflowWrap: "anywhere" }}>
                    {model.name && model.name !== model.id ? model.name : model.id}
                  </span>
                  {model.name && model.name !== model.id && (
                    <code
                      style={{
                        fontSize: 10,
                        color: "var(--text-dim)",
                        fontFamily: "var(--font-mono)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {model.id}
                    </code>
                  )}
                  {added && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: "1px 6px",
                        borderRadius: 3,
                        background: "var(--bg-hover)",
                        color: "var(--text-dim)",
                        flexShrink: 0,
                      }}
                    >
                      {t("modelImportAlreadyAdded", "Added")}
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "8px 12px",
              borderTop: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {t("modelImportFetchedCount", "Fetched {count} models").replace("{count}", String(models.length))}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button type="button" onClick={onClose} style={secondaryButtonStyle}>
                {t("modelImportClose", "Done")}
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={pendingSelected.length === 0}
                style={{
                  minHeight: 30,
                  padding: "0 14px",
                  background: pendingSelected.length === 0 ? "var(--bg-hover)" : "var(--accent)",
                  border: "none",
                  borderRadius: 5,
                  color: pendingSelected.length === 0 ? "var(--text-dim)" : "#fff",
                  cursor: pendingSelected.length === 0 ? "not-allowed" : "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {t("modelImportAddSelectedCount", "Add selected models ({count})").replace(
                  "{count}",
                  String(pendingSelected.length),
                )}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
