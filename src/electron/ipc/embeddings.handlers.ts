import { ipcMain } from "electron";
import type { EmbeddingsCredentials, EmbeddingsProviderType } from "../../shared/embeddings";
import {
  saveEmbeddingsCredentials,
  loadEmbeddingsCredentials,
  clearEmbeddingsCredentials,
} from "../embeddings/credentialsStore";

export interface EmbeddingsState {
  hasCredentials: boolean;
  providerType?: EmbeddingsProviderType;
  model?: string;
}

let cachedCredentials: EmbeddingsCredentials | null = null;

export const getEmbeddingsCredentials = (): EmbeddingsCredentials | null => {
  return cachedCredentials;
};

export const getEmbeddingsState = (): EmbeddingsState => {
  return {
    hasCredentials: cachedCredentials !== null,
    providerType: cachedCredentials?.type,
    model: cachedCredentials?.type === "openai" ? cachedCredentials.model : undefined,
  };
};

export const registerEmbeddingsHandlers = () => {
  ipcMain.handle("embeddings:getState", async () => {
    if (cachedCredentials === null) {
      cachedCredentials = await loadEmbeddingsCredentials();
    }
    return getEmbeddingsState();
  });

  ipcMain.handle(
    "embeddings:saveCredentials",
    async (_event, { credentials }: { credentials: EmbeddingsCredentials }) => {
      if (!credentials || typeof credentials !== "object" || !credentials.type) {
        return { success: false, error: "Invalid credentials format" };
      }

      if (credentials.type !== "openai") {
        return { success: false, error: "Unsupported embeddings provider" };
      }

      if (!credentials.apiKey || typeof credentials.apiKey !== "string") {
        return { success: false, error: "API key is required" };
      }

      try {
        await saveEmbeddingsCredentials({
          type: "openai",
          apiKey: credentials.apiKey.trim(),
          model: credentials.model?.trim() || undefined,
        });
        cachedCredentials = {
          type: "openai",
          apiKey: credentials.apiKey.trim(),
          model: credentials.model?.trim() || undefined,
        };
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to save embeddings credentials",
        };
      }
    }
  );

  ipcMain.handle("embeddings:clearCredentials", async () => {
    try {
      await clearEmbeddingsCredentials();
      cachedCredentials = null;
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to clear embeddings credentials",
      };
    }
  });
};
