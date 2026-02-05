import { useState, useRef, useEffect } from "react";
import { X, Key, CaretDown, Upload, Check, Warning, Trash } from "@phosphor-icons/react";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "./AlertDialog";
import type { ProviderCredentials, ProviderType, EmbeddingsCredentials } from "../electron/preload";

interface ViewOrgSettingsProps {
  onClose: () => void;
  currentProviderType?: ProviderType;
}

const PROVIDERS: { type: ProviderType; name: string; description: string }[] = [
  { type: "anthropic", name: "Anthropic API", description: "Direct API access" },
];

const BEDROCK_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "eu-west-1",
  "eu-west-3",
  "eu-central-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
];

const VERTEX_LOCATIONS = [
  "us-central1",
  "us-east5",
  "europe-west1",
  "europe-west4",
  "asia-southeast1",
];

const HELP_URLS: Record<ProviderType, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  bedrock: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html",
  vertex: "https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude",
};

/**
 * ViewOrgSettings Component
 *
 * Organization-level settings overlay for managing AI provider credentials.
 * Allows viewing current provider and changing to a different one.
 */
export function ViewOrgSettings({ onClose, currentProviderType }: ViewOrgSettingsProps) {
  const [providerType, setProviderType] = useState<ProviderType>(currentProviderType || "anthropic");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [showProviderDropdown, setShowProviderDropdown] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [embeddingsConfigured, setEmbeddingsConfigured] = useState(false);
  const [embeddingsModel, setEmbeddingsModel] = useState("");
  const [savedEmbeddingsModel, setSavedEmbeddingsModel] = useState("");
  const [embeddingsApiKey, setEmbeddingsApiKey] = useState("");
  const [embeddingsError, setEmbeddingsError] = useState<string | null>(null);
  const [embeddingsSuccess, setEmbeddingsSuccess] = useState(false);
  const [isEmbeddingsEditing, setIsEmbeddingsEditing] = useState(false);
  const [isEmbeddingsLoading, setIsEmbeddingsLoading] = useState(false);
  const [showEmbeddingsDeleteConfirm, setShowEmbeddingsDeleteConfirm] = useState(false);
  const [isEmbeddingsDeleting, setIsEmbeddingsDeleting] = useState(false);

  // Anthropic fields
  const [apiKey, setApiKey] = useState("");

  // Bedrock fields
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [bedrockRegion, setBedrockRegion] = useState(BEDROCK_REGIONS[0]);

  // Vertex fields
  const [projectId, setProjectId] = useState("");
  const [vertexLocation, setVertexLocation] = useState(VERTEX_LOCATIONS[0]);
  const [clientEmail, setClientEmail] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [showManualVertex, setShowManualVertex] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedProvider = PROVIDERS.find((p) => p.type === providerType)!;
  const currentProvider = PROVIDERS.find((p) => p.type === currentProviderType);

  // Reset form when provider type changes
  useEffect(() => {
    setApiKey("");
    setAccessKeyId("");
    setSecretAccessKey("");
    setProjectId("");
    setClientEmail("");
    setPrivateKey("");
    setError(null);
    setSuccess(false);
  }, [providerType]);

  useEffect(() => {
    const loadEmbeddingsState = async () => {
      try {
        const state = await window.electronAPI.embeddings.getState();
        setEmbeddingsConfigured(state.hasCredentials);
        setEmbeddingsModel(state.model || "");
        setSavedEmbeddingsModel(state.model || "");
      } catch {
        setEmbeddingsConfigured(false);
        setEmbeddingsModel("");
        setSavedEmbeddingsModel("");
      }
    };

    loadEmbeddingsState();
  }, []);

  /**
   * Build credentials based on current provider and form state.
   */
  const buildCredentials = (): ProviderCredentials | null => {
    switch (providerType) {
      case "anthropic":
        if (!apiKey.trim()) return null;
        return { type: "anthropic", apiKey: apiKey.trim() };

      case "bedrock":
        if (!accessKeyId.trim() || !secretAccessKey.trim() || !bedrockRegion) return null;
        return {
          type: "bedrock",
          accessKeyId: accessKeyId.trim(),
          secretAccessKey: secretAccessKey.trim(),
          region: bedrockRegion,
        };

      case "vertex":
        if (!projectId.trim() || !vertexLocation || !clientEmail.trim() || !privateKey.trim())
          return null;
        return {
          type: "vertex",
          projectId: projectId.trim(),
          location: vertexLocation,
          clientEmail: clientEmail.trim(),
          privateKey: privateKey.trim(),
        };

      default:
        return null;
    }
  };

  /**
   * Check if form is valid for submission.
   */
  const isFormValid = (): boolean => {
    return buildCredentials() !== null;
  };

  /**
   * Handle service account JSON file upload for Vertex.
   */
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);
        if (json.client_email && json.private_key) {
          setClientEmail(json.client_email);
          setPrivateKey(json.private_key);
          if (json.project_id && !projectId) {
            setProjectId(json.project_id);
          }
          setError(null);
        } else {
          setError("Invalid service account JSON file");
        }
      } catch {
        setError("Failed to parse JSON file");
      }
    };
    reader.readAsText(file);

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  /**
   * Validates and saves the credentials.
   */
  const handleSubmit = async () => {
    const credentials = buildCredentials();
    if (!credentials) {
      setError("Please fill in all required fields");
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const result = await window.electronAPI.auth.saveCredentials(credentials);

      if (result.success) {
        setSuccess(true);
        setIsEditing(false);
        // Reload the app to reinitialize with new credentials
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      } else {
        setError(result.error || "Failed to save credentials");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Handle key press for Enter to submit.
   */
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !isLoading && isFormValid()) {
      handleSubmit();
    }
  };

  const handleEmbeddingsKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !isEmbeddingsLoading && isEmbeddingsFormValid()) {
      handleEmbeddingsSave();
    }
  };

  /**
   * Delete credentials and return to welcome screen.
   */
  const handleDeleteCredentials = async () => {
    setIsDeleting(true);
    try {
      const result = await window.electronAPI.auth.clearCredentials();
      if (result.success) {
        // Reload to return to welcome/login screen
        window.location.reload();
      } else {
        setError("Failed to delete credentials");
        setShowDeleteConfirm(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete credentials");
      setShowDeleteConfirm(false);
    } finally {
      setIsDeleting(false);
    }
  };

  const buildEmbeddingsCredentials = (): EmbeddingsCredentials | null => {
    if (!embeddingsApiKey.trim()) return null;
    return {
      type: "openai",
      apiKey: embeddingsApiKey.trim(),
      model: embeddingsModel.trim() || undefined,
    };
  };

  const isEmbeddingsFormValid = (): boolean => {
    return buildEmbeddingsCredentials() !== null;
  };

  const handleEmbeddingsSave = async () => {
    const credentials = buildEmbeddingsCredentials();
    if (!credentials) {
      setEmbeddingsError("Please enter an OpenAI API key");
      return;
    }

    setIsEmbeddingsLoading(true);
    setEmbeddingsError(null);
    setEmbeddingsSuccess(false);

    try {
      const result = await window.electronAPI.embeddings.saveCredentials(credentials);
      if (result.success) {
        setEmbeddingsConfigured(true);
        setSavedEmbeddingsModel(credentials.model || "");
        setEmbeddingsModel(credentials.model || "");
        setEmbeddingsSuccess(true);
        setEmbeddingsApiKey("");
      } else {
        setEmbeddingsError(result.error || "Failed to save embeddings credentials");
      }
    } catch (err) {
      setEmbeddingsError(err instanceof Error ? err.message : "Failed to save embeddings credentials");
    } finally {
      setIsEmbeddingsLoading(false);
    }
  };

  const handleDeleteEmbeddingsCredentials = async () => {
    setIsEmbeddingsDeleting(true);
    try {
      const result = await window.electronAPI.embeddings.clearCredentials();
      if (result.success) {
        setEmbeddingsConfigured(false);
        setEmbeddingsModel("");
        setSavedEmbeddingsModel("");
        setEmbeddingsApiKey("");
        setEmbeddingsSuccess(false);
        setIsEmbeddingsEditing(false);
        setShowEmbeddingsDeleteConfirm(false);
      } else {
        setEmbeddingsError(result.error || "Failed to delete embeddings credentials");
      }
    } catch (err) {
      setEmbeddingsError(err instanceof Error ? err.message : "Failed to delete embeddings credentials");
    } finally {
      setIsEmbeddingsDeleting(false);
    }
  };

  /**
   * Check if the user already has credentials configured for the selected provider.
   * Used to show appropriate placeholder text and hints.
   */
  const hasExistingCredentials = currentProviderType === providerType;

  /**
   * Render provider-specific fields.
   * Uses consistent styling with the app's design system.
   */
  const renderProviderFields = () => {
    const inputBaseClass =
      "w-full h-[34px] px-3 rounded-md bg-background-primary border border-border-primary text-text-primary text-base placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-ring-primary focus:border-ring-primary transition-all";
    const inputMonoClass = `${inputBaseClass} font-mono`;

    switch (providerType) {
      case "anthropic":
        return (
          <div className="space-y-2">
            <div className="relative">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary">
                <Key size={14} />
              </div>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder="sk-ant-..."
                disabled={isLoading}
                className={`${inputMonoClass} pl-9`}
              />
            </div>
            {hasExistingCredentials && !apiKey && (
              <p className="text-xs text-text-tertiary">
                A key is already configured. Enter a new key to replace it.
              </p>
            )}
          </div>
        );

      case "bedrock":
        return (
          <div className="space-y-3">
            <input
              type="text"
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="Access Key ID (AKIA...)"
              disabled={isLoading}
              className={inputMonoClass}
            />
            <input
              type="password"
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="Secret Access Key"
              disabled={isLoading}
              className={inputMonoClass}
            />
            <select
              value={bedrockRegion}
              onChange={(e) => setBedrockRegion(e.target.value)}
              disabled={isLoading}
              className={inputBaseClass}
            >
              {BEDROCK_REGIONS.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </select>
            {hasExistingCredentials && !accessKeyId && !secretAccessKey && (
              <p className="text-xs text-text-tertiary">
                Credentials are already configured. Enter new values to replace them.
              </p>
            )}
          </div>
        );

      case "vertex":
        return (
          <div className="space-y-3">
            <input
              type="text"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="Project ID"
              disabled={isLoading}
              className={inputBaseClass}
            />
            <select
              value={vertexLocation}
              onChange={(e) => setVertexLocation(e.target.value)}
              disabled={isLoading}
              className={inputBaseClass}
            >
              {VERTEX_LOCATIONS.map((loc) => (
                <option key={loc} value={loc}>
                  {loc}
                </option>
              ))}
            </select>

            {!showManualVertex ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLoading}
                  className="w-full"
                >
                  <Upload size={14} />
                  <span>Upload Service Account JSON</span>
                </Button>
                {clientEmail && (
                  <div className="text-xs text-text-secondary truncate">
                    Loaded: {clientEmail}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setShowManualVertex(true)}
                  className="w-full text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  Or enter credentials manually
                </button>
                {hasExistingCredentials && !projectId && !clientEmail && (
                  <p className="text-xs text-text-tertiary">
                    Credentials are already configured. Upload a new file to replace them.
                  </p>
                )}
              </>
            ) : (
              <>
                <input
                  type="text"
                  value={clientEmail}
                  onChange={(e) => setClientEmail(e.target.value)}
                  onKeyDown={handleKeyPress}
                  placeholder="Service Account Email"
                  disabled={isLoading}
                  className={inputMonoClass}
                />
                <textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="Private Key (-----BEGIN PRIVATE KEY-----...)"
                  disabled={isLoading}
                  rows={3}
                  className="w-full px-3 py-2 rounded-md bg-background-primary border border-border-primary text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-ring-primary focus:border-ring-primary transition-all font-mono text-base resize-none"
                />
                <button
                  type="button"
                  onClick={() => setShowManualVertex(false)}
                  className="w-full text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  Or upload JSON file
                </button>
                {hasExistingCredentials && !projectId && !clientEmail && !privateKey && (
                  <p className="text-xs text-text-tertiary">
                    Credentials are already configured. Enter new values to replace them.
                  </p>
                )}
              </>
            )}
          </div>
        );
    }
  };

  return (
    <div className="absolute inset-0 z-50 bg-background-primary flex flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border-secondary">
        <div className="flex items-center justify-between px-6 py-4">
          <h1 className="text-base font-medium text-text-primary">Org Settings</h1>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-background-tertiary text-text-secondary hover:text-text-primary transition-colors focus:outline-none"
            title="Close"
          >
            <X size={16} weight="bold" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-6 flex justify-center">
          <div className="w-full max-w-[800px]">
            {/* Section Header */}
            <div className="mb-12">
              <h2 className="text-base font-medium text-text-primary">AI Provider</h2>
              <p className="text-sm text-text-secondary mt-1">
                Configure the AI provider used for conversations
              </p>
            </div>

            {/* Provider Card */}
            {!isEditing ? (
              <div className="rounded-md border border-border-primary">
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <Key size={20} className="text-text-secondary shrink-0 pr-1" />
                    <div>
                      <div className="text-base font-medium text-text-primary pb-1">
                        {currentProvider?.name || "Not configured"}
                      </div>
                      <div className="text-xs text-text-secondary">
                        {currentProvider?.description || "No provider selected"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowDeleteConfirm(true)}
                      className="text-text-secondary hover:text-text-danger hover:border-border-danger"
                    >
                      <Trash size={14} />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                      Change
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-border-primary p-4">
                {/* Provider Selection */}
                <div className="mb-4">
                  <label className="block text-sm text-text-secondary mb-2">Provider</label>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setShowProviderDropdown(!showProviderDropdown)}
                      className="w-full h-[34px] px-3 rounded-md bg-background-primary border border-border-primary text-text-primary focus:outline-none focus:ring-1 focus:ring-ring-primary focus:border-ring-primary transition-all flex items-center justify-between"
                    >
                      <span className="text-base">{selectedProvider.name}</span>
                      <CaretDown
                        size={14}
                        className={`text-text-secondary transition-transform ${showProviderDropdown ? "rotate-180" : ""}`}
                      />
                    </button>

                    {showProviderDropdown && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-background-primary border border-border-primary rounded-md shadow-lg overflow-hidden z-10">
                        {PROVIDERS.map((provider) => (
                          <button
                            key={provider.type}
                            type="button"
                            onClick={() => {
                              setProviderType(provider.type);
                              setShowProviderDropdown(false);
                              setError(null);
                            }}
                            className={`w-full px-3 py-2 text-left hover:bg-background-secondary transition-colors ${
                              provider.type === providerType ? "bg-background-secondary" : ""
                            }`}
                          >
                            <div className="text-base text-text-primary">{provider.name}</div>
                            <div className="text-sm text-text-tertiary">{provider.description}</div>
                          </button>
                        ))}
                        <div className="w-full px-3 py-2 text-left cursor-not-allowed opacity-50">
                          <div className="text-base text-text-tertiary">More providers coming soon</div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Credentials fields */}
                <div className="mb-4">
                  <label className="block text-sm text-text-secondary mb-2">Credentials</label>
                  {renderProviderFields()}
                </div>

                {/* Help link */}
                <p className="text-sm text-text-tertiary mb-4">
                  Get credentials from{" "}
                  <button
                    onClick={() => window.electronAPI.shell.openExternal(HELP_URLS[providerType])}
                    className="text-text-secondary hover:text-text-primary hover:underline cursor-pointer"
                  >
                    {providerType === "anthropic" && "console.anthropic.com"}
                    {providerType === "bedrock" && "AWS Console"}
                    {providerType === "vertex" && "Google Cloud Console"}
                  </button>
                </p>

                {/* Error/Success messages */}
                {error && (
                  <div className="alert alert-danger mb-4">
                    <div className="flex items-center gap-2">
                      <Warning size={14} className="shrink-0" />
                      <span>{error}</span>
                    </div>
                  </div>
                )}

                {success && (
                  <div className="flex items-center gap-2 text-base text-text-success mb-4">
                    <Check size={14} className="shrink-0" />
                    <span>Credentials saved. Reloading...</span>
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setIsEditing(false);
                      setProviderType(currentProviderType || "anthropic");
                      setError(null);
                    }}
                    disabled={isLoading}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="default"
                    onClick={handleSubmit}
                    disabled={isLoading || !isFormValid()}
                  >
                    {isLoading ? (
                      <>
                        <Spinner size={14} />
                        <span>Validating...</span>
                      </>
                    ) : (
                      "Save"
                    )}
                  </Button>
                </div>
              </div>
            )}

            <div className="mt-12 mb-4">
              <h2 className="text-sm font-medium text-text-primary">Embeddings</h2>
              <p className="text-xs text-text-secondary mt-1">
                Configure OpenAI embeddings for vector search
              </p>
            </div>

            {!isEmbeddingsEditing ? (
              <div className="rounded-md border border-border-primary">
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <Key size={16} className="text-text-secondary shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-text-primary">OpenAI Embeddings</div>
                      <div className="text-xs text-text-secondary">
                        {embeddingsConfigured ? "Configured" : "Not configured"}
                      </div>
                      {embeddingsConfigured && embeddingsModel && (
                        <div className="text-xs text-text-tertiary">Model: {embeddingsModel}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {embeddingsConfigured && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowEmbeddingsDeleteConfirm(true)}
                        className="text-text-secondary hover:text-text-danger hover:border-border-danger"
                      >
                        <Trash size={14} />
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEmbeddingsError(null);
                        setEmbeddingsSuccess(false);
                        setIsEmbeddingsEditing(true);
                      }}
                    >
                      {embeddingsConfigured ? "Change" : "Add"}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-border-primary p-4">
                <div className="mb-4">
                  <label className="block text-xs text-text-secondary mb-2">API Key</label>
                  <div className="relative">
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary">
                      <Key size={14} />
                    </div>
                    <input
                      type="password"
                      value={embeddingsApiKey}
                      onChange={(e) => setEmbeddingsApiKey(e.target.value)}
                      onKeyDown={handleEmbeddingsKeyPress}
                      placeholder="sk-..."
                      disabled={isEmbeddingsLoading}
                      className="w-full h-[34px] px-3 pl-9 rounded-md bg-background-primary border border-border-primary text-text-primary text-xs placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-ring-primary focus:border-ring-primary transition-all font-mono"
                    />
                  </div>
                  {embeddingsConfigured && !embeddingsApiKey && (
                    <p className="text-xs text-text-tertiary mt-2">
                      A key is already configured. Enter a new key to replace it.
                    </p>
                  )}
                </div>

                <div className="mb-4">
                  <label className="block text-xs text-text-secondary mb-2">Model (optional)</label>
                  <input
                    type="text"
                    value={embeddingsModel}
                    onChange={(e) => setEmbeddingsModel(e.target.value)}
                    onKeyDown={handleEmbeddingsKeyPress}
                    placeholder="text-embedding-3-small"
                    disabled={isEmbeddingsLoading}
                    className="w-full h-[34px] px-3 rounded-md bg-background-primary border border-border-primary text-text-primary text-xs placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-ring-primary focus:border-ring-primary transition-all font-mono"
                  />
                </div>

                <p className="text-xs text-text-tertiary mb-4">
                  Get credentials from{" "}
                  <button
                    onClick={() => window.electronAPI.shell.openExternal("https://platform.openai.com/api-keys")}
                    className="text-text-secondary hover:text-text-primary hover:underline cursor-pointer"
                  >
                    platform.openai.com
                  </button>
                </p>

                {embeddingsError && (
                  <div className="alert alert-danger mb-4">
                    <div className="flex items-center gap-2">
                      <Warning size={14} className="shrink-0" />
                      <span>{embeddingsError}</span>
                    </div>
                  </div>
                )}

                {embeddingsSuccess && (
                  <div className="flex items-center gap-2 text-sm text-text-success mb-4">
                    <Check size={14} className="shrink-0" />
                    <span>Embeddings credentials saved.</span>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setIsEmbeddingsEditing(false);
                      setEmbeddingsApiKey("");
                      setEmbeddingsModel(savedEmbeddingsModel);
                      setEmbeddingsError(null);
                      setEmbeddingsSuccess(false);
                    }}
                    disabled={isEmbeddingsLoading}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="default"
                    onClick={handleEmbeddingsSave}
                    disabled={isEmbeddingsLoading || !isEmbeddingsFormValid()}
                  >
                    {isEmbeddingsLoading ? (
                      <>
                        <Spinner size={14} />
                        <span>Saving...</span>
                      </>
                    ) : (
                      "Save"
                    )}
                  </Button>
                </div>
              </div>
            )}

            {/* Footer Note */}
            <div className="mt-6 pt-4 border-t border-border-secondary">
              <p className="text-sm text-text-tertiary">
                Credentials are stored locally and encrypted. Changing your provider will reload the app.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete API credentials?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove your saved credentials and log you out. You'll need to enter new credentials to use the app again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteCredentials}
              disabled={isDeleting}
              className="bg-solid-danger hover:bg-solid-danger/90"
            >
              {isDeleting ? (
                <>
                  <Spinner size={14} />
                  <span>Deleting...</span>
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showEmbeddingsDeleteConfirm} onOpenChange={setShowEmbeddingsDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete embeddings credentials?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove your OpenAI embeddings key. Vector search will be unavailable until you add a new key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isEmbeddingsDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteEmbeddingsCredentials}
              disabled={isEmbeddingsDeleting}
              className="bg-solid-danger hover:bg-solid-danger/90"
            >
              {isEmbeddingsDeleting ? (
                <>
                  <Spinner size={14} />
                  <span>Deleting...</span>
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
