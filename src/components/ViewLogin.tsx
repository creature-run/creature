import { useState, useRef } from "react";
import { Eye, EyeSlash, ArrowRight, CaretDown, Upload } from "@phosphor-icons/react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Label } from "./Label";
import { Spinner } from "./Spinner";
import { useTheme } from "../contexts/ThemeContext";
import { CreatureIcon } from "./CreatureIcon";
import { cn } from "../lib/utils";
import type { ProviderCredentials, ProviderType } from "../electron/preload";

interface ViewLoginProps {
  onLoginSuccess: () => void;
}

const PROVIDERS: { type: ProviderType; name: string; description: string }[] = [
  { type: "anthropic", name: "Anthropic API", description: "Direct API access" },
  { type: "bedrock", name: "AWS Bedrock", description: "Via Amazon Web Services" },
  { type: "vertex", name: "Google Vertex AI", description: "Via Google Cloud" },
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
 * ViewLogin Component
 *
 * Displays the credential setup screen with provider selection.
 * Supports Anthropic API, AWS Bedrock, and Google Vertex AI.
 */
export function ViewLogin({ onLoginSuccess }: ViewLoginProps) {
  const [providerType, setProviderType] = useState<ProviderType>("anthropic");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState(false);
  const [showProviderDropdown, setShowProviderDropdown] = useState(false);

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

  const { isDarkMode, toggleTheme } = useTheme();

  const selectedProvider = PROVIDERS.find((p) => p.type === providerType)!;

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

    try {
      const result = await window.electronAPI.auth.saveCredentials(credentials);

      if (result.success) {
        onLoginSuccess();
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

  /**
   * Standard select styling to match Input component.
   */
  const selectClassName = cn(
    "flex h-[34px] w-full rounded-md border border-border-primary bg-background-primary px-3 py-2 text-xs text-text-primary transition-colors",
    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring-primary focus-visible:border-ring-primary",
    "disabled:cursor-not-allowed disabled:opacity-50"
  );

  /**
   * Render provider-specific fields.
   */
  const renderProviderFields = () => {
    switch (providerType) {
      case "anthropic":
        return (
          <div>
            <Label>API Key</Label>
            <div className="relative">
              <Input
                type={showSecrets ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder="sk-ant-..."
                disabled={isLoading}
                className="pr-9 font-mono"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowSecrets(!showSecrets)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary transition-colors"
                tabIndex={-1}
              >
                {showSecrets ? <EyeSlash size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
        );

      case "bedrock":
        return (
          <div className="space-y-4">
            <div>
              <Label>Access Key ID</Label>
              <Input
                type="text"
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder="AKIA..."
                disabled={isLoading}
                className="font-mono"
                autoFocus
              />
            </div>
            <div>
              <Label>Secret Access Key</Label>
              <div className="relative">
                <Input
                  type={showSecrets ? "text" : "password"}
                  value={secretAccessKey}
                  onChange={(e) => setSecretAccessKey(e.target.value)}
                  onKeyDown={handleKeyPress}
                  placeholder="Secret Access Key"
                  disabled={isLoading}
                  className="pr-9 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowSecrets(!showSecrets)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary transition-colors"
                  tabIndex={-1}
                >
                  {showSecrets ? <EyeSlash size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div>
              <Label>Region</Label>
              <select
                value={bedrockRegion}
                onChange={(e) => setBedrockRegion(e.target.value)}
                disabled={isLoading}
                className={selectClassName}
              >
                {BEDROCK_REGIONS.map((region) => (
                  <option key={region} value={region}>
                    {region}
                  </option>
                ))}
              </select>
            </div>
          </div>
        );

      case "vertex":
        return (
          <div className="space-y-4">
            <div>
              <Label>Project ID</Label>
              <Input
                type="text"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder="my-gcp-project"
                disabled={isLoading}
                autoFocus
              />
            </div>
            <div>
              <Label>Location</Label>
              <select
                value={vertexLocation}
                onChange={(e) => setVertexLocation(e.target.value)}
                disabled={isLoading}
                className={selectClassName}
              >
                {VERTEX_LOCATIONS.map((loc) => (
                  <option key={loc} value={loc}>
                    {loc}
                  </option>
                ))}
              </select>
            </div>

            {!showManualVertex ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <div>
                  <Label>Service Account</Label>
                  <Button
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isLoading}
                    className="w-full flex items-center justify-center gap-2"
                  >
                    <Upload size={14} />
                    <span>Upload JSON</span>
                  </Button>
                </div>
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
              </>
            ) : (
              <>
                <div>
                  <Label>Service Account Email</Label>
                  <Input
                    type="text"
                    value={clientEmail}
                    onChange={(e) => setClientEmail(e.target.value)}
                    onKeyDown={handleKeyPress}
                    placeholder="sa@project.iam.gserviceaccount.com"
                    disabled={isLoading}
                    className="font-mono"
                  />
                </div>
                <div>
                  <Label>Private Key</Label>
                  <textarea
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder="-----BEGIN PRIVATE KEY-----..."
                    disabled={isLoading}
                    rows={3}
                    className={cn(
                      "flex w-full rounded-md border border-border-primary bg-background-primary px-3 py-2 text-xs text-text-primary transition-colors",
                      "placeholder:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring-primary focus-visible:border-ring-primary",
                      "disabled:cursor-not-allowed disabled:opacity-50 font-mono resize-none"
                    )}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowManualVertex(false)}
                  className="w-full text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  Or upload JSON file
                </button>
              </>
            )}
          </div>
        );
    }
  };

  return (
    <div className="h-screen flex flex-col items-center justify-center transition-colors duration-300 bg-background-primary">
      {/* Draggable title bar region for window movement */}
      <div className="absolute top-0 left-0 right-0 h-10 [-webkit-app-region:drag]" />

      <div className="flex flex-col items-center text-center w-full max-w-md px-4 -mt-[40px]">
        {/* Creature icon - centered above text */}
        <div className="mb-4">
          <CreatureIcon isDarkMode={isDarkMode} width={56} height={55} enableBlink={true} />
        </div>

        {/* Brand text - Sora font, bold */}
        <h1
          className="text-foreground text-4xl font-bold select-none tracking-tight"
          style={{ fontFamily: "'Sora', sans-serif" }}
        >
          Creature
        </h1>

        {/* Subtitle */}
        <p className="text-text-secondary text-sm mt-2 select-none">
          Connect your AI provider to get started
        </p>

        {error && (
          <div className="alert alert-destructive mt-6 mb-2 px-4 py-3 text-sm">{error}</div>
        )}

        {/* Provider Selection & Credentials Form */}
        <div className="mt-8 w-full max-w-[320px]">
          {/* Provider Dropdown */}
          <div className="relative mb-4">
            <Label>Provider</Label>
            <button
              type="button"
              onClick={() => setShowProviderDropdown(!showProviderDropdown)}
              className={cn(
                "w-full h-[34px] px-3 rounded-md bg-background-primary border border-border-primary text-text-primary transition-colors flex items-center justify-between",
                "focus:outline-none focus:ring-1 focus:ring-ring-primary focus:border-ring-primary"
              )}
            >
              <span className="text-xs">{selectedProvider.name}</span>
              <CaretDown
                size={12}
                className={cn("text-text-secondary transition-transform", showProviderDropdown && "rotate-180")}
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
                    className={cn(
                      "w-full px-3 py-2 text-left hover:bg-background-tertiary transition-colors",
                      provider.type === providerType && "bg-background-tertiary"
                    )}
                  >
                    <div className="text-xs font-medium text-text-primary">{provider.name}</div>
                    <div className="text-[10px] text-text-secondary">{provider.description}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Provider-specific fields */}
          {renderProviderFields()}

          <Button
            variant="default"
            onClick={handleSubmit}
            disabled={isLoading || !isFormValid()}
            className="mt-8 w-full flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <Spinner size={14} />
                <span>Validating...</span>
              </>
            ) : (
              <>
                <span>Continue</span>
                <ArrowRight size={14} />
              </>
            )}
          </Button>
        </div>

        {/* Help link */}
        <p className="mt-6 text-xs text-text-tertiary">
          Get your credentials from{" "}
          <button
            onClick={() => window.electronAPI.shell.openExternal(HELP_URLS[providerType])}
            className="text-ring-primary hover:underline cursor-pointer"
          >
            {providerType === "anthropic" && "console.anthropic.com"}
            {providerType === "bedrock" && "AWS Console"}
            {providerType === "vertex" && "Google Cloud Console"}
          </button>
        </p>

        <div className="mt-[60px] flex items-center gap-3 font-body text-sm text-text-secondary tracking-[0.05em] select-none">
          <span className="text-xs">v0.1</span>
          <button
            onClick={toggleTheme}
            className="p-1 rounded hover:text-text-primary transition-colors cursor-pointer"
            aria-label="Toggle theme"
          >
            {isDarkMode ? (
              // Sun icon - shown in dark mode, click to switch to light
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              // Moon icon - shown in light mode, click to switch to dark
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
