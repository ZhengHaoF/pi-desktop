import { useState, useEffect, useCallback } from "react";
import { StatusDot } from "@/components/ui/StatusDot";
import { Field, SecretTextInput, SectionTitle, TextInput } from "../form-controls";
import { useI18n } from "@/i18n";
import { Check } from "lucide-react";
import { call } from "@/lib/api-client";
import type { ApiKeyProviderStatus as ApiKeyProvider } from "@contract/types";
import { AuthReplacementNotice } from "./AuthReplacementNotice";
import type { CredentialMutationOptions } from "@contract/auth";
import { OAuthDetail } from "./OAuthDetail";
import { AuxiliaryModels } from "./AuxiliaryModels";
import { Button } from "@/components/ui/Button";

// These providers collect account fields or an authentication-method choice in addition to a key.
const GUIDED_CREDENTIAL_PROVIDERS = new Set([
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
  "google-vertex",
  "amazon-bedrock",
]);

export function ApiKeyDetail({
  provider,
  baseUrl,
  onBaseUrlChange,
  onRefresh,
  onReloadCredentials,
}: {
  provider: ApiKeyProvider;
  baseUrl: string;
  onBaseUrlChange: (baseUrl: string) => void;
  onRefresh: () => void;
  onReloadCredentials?: () => void;
}) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [replacement, setReplacement] = useState<{ version?: string } | null>(null);

  // Reset state when provider changes
  useEffect(() => {
    setApiKey("");
    setError(null);
    setWarning(null);
    setSavedOk(false);
    setReplacement(null);
  }, [provider.id]);

  const saveKey = useCallback(
    async (mutation: CredentialMutationOptions = {}) => {
      if (!apiKey.trim()) return;
      setSaving(true);
      setError(null);
      setWarning(null);
      setSavedOk(false);
      try {
        const result = await call("auth.setApiKey", { provider: provider.id, key: apiKey.trim(), ...mutation });
        setApiKey("");
        setSavedOk(true);
        setWarning(result.warning?.message ?? null);
        setTimeout(() => setSavedOk(false), 2000);
        onRefresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        onReloadCredentials?.();
      } finally {
        setSaving(false);
      }
    },
    [apiKey, provider.id, onRefresh, onReloadCredentials],
  );

  const handleSave = useCallback(() => {
    if (provider.storedAuthType === "oauth") {
      setReplacement({ version: provider.credentialVersion });
      return;
    }
    void saveKey(provider.credentialVersion ? { expectedVersion: provider.credentialVersion } : {});
  }, [provider.storedAuthType, provider.credentialVersion, saveKey]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    setError(null);
    setWarning(null);
    try {
      const result = await call("auth.deleteApiKey", {
        provider: provider.id,
        ...(provider.credentialVersion ? { expectedVersion: provider.credentialVersion } : {}),
      });
      setWarning(result.warning?.message ?? null);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      onReloadCredentials?.();
    } finally {
      setRemoving(false);
    }
  }, [provider.id, provider.credentialVersion, onRefresh, onReloadCredentials]);

  if (GUIDED_CREDENTIAL_PROVIDERS.has(provider.id))
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <OAuthDetail
          authType="api_key"
          provider={{
            id: provider.id,
            name: provider.displayName,
            loggedIn: provider.storedAuthType === "api_key",
            usesCallbackServer: false,
            storedAuthType: provider.storedAuthType,
            credentialVersion: provider.credentialVersion,
          }}
          onRefresh={onRefresh}
          onReloadCredentials={onReloadCredentials}
        />
        <AuxiliaryModels providerId={provider.id} models={provider.auxiliaryModels ?? []} />
        <Field label={t("modelBaseUrl", "Base URL")}>
          <TextInput
            value={baseUrl}
            onChange={onBaseUrlChange}
            placeholder={t("modelBaseUrlPlaceholder", "Leave empty to use the provider default")}
          />
        </Field>
      </div>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("modelApiKey", "API Key")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <StatusDot color={provider.configured ? "var(--success)" : "border"} />
          <span style={{ fontSize: 11, color: provider.configured ? "var(--success)" : "var(--text-dim)" }}>
            {provider.storedAuthType === "oauth"
              ? t("modelOAuthActive", "Account login active")
              : provider.configured
                ? t("configured", "configured")
                : t("notConfigured", "not configured")}
          </span>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {provider.storedAuthType === "oauth"
          ? t(
              "modelOAuthInsteadOfKey",
              "This provider uses account login. Saving an API key switches its authentication method.",
            )
          : provider.configured
            ? t(
                "modelApiKeyStored",
                "API key is stored. Enter a new key below to replace it, or disconnect to remove it.",
              )
            : t("modelEnterApiKey", "Enter your {provider} API key to enable {count} models.")
                .replace("{provider}", provider.displayName)
                .replace("{count}", String(provider.modelCount))}
      </p>
      {replacement && (
        <AuthReplacementNotice
          onCancel={() => setReplacement(null)}
          onConfirm={() => {
            const mutation = {
              replaceExisting: true,
              ...(replacement.version ? { expectedVersion: replacement.version } : {}),
            };
            setReplacement(null);
            void saveKey(mutation);
          }}
        />
      )}

      <Field label={t("modelBaseUrl", "Base URL")}>
        <TextInput
          value={baseUrl}
          onChange={onBaseUrlChange}
          placeholder={t("modelBaseUrlPlaceholder", "Leave empty to use the provider default")}
          mono
        />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          {t(
            "modelBaseUrlHint",
            "Overrides the endpoint for this provider. Use the Save button below to apply changes.",
          )}
        </span>
      </Field>

      <Field label={t("modelApiKey", "API Key")}>
        <div style={{ display: "flex", gap: 6 }}>
          <SecretTextInput
            value={apiKey}
            onChange={setApiKey}
            onKeyDown={(e) => {
              if (e.key === "Enter" && apiKey.trim()) void handleSave();
            }}
            placeholder={provider.configured ? t("modelReplaceApiKey", "Enter new key to replace…") : "sk-…"}
            style={{ flex: 1 }}
            autoComplete="off"
            spellCheck={false}
            mono
          />
          <Button
            onClick={handleSave}
            disabled={saving || !apiKey.trim() || savedOk}
            variant="primary"
            style={{
              padding: "6px 12px",
              borderRadius: 5,
              fontSize: 12,
              fontWeight: 600,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 5,
              ...(savedOk ? { background: "#16a34a", color: "#fff" } : {}),
            }}
          >
            {savedOk && <Check size={12} strokeWidth={3} />}
            {savedOk ? t("saved", "Saved") : saving ? t("saving", "Saving…") : t("save", "Save")}
          </Button>
        </div>
      </Field>

      {error && <p style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>{error}</p>}
      {warning && <p style={{ margin: 0, fontSize: 12, color: "var(--warning)" }}>{warning}</p>}

      <AuxiliaryModels providerId={provider.id} models={provider.auxiliaryModels ?? []} />

      {provider.configured && (provider.storedAuthType === undefined || provider.storedAuthType === "api_key") && (
        <Button
          onClick={handleRemove}
          disabled={removing}
          variant="danger"
          style={{ alignSelf: "flex-start", padding: "5px 12px", borderRadius: 5, fontSize: 12 }}
        >
          {removing ? t("modelRemoving", "Removing…") : t("modelDisconnect", "Disconnect")}
        </Button>
      )}
    </div>
  );
}
