/**
 * App IPC Handlers
 *
 * Handles app-level IPC events like version, platform, shell, and notifications.
 */

import { app, ipcMain, Notification } from "electron";

/**
 * Register app-related IPC handlers.
 */
export const registerAppHandlers = () => {
  ipcMain.handle("app:getVersion", () => {
    return app.getVersion();
  });

  ipcMain.handle("app:getPlatform", () => {
    return process.platform;
  });

  ipcMain.handle("shell:openExternal", async (_, url: string) => {
    const { shell } = await import("electron");
    await shell.openExternal(url);
  });

  ipcMain.handle("notification:show", async (_, options: { title: string; body?: string }) => {
    console.log("[Notification] Received request:", options);

    if (!Notification.isSupported()) {
      console.warn("[Notification] System notifications not supported on this platform");
      return { success: false, error: "Notifications not supported" };
    }

    try {
      const notification = new Notification({
        title: options.title,
        body: options.body || "",
      });

      notification.show();
      console.log("[Notification] Shown successfully");
      return { success: true };
    } catch (error) {
      console.error("[Notification] Failed to show:", error);
      return { success: false, error: String(error) };
    }
  });
};

