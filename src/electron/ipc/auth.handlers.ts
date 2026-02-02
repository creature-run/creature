/**
 * Auth IPC Handlers
 *
 * Handles authentication-related IPC events.
 * Supports multi-provider credentials: Anthropic API, AWS Bedrock, and Google Vertex AI.
 */

import { ipcMain } from "electron";
import {
  saveCredentials,
  loadCredentials,
  clearCredentials,
  hasCredentials,
  validateCredentials,
} from "../auth/credentialsStore";
import type { ProviderCredentials, ProviderType } from "../../shared/credentials";

/**
 * Auth state for the application.
 */
export interface AuthState {
  hasCredentials: boolean;
  providerType?: ProviderType;
  // Legacy compatibility
  hasApiKey: boolean;
}

/**
 * Cache the credentials in memory for quick access.
 * Loaded on startup and updated when credentials change.
 */
let cachedCredentials: ProviderCredentials | null = null;

/**
 * Get the current credentials (from memory cache).
 */
export const getCredentials = (): ProviderCredentials | null => {
  return cachedCredentials;
};

/**
 * Get the current auth state.
 */
export const getAuthState = (): AuthState => {
  return {
    hasCredentials: cachedCredentials !== null,
    providerType: cachedCredentials?.type,
    hasApiKey: cachedCredentials !== null, // Legacy compatibility
  };
};

/**
 * Register authentication-related IPC handlers.
 */
export const registerAuthHandlers = () => {
  /**
   * Get current auth state.
   * Loads credentials from storage on first call.
   */
  ipcMain.handle("auth:getState", async () => {
    // Load credentials if not already cached
    if (cachedCredentials === null) {
      cachedCredentials = await loadCredentials();
    }
    return getAuthState();
  });

  /**
   * Save new credentials.
   * Validates the credentials first, then saves to encrypted storage.
   */
  ipcMain.handle(
    "auth:saveCredentials",
    async (_, { credentials }: { credentials: ProviderCredentials }) => {
      // Validate credentials structure
      if (!credentials || typeof credentials !== "object" || !credentials.type) {
        return { success: false, error: "Invalid credentials format" };
      }

      // Provider-specific validation
      switch (credentials.type) {
        case "anthropic":
          if (!credentials.apiKey || typeof credentials.apiKey !== "string") {
            return { success: false, error: "API key is required" };
          }
          if (!credentials.apiKey.startsWith("sk-ant-")) {
            return {
              success: false,
              error: "Invalid API key format. Key should start with 'sk-ant-'",
            };
          }
          break;

        case "bedrock":
          if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.region) {
            return { success: false, error: "All Bedrock fields are required" };
          }
          break;

        case "vertex":
          if (
            !credentials.projectId ||
            !credentials.location ||
            !credentials.clientEmail ||
            !credentials.privateKey
          ) {
            return { success: false, error: "All Vertex AI fields are required" };
          }
          break;

        default:
          return { success: false, error: "Unknown provider type" };
      }

      // Validate credentials with the provider
      const validation = await validateCredentials(credentials);
      if (!validation.valid) {
        return { success: false, error: validation.error || "Invalid credentials" };
      }

      // Save the credentials
      try {
        await saveCredentials(credentials);
        cachedCredentials = credentials;
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to save credentials",
        };
      }
    }
  );

  /**
   * Legacy handler for saving Anthropic API key.
   * Kept for backwards compatibility.
   */
  ipcMain.handle("auth:saveApiKey", async (_, { apiKey }: { apiKey: string }) => {
    // Validate the key format
    if (!apiKey || typeof apiKey !== "string") {
      return { success: false, error: "API key is required" };
    }

    if (!apiKey.startsWith("sk-ant-")) {
      return {
        success: false,
        error: "Invalid API key format. Key should start with 'sk-ant-'",
      };
    }

    const credentials: ProviderCredentials = { type: "anthropic", apiKey };

    // Validate the key with Anthropic
    const validation = await validateCredentials(credentials);
    if (!validation.valid) {
      return { success: false, error: validation.error || "Invalid API key" };
    }

    // Save the credentials
    try {
      await saveCredentials(credentials);
      cachedCredentials = credentials;
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to save API key",
      };
    }
  });

  /**
   * Clear stored credentials.
   */
  ipcMain.handle("auth:clearCredentials", async () => {
    try {
      await clearCredentials();
      cachedCredentials = null;
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to clear credentials",
      };
    }
  });

  /**
   * Legacy handler for clearing API key.
   * Kept for backwards compatibility.
   */
  ipcMain.handle("auth:clearApiKey", async () => {
    try {
      await clearCredentials();
      cachedCredentials = null;
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to clear API key",
      };
    }
  });

  /**
   * Check if credentials are stored.
   */
  ipcMain.handle("auth:hasCredentials", async () => {
    const has = await hasCredentials();
    return { hasCredentials: has, hasApiKey: has };
  });

  /**
   * Legacy handler for checking API key.
   * Kept for backwards compatibility.
   */
  ipcMain.handle("auth:hasApiKey", async () => {
    const has = await hasCredentials();
    return { hasApiKey: has };
  });
};
