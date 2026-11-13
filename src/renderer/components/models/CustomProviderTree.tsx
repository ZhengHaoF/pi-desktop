import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { ModelsConfigSelection, ProviderEntry } from "@/lib/models-config-state";

// The shared Button injects inline layout presets (inline-flex, centered
// justify-content, 5px/12px padding) and inline style beats any class rule in
// custom-model-settings.css, so the tree re-declares its row layout via style
// per docs/ui-components.md ("布局覆盖走 style").
const toggleStyle: CSSProperties = { padding: 0 };
const providerNameStyle: CSSProperties = { gap: 8, minHeight: 36, padding: "5px 8px 5px 0" };
const modelRowStyle: CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  minHeight: 34,
  padding: 7,
};
const addModelStyle: CSSProperties = { ...modelRowStyle, fontSize: 11 };
const searchInputStyle: CSSProperties = { minHeight: 32, padding: "5px 8px", fontSize: 11 };

export function CustomProviderTree({
  providers,
  selection,
  onSelect,
  onAddModel,
}: {
  providers: [string, ProviderEntry][];
  selection: ModelsConfigSelection | null;
  onSelect: (selection: ModelsConfigSelection) => void;
  onAddModel: (provider: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (selection?.type === "model")
      setExpanded((current) =>
        current[selection.providerName] ? current : { ...current, [selection.providerName]: true },
      );
  }, [selection]);
  const search = query.trim().toLocaleLowerCase();
  const matches = providers.flatMap(([name, provider]) => {
    const providerMatches = name.toLocaleLowerCase().includes(search);
    const models = (provider.models ?? [])
      .map((model, index) => ({ model, index }))
      .filter(
        ({ model }) =>
          !search || providerMatches || (model.id + " " + (model.name ?? "")).toLocaleLowerCase().includes(search),
      );
    return !search || providerMatches || models.length ? [{ name, provider, models }] : [];
  });
  if (!providers.length) return null;
  return (
    <nav className="custom-model-tree" aria-label={t("modelCustomProviders", "Custom providers")}>
      <div className="custom-model-tree-search">
        <span>{t("modelCustomProviders", "Custom providers")}</span>
        <Input
          type="search"
          size="sm"
          style={searchInputStyle}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t("modelSearchCustom", "Search custom providers and models")}
          placeholder={t("modelSearchCustomPlaceholder", "Search provider or model…")}
        />
      </div>
      {matches.map(({ name, provider, models }) => {
        const open = Boolean(search) || Boolean(expanded[name]);
        const selected = selection?.type === "provider" && selection.name === name;
        return (
          <div key={name} className="custom-model-tree-group">
            <div className="custom-model-tree-provider" data-selected={selected}>
              <Button
                className="custom-model-tree-toggle"
                style={toggleStyle}
                aria-expanded={open}
                aria-label={(open
                  ? t("modelCollapseProvider", "Collapse models for {provider}")
                  : t("modelExpandProvider", "Expand models for {provider}")
                ).replace("{provider}", name)}
                disabled={Boolean(search)}
                onClick={() => setExpanded((current) => ({ ...current, [name]: !open }))}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                  style={{ transform: open ? "rotate(90deg)" : undefined }}
                >
                  <path d="m9 5 7 7-7 7" />
                </svg>
              </Button>
              <Button
                className="custom-model-tree-name"
                style={providerNameStyle}
                title={name}
                aria-current={selected ? "page" : undefined}
                onClick={() => onSelect({ type: "provider", name })}
              >
                <span>{name}</span>
                <small>{provider.models?.length ?? 0}</small>
              </Button>
            </div>
            {open && (
              <div className="custom-model-tree-models">
                {models.map(({ model, index }) => {
                  const active =
                    selection?.type === "model" && selection.providerName === name && selection.index === index;
                  const slash = model.id.lastIndexOf("/");
                  const label = model.name || model.id.slice(slash + 1) || t("modelNewModel", "new model");
                  const prefix = model.name ? model.id : slash >= 0 ? model.id.slice(0, slash) : "";
                  return (
                    <Button
                      key={index}
                      className="custom-model-tree-model"
                      style={modelRowStyle}
                      data-selected={active}
                      aria-current={active ? "page" : undefined}
                      title={name + "/" + model.id}
                      aria-label={t("modelEditNamed", "Edit model {model}").replace("{model}", model.id || label)}
                      onClick={() => onSelect({ type: "model", providerName: name, index })}
                    >
                      <span>{label}</span>
                      {prefix && <small>{prefix}</small>}
                    </Button>
                  );
                })}
                <Button className="custom-model-tree-add" style={addModelStyle} onClick={() => onAddModel(name)}>
                  {t("modelAddModelAction", "Add model")}
                </Button>
              </div>
            )}
          </div>
        );
      })}
      {!matches.length && <p className="custom-model-hint">{t("modelNoMatchingModels", "No matching models.")}</p>}
    </nav>
  );
}
