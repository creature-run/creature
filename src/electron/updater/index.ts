/**
 * Auto-Updater Module
 *
 * Handles automatic updates for the desktop app.
 * Updates are downloaded in the background and installed on quit.
 * Users are notified via toast when an update is available/downloaded.
 */

import { autoUpdater } from "electron-updater";
import { app, BrowserWindow, ipcMain } from "electron";

/** Check interval: 4 hours in milliseconds */
const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000;

/** Track if an update has been downloaded and is pending installation */
let updatePending = false;
/** Store the pending update version for late listeners */
let pendingUpdateVersion: string | null = null;

/**
 * Check if an update has been downloaded and is ready to install.
 */
export const isUpdatePending = () => updatePending;

/**
 * Get pending update info (for renderer to check on mount).
 */
export const getPendingUpdateInfo = () => {
  if (updatePending && pendingUpdateVersion) {
    return { pending: true, version: pendingUpdateVersion };
  }
  return { pending: false, version: null };
};

/**
 * Initialize the auto-updater.
 * Should only be called in production (when app is packaged).
 *
 * Behavior:
 * - Checks for updates immediately on startup
 * - Rechecks every 4 hours while app is running
 * - Downloads updates silently in the background
 * - Installs updates when the app quits
 */
export const initAutoUpdater = () => {
  // Configure for silent operation
  autoUpdater.autoDownload = true;
  // Let electron-updater handle the quit-and-install automatically
  autoUpdater.autoInstallOnAppQuit = true;

  // Disable update notifications (we handle this silently)
  autoUpdater.disableWebInstaller = true;

  // Log update events for debugging
  autoUpdater.on("checking-for-update", () => {
    console.log("[Updater] Checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    console.log(`[Updater] Update available: v${info.version}`);
    // Notify renderer about available update
    const mainWindow = BrowserWindow.getAllWindows()[0];
    mainWindow?.webContents.send("updater:available", { version: info.version });
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[Updater] App is up to date");
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log(`[Updater] Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[Updater] Update downloaded: v${info.version} - will install on quit`);
    console.log(`[Updater] autoInstallOnAppQuit: ${autoUpdater.autoInstallOnAppQuit}`);
    console.log(`[Updater] App path: ${app.getAppPath()}`);
    console.log(`[Updater] Exe path: ${app.getPath("exe")}`);
    updatePending = true;
    pendingUpdateVersion = info.version;
    // Notify renderer about downloaded update
    const mainWindow = BrowserWindow.getAllWindows()[0];
    console.log(`[Updater] Sending updater:downloaded to renderer, mainWindow exists: ${!!mainWindow}`);
    mainWindow?.webContents.send("updater:downloaded", { version: info.version });
  });

  autoUpdater.on("error", (error) => {
    console.error("[Updater] Error:", error.message);
  });

  // Log when before-quit-for-update is emitted (internal electron-updater event)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (autoUpdater as any).on("before-quit-for-update", () => {
    console.log("[Updater] before-quit-for-update event - Squirrel.Mac will take over");
  });

  // Check for updates immediately
  checkForUpdates();

  // Schedule periodic update checks
  setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);

  // Register IPC handler for manual quit and install
  ipcMain.handle("updater:quitAndInstall", () => {
    console.log("[Updater] Manual quitAndInstall triggered from renderer");
    quitAndInstall();
  });

  // Register IPC handler to get pending update info (for late listeners)
  ipcMain.handle("updater:getPendingInfo", () => {
    return getPendingUpdateInfo();
  });
};

/**
 * Check for updates.
 * Wrapped in try-catch to prevent crashes if update server is unreachable
 * or if the app-update.yml config file is missing (unsigned dev builds).
 */
const checkForUpdates = async () => {
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // Ignore expected errors in dev/unsigned builds
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (errorMessage.includes("app-update.yml") || errorMessage.includes("ENOENT")) {
      // Config file missing - expected for unsigned/packaged-but-not-published builds
      console.log("[Updater] Auto-update not configured (app-update.yml missing)");
    } else {
      console.error("[Updater] Failed to check for updates:", errorMessage);
    }
  }
};

/**
 * Force quit and install a downloaded update immediately.
 * Use this if you want to force an update at a specific time
 * rather than waiting for the user to quit.
 */
export const quitAndInstall = () => {
  autoUpdater.quitAndInstall(false, true);
};
