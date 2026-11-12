import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { call } from "@/lib/api-client";
import { mergeDiscoveredModels, type ProviderEntry } from "@/lib/models-config-state";
import { useI18n } from "@/i18n";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import type { DiscoveredModel } from "@contract/types";
import { Button } from "@/components/ui/Button";

function connectionKey(provider: ProviderEntry): string {
  return JSON.stringify([provider.baseUrl, provider.api, provider.apiKey, provider.headers]);
}

type DiscoveryState =
  | { phase: "idle" }
  | { phase: "loading"; source: string }
  | { phase: "error"; source: string; message: string; unsupported: boolean }
  | { phase: "ready"; source: string; models: DiscoveredModel[]; baseUrl: string; added: number };

export function ProviderModelDiscovery({
  provider,
  onChange,
}: {
  provider: ProviderEntry;
  onChange: (provider: ProviderEntry) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<DiscoveryState>({ phase: "idle" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const latest = useRef({ provider, onChange });
  const generation = useRef(0);
  useLayoutEffect(() => {
    latest.current = { provider, onChange };
  });
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const source = connectionKey(provider);
  const current = state.phase !== "idle" && state.source === source ? state : { phase: "idle" as const };
  const supported = provider.api !== "google-generative-ai";
  const busy = current.phase === "loading";
  const ready = current.phase === "ready" ? current : null;

  const close = () => {
    setState({ phase: "idle" });
    setQuery("");
    setSelected(new Set());
  };

  const discover = async () => {
    if (busy || !supported || !provider.baseUrl?.trim()) return;
    const request = ++generation.current;
    setQuery("");
    setSelected(new Set());
    setState({ phase: "loading", source });
    const isCurrent = () => request === generation.current && connectionKey(latest.current.provider) === source;
    try {
      const result = await call("modelsConfig.discover", { provider });
      if (!isCurrent()) return;
      if (!result.ok) {
        setState({ phase: "error", source, message: result.error, unsupported: result.unsupported === true });
        return;
      }
      setState({ phase: "ready", source, models: result.models, baseUrl: result.baseUrl, added: 0 });
    } catch (error) {
      if (isCurrent())
        setState({
          phase: "error",
          source,
          message: error instanceof Error ? error.message : String(error),
          unsupported: false,
        });
    }
  };

  const addedIds = new Set((provider.models ?? []).map((model) => model.id).filter(Boolean));
  const models = ready?.models ?? [];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleModels = normalizedQuery
    ? models.filter(
        (model) =>
          model.id.toLowerCase().includes(normalizedQuery) || model.name?.toLowerCase().includes(normalizedQuery),
      )
    : models;
  const pendingSelected = models.filter((model) => selected.has(model.id) && !addedIds.has(model.id));
  const selectableVisible = visibleModels.filter((model) => !addedIds.has(model.id));
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((model) => selected.has(model.id));

  const toggle = (id: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const selectAllVisible = (checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const model of selectableVisible) {
        if (checked) next.add(model.id);
        else next.delete(model.id);
      }
      return next;
    });
  };

  const addSelected = () => {
    if (!ready || pendingSelected.length === 0) return;
    const merged = mergeDiscoveredModels(latest.current.provider, pendingSelected, ready.baseUrl);
    latest.current.onChange(merged.provider);
    setSelected(new Set());
    setState({ ...ready, source: connectionKey(merged.provider), added: merged.added });
  };

  const disabled = busy || !supported || !provider.baseUrl?.trim();
  const subtleLayout: React.CSSProperties = {
    minHeight: 30,
    padding: "0 12px",
    borderRadius: 5,
    fontSize: 12,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Button
        type="button"
        onClick={() => void discover()}
        disabled={disabled}
        style={{ alignSelf: "flex-start", minHeight: 32, padding: "0 12px", borderRadius: 4, fontSize: 12 }}
      >
        {busy ? t("modelDiscovering", "Fetching models…") : t("modelDiscover", "Fetch model list")}
      </Button>
      {supported ? (
        <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
          {t(
            "modelDiscoverHint",
            "Fetch models from an OpenAI-compatible /models endpoint using this URL and API key, then pick the ones to add. Existing settings are kept; save below to apply.",
          )}
        </span>
      ) : (
        <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
          {t(
            "modelImportUnsupported",
            "This provider API does not support fetching the model list. Add models manually.",
          )}
        </span>
      )}

      {current.phase === "error" && (
        <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
          <span style={{ color: "var(--danger)", lineHeight: 1.5, overflowWrap: "anywhere" }}>{current.message}</span>
          {!current.unsupported && (
            <Button type="button" onClick={() => void discover()} style={{ ...subtleLayout, alignSelf: "flex-start" }}>
              {t("modelImportRetry", "Retry")}
            </Button>
          )}
        </div>
      )}

      {ready && (
        <div
          role="group"
          aria-label={t("modelImportTitle", "Fetch model list")}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-panel)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "8px 12px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              {t("modelImportTitle", "Fetch model list")}
            </span>
            <Button
              type="button"
              onClick={close}
              title={t("modelImportClose", "Done")}
              aria-label={t("modelImportClose", "Done")}
              variant="ghost"
              style={{ width: 28, height: 28, padding: 0, borderRadius: 5, fontSize: 16, lineHeight: 1 }}
            >
              ×
            </Button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                color: "var(--text-muted)",
                cursor: selectableVisible.length === 0 ? "default" : "pointer",
                flexShrink: 0,
              }}
            >
              <Checkbox
                size="sm"
                checked={allVisibleSelected}
                disabled={selectableVisible.length === 0}
                onChange={selectAllVisible}
              />
              {t("modelImportSelectAll", "Select all results")}
            </label>
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("modelImportFilter", "Filter {count} models…").replace("{count}", String(models.length))}
              aria-label={t("modelImportFilterAria", "Filter fetched models")}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "5px 9px",
                fontSize: 12,
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
                  key={model.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    padding: "7px 12px",
                    borderTop: index > 0 ? "1px solid var(--border)" : undefined,
                    cursor: added ? "default" : "pointer",
                  }}
                >
                  <Checkbox
                    size="sm"
                    checked={added || selected.has(model.id)}
                    disabled={added}
                    onChange={(checked) => toggle(model.id, checked)}
                    style={{ cursor: added ? "default" : "pointer" }}
                  />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflowWrap: "anywhere" }}>
                    {model.name && model.name !== model.id ? model.name : model.id}
                  </span>
                  {model.name && model.name !== model.id && (
                    <code style={{ fontSize: 10, color: "var(--text-dim)", overflowWrap: "anywhere" }}>{model.id}</code>
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
              flexWrap: "wrap",
            }}
          >
            <span role="status" aria-live="polite" style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {ready.added > 0
                ? t(
                    "modelDiscoverSuccess",
                    "Found {found} models; added {added}. Review their capabilities before saving.",
                  )
                    .replace("{found}", String(models.length))
                    .replace("{added}", String(ready.added))
                : t("modelImportFetchedCount", "Fetched {count} models").replace("{count}", String(models.length))}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Button type="button" onClick={close} style={subtleLayout}>
                {t("modelImportClose", "Done")}
              </Button>
              <Button
                type="button"
                onClick={addSelected}
                disabled={pendingSelected.length === 0}
                variant="primary"
                style={{ minHeight: 30, padding: "0 14px", borderRadius: 5, fontSize: 12, fontWeight: 600 }}
              >
                {t("modelImportAddSelectedCount", "Add selected models ({count})").replace(
                  "{count}",
                  String(pendingSelected.length),
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
