/**
 * Dev Console Window Management
 *
 * Creates and manages the singleton Dev Console window.
 * The Dev Console provides debugging tools including:
 * - Unified log feed from Host, MCP servers, and UI Resources
 * - AI Agent conversation history viewer
 * - System prompt viewer
 */

import { BrowserWindow } from "electron";
import path from "node:path";
import { logAggregator } from "../logging";
import { getPopoutsDir } from "./paths";

// Singleton Dev Console window reference
let devConsoleWindow: BrowserWindow | null = null;

/**
 * Open the Dev Console window.
 * If already open, focuses the existing window.
 *
 * @returns Success status
 */
export const openDevConsoleWindow = (): { success: boolean } => {
  // If window exists and is not destroyed, focus it
  if (devConsoleWindow && !devConsoleWindow.isDestroyed()) {
    devConsoleWindow.focus();
    return { success: true };
  }

  const popoutsDir = getPopoutsDir();

  // Reuse main preload script - it exposes the IPC methods we need
  const preloadPath = path.join(__dirname, "preload.js");

  devConsoleWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    title: "Dev Console",
    backgroundColor: "#0D0D0B",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
  });

  // Load the Dev Console popout HTML
  const devConsoleUrl = `file://${path.join(popoutsDir, "popout-devconsole.html")}`;
  devConsoleWindow.loadURL(devConsoleUrl);

  // Subscribe the window to receive log updates (for the Logs tab)
  devConsoleWindow.webContents.once("did-finish-load", () => {
    if (devConsoleWindow && !devConsoleWindow.isDestroyed()) {
      logAggregator.subscribe(devConsoleWindow);
    }
  });

  // Clean up on close
  devConsoleWindow.on("closed", () => {
    if (devConsoleWindow) {
      logAggregator.unsubscribe(devConsoleWindow);
    }
    devConsoleWindow = null;
  });

  return { success: true };
};

/**
 * Get the Dev Console window instance if it exists.
 */
export const getDevConsoleWindow = (): BrowserWindow | null => {
  if (devConsoleWindow && !devConsoleWindow.isDestroyed()) {
    return devConsoleWindow;
  }
  return null;
};

/**
 * Close the Dev Console window if open.
 */
export const closeDevConsoleWindow = (): void => {
  if (devConsoleWindow && !devConsoleWindow.isDestroyed()) {
    devConsoleWindow.close();
  }
  devConsoleWindow = null;
};

