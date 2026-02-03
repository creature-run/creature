/**
 * Credentials Storage
 *
 * Secure local storage for provider credentials.
 * Uses AES-256-CBC encryption with an app-derived key.
 * Supports Anthropic API, AWS Bedrock, and Google Vertex AI.
 */

import { app } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProviderCredentials } from "../../shared/credentials";
import { getRuntimeAppName } from "../utils/appIdentity";

/**
 * Derives an encryption key from the app identifier.
 * This avoids macOS Keychain prompts while still providing basic encryption.
 */
const getEncryptionKey = (): Buffer => {
  const appName = getRuntimeAppName();
  return crypto.createHash("sha256").update(appName).digest();
};

/**
 * Encrypts a string using AES-256-CBC.
 * Prepends the IV to the encrypted data.
 */
const encrypt = (text: string): Buffer => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
};

/**
 * Decrypts data encrypted with the encrypt function.
 * Expects IV prepended to the encrypted data.
 */
const decrypt = (data: Buffer): string => {
  const iv = data.subarray(0, 16);
  const encrypted = data.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", getEncryptionKey(), iv);
  return decipher.update(encrypted, undefined, "utf8") + decipher.final("utf8");
};

/**
 * Get the path to the credentials storage file.
 */
const getStoragePath = (): string => {
  return path.join(app.getPath("userData"), "credentials.enc");
};

/**
 * Get the path to the legacy API key storage file.
 */
const getLegacyStoragePath = (): string => {
  return path.join(app.getPath("userData"), "apikey.enc");
};

/**
 * Migrate from legacy apikey.enc to new credentials.enc format.
 * Returns the migrated credentials or null if no migration needed.
 */
const migrateLegacyCredentials = async (): Promise<ProviderCredentials | null> => {
  const legacyPath = getLegacyStoragePath();

  if (!fs.existsSync(legacyPath)) {
    return null;
  }

  try {
    const encryptedData = fs.readFileSync(legacyPath);
    const decryptedData = decrypt(encryptedData);
    const stored = JSON.parse(decryptedData);

    if (stored.apiKey) {
      // Convert legacy format to new Anthropic credentials
      const credentials: ProviderCredentials = {
        type: "anthropic",
        apiKey: stored.apiKey,
      };

      // Save in new format
      await saveCredentials(credentials);

      // Delete legacy file
      fs.unlinkSync(legacyPath);

      console.log("[CredentialsStore] Migrated legacy API key to new credentials format");
      return credentials;
    }
  } catch (error) {
    console.error("[CredentialsStore] Failed to migrate legacy credentials:", error);
    // Delete corrupted legacy file
    try {
      fs.unlinkSync(legacyPath);
    } catch {
      // Ignore deletion errors
    }
  }

  return null;
};

/**
 * Save credentials to encrypted storage.
 */
export const saveCredentials = async (credentials: ProviderCredentials): Promise<void> => {
  try {
    const data = JSON.stringify(credentials);
    const encryptedData = encrypt(data);
    fs.writeFileSync(getStoragePath(), encryptedData);
  } catch (error) {
    console.error("[CredentialsStore] Failed to save credentials:", error);
    throw new Error("Failed to save credentials");
  }
};

/**
 * Load credentials from encrypted storage.
 * Handles migration from legacy apikey.enc format.
 * Returns null if no credentials are stored or storage is corrupted.
 */
export const loadCredentials = async (): Promise<ProviderCredentials | null> => {
  try {
    const storagePath = getStoragePath();

    // Check for new credentials file first
    if (fs.existsSync(storagePath)) {
      const encryptedData = fs.readFileSync(storagePath);
      const decryptedData = decrypt(encryptedData);
      const credentials = JSON.parse(decryptedData) as ProviderCredentials;

      // Validate structure
      if (!credentials.type) {
        throw new Error("Invalid credentials structure");
      }

      return credentials;
    }

    // Try to migrate from legacy format
    const migratedCredentials = await migrateLegacyCredentials();
    if (migratedCredentials) {
      return migratedCredentials;
    }

    return null;
  } catch (error) {
    // Corrupted or incompatible storage - clear and return null
    console.log("[CredentialsStore] Clearing incompatible stored credentials");
    await clearCredentials();
    return null;
  }
};

/**
 * Clear the stored credentials.
 */
