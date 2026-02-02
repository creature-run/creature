/**
 * Settings IPC Handlers
 *
 * Handles settings-related IPC events for enterprise customization and branding.
 */

import { BrowserWindow, dialog, ipcMain } from "electron";
import {
  getSettings,
  importEnterpriseSettings,
  updateUserSettings,
  resetUserSettings,
  exportSettings,
  themeToCssVariables,
} from "../settings";
import type { BrandingSettings, ThemeMode } from "../settings";

/**
 * Register settings-related IPC handlers.
 */
export const registerSettingsHandlers = () => {
  /**
   * Get resolved settings (all layers merged).
   */
  ipcMain.handle("settings:get", () => {
    return getSettings();
  });

  /**
   * Update user settings.
   */
  ipcMain.handle(
    "settings:update",
    (
      _,
      params: {
        branding?: Partial<BrandingSettings>;
        theme?: {
          dark?: ThemeMode;
          light?: ThemeMode;
        };
      }
    ) => {
      return updateUserSettings(params);
    }
  );

  /**
   * Import enterprise settings from a file.
   * Opens a file dialog if no path provided.
   */
  ipcMain.handle("settings:import", async (_, params?: { filePath?: string }) => {
    let filePath = params?.filePath;

    if (!filePath) {
      const result = await dialog.showOpenDialog({
        title: "Import Settings",
        filters: [
          { name: "Settings Files", extensions: ["json", "creature"] },
          { name: "All Files", extensions: ["*"] },
        ],
        properties: ["openFile"],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: "No file selected" };
      }

      filePath = result.filePaths[0];
    }

    return importEnterpriseSettings({ filePath });
  });

  /**
   * Export current settings to a file.
   */
  ipcMain.handle("settings:export", async () => {
    const result = await dialog.showSaveDialog({
      title: "Export Settings",
      defaultPath: "creature-settings.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: "No file selected" };
    }

    try {
      const fs = await import("node:fs");
      const settings = exportSettings();
      fs.writeFileSync(result.filePath, JSON.stringify(settings, null, 2), "utf8");
      return { success: true, filePath: result.filePath };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  /**
   * Reset user settings to defaults.
   * Enterprise settings are preserved.
   */
  ipcMain.handle("settings:reset", () => {
    return resetUserSettings();
  });

  /**
   * Get CSS variable overrides for a theme mode.
   */
  ipcMain.handle("settings:getCssVariables", (_, params: { mode: "dark" | "light" }) => {
    const settings = getSettings();
    const theme = params.mode === "dark" ? settings.theme.dark : settings.theme.light;
    return themeToCssVariables({ theme });
  });
};

/**
 * Broadcast settings change to all windows.
 * Called after settings are updated to refresh UI.
 */
export const broadcastSettingsChange = () => {
  const settings = getSettings();
  const windows = BrowserWindow.getAllWindows();

  for (const win of windows) {
    win.webContents.send("settings:changed", settings);
  }
};
