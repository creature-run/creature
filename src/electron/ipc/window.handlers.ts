/**
 * Window IPC Handlers
 *
 * Handles window management IPC events like popout windows.
 */

import { ipcMain } from "electron";
import {
  createPopoutWindow,
  focusPopoutWindow,
  broadcastThemeToPopouts,
  type PopoutParams,
  type PopoutStyles,
} from "../window/popoutWindows";

/**
 * Register window management IPC handlers.
 */
export const registerWindowHandlers = () => {
  // Create popout window
  ipcMain.handle("window:popout", async (_, params: PopoutParams) => {
    return createPopoutWindow(params);
  });

  // Focus a popout window by instance ID
  ipcMain.handle("window:focusPopout", async (_, instanceId: string) => {
    return focusPopoutWindow(instanceId);
  });

  // Broadcast theme change to all popout windows
  ipcMain.handle(
    "window:broadcastTheme",
    async (_, params: { theme: "dark" | "light"; styles: PopoutStyles }) => {
      broadcastThemeToPopouts(params);
      return { success: true };
    }
  );
};