export const clearCredentials = async (): Promise<void> => {
  try {
    const storagePath = getStoragePath();
    if (fs.existsSync(storagePath)) {
      fs.unlinkSync(storagePath);
    }
    // Also clean up legacy file if it exists
    const legacyPath = getLegacyStoragePath();
    if (fs.existsSync(legacyPath)) {
      fs.unlinkSync(legacyPath);
    }
  } catch (error) {
    console.error("[CredentialsStore] Failed to clear credentials:", error);
  }
};

/**
 * Check if credentials are stored.
 */
export const hasCredentials = async (): Promise<boolean> => {
  const credentials = await loadCredentials();
  return credentials !== null;
};

/**
 * Validate Anthropic API key by making a test request.
 */
export const validateAnthropicCredentials = async (
  apiKey: string
): Promise<{ valid: boolean; error?: string }> => {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    if (response.ok) {
      return { valid: true };
    }

    const errorData = await response.json().catch(() => ({}));

    if (response.status === 401) {
      return { valid: false, error: "Invalid API key" };
    }

    if (response.status === 403) {
      return { valid: false, error: "API key does not have permission" };
    }

    return { valid: false, error: errorData.error?.message || `API error: ${response.status}` };
  } catch (error) {
    console.error("[CredentialsStore] Anthropic validation error:", error);
    return { valid: false, error: "Failed to connect to Anthropic API" };
  }
};

/**
 * Validate Bedrock credentials by attempting to create a provider.
 * We don't make a full API call since that would incur costs.
 * Instead, we do basic validation of the credential format.
 */
export const validateBedrockCredentials = async (credentials: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}): Promise<{ valid: boolean; error?: string }> => {
  // Basic format validation
  if (!credentials.accessKeyId || credentials.accessKeyId.length < 16) {
    return { valid: false, error: "Invalid Access Key ID format" };
  }

  if (!credentials.secretAccessKey || credentials.secretAccessKey.length < 20) {
    return { valid: false, error: "Invalid Secret Access Key format" };
  }

  if (!credentials.region) {
    return { valid: false, error: "Region is required" };
  }

  // Access keys typically start with AKIA for long-term credentials
  // or ASIA for temporary credentials
  if (!credentials.accessKeyId.startsWith("AKIA") && !credentials.accessKeyId.startsWith("ASIA")) {
    return { valid: false, error: "Access Key ID should start with 'AKIA' or 'ASIA'" };
  }

  return { valid: true };
};

/**
 * Validate Vertex AI credentials by checking the format.
 * We validate the service account email format and private key structure.
 */
export const validateVertexCredentials = async (credentials: {
  projectId: string;
  location: string;
  clientEmail: string;
  privateKey: string;
}): Promise<{ valid: boolean; error?: string }> => {
  // Validate project ID
  if (!credentials.projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(credentials.projectId)) {
    return { valid: false, error: "Invalid Project ID format" };
  }

  // Validate location
  if (!credentials.location) {
    return { valid: false, error: "Location is required" };
  }

  // Validate service account email format
  if (!credentials.clientEmail || !credentials.clientEmail.includes("@") || !credentials.clientEmail.endsWith(".iam.gserviceaccount.com")) {
    return { valid: false, error: "Invalid service account email format. Should end with .iam.gserviceaccount.com" };
  }

  // Validate private key structure (PEM format)
  const keyContent = credentials.privateKey.trim();
  if (!keyContent.includes("-----BEGIN PRIVATE KEY-----") || !keyContent.includes("-----END PRIVATE KEY-----")) {
    return { valid: false, error: "Invalid private key format. Should be in PEM format" };
  }

  return { valid: true };
};

/**
 * Validate credentials based on provider type.
 */
export const validateCredentials = async (
  credentials: ProviderCredentials
): Promise<{ valid: boolean; error?: string }> => {
  switch (credentials.type) {
    case "anthropic":
      return validateAnthropicCredentials(credentials.apiKey);
    case "bedrock":
      return validateBedrockCredentials(credentials);
    case "vertex":
      return validateVertexCredentials(credentials);
    default:
      return { valid: false, error: "Unknown provider type" };
  }
};

// Re-export legacy functions for backwards compatibility
export const saveApiKey = async (apiKey: string): Promise<void> => {
  await saveCredentials({ type: "anthropic", apiKey });
};

export const loadApiKey = async (): Promise<string | null> => {
  const credentials = await loadCredentials();
  if (credentials?.type === "anthropic") {
    return credentials.apiKey;
  }
  return null;
};

export const clearApiKey = clearCredentials;
export const hasApiKey = hasCredentials;
export const validateApiKey = validateAnthropicCredentials;
