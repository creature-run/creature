/**
 * Main Process Entry Point
 *
 * Orchestrates app startup, shutdown, and module initialization.
 * All business logic is delegated to specialized modules.
 */

import { app, BrowserWindow, ipcMain, session } from "electron";
import started from "electron-squirrel-startup";

// Module imports
import { registerAllIpcHandlers } from "./ipc";
import { closeAllConnections as closeMcpConnections } from "./mcp/client";
import { createMainWindow, createAppMenu, setupDockIcon } from "./window/mainWindow";
import { getChatServer, stopChatServer } from "./server/chatServer";
import { installHostConsoleCapture } from "./logging";
import { initAutoUpdater, isUpdatePending } from "./updater";
import * as telemetry from "./telemetry";

// Track app start time for startup_ms metric
const appStartTime = Date.now();

// Install host console capture early to capture all logs including startup.
// This must happen before any console.log calls we want to capture.
installHostConsoleCapture();

// Set the app name for the menu bar (required for dev mode on macOS)
app.setName("Creature");

// Suppress noisy GPU compositor errors (harmless Chromium internal messages)
app.commandLine.appendSwitch("disable-gpu-driver-bug-workarounds");
app.commandLine.appendSwitch("log-level", "3"); // Only show fatal errors

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Track if we're in the process of quitting
let isQuitting = false;

/**
 * Configure webview session permissions.
 */
const configureWebviewPermissions = () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    delete responseHeaders["X-Frame-Options"];
    delete responseHeaders["x-frame-options"];
    delete responseHeaders["Content-Security-Policy"];
    delete responseHeaders["content-security-policy"];
    callback({ responseHeaders });
  });

  // Allow webviews to load any URL with safe defaults
  app.on("web-contents-created", (_, contents) => {
    contents.on("will-attach-webview", (_, webPreferences) => {
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.javascript = true;
    });
  });
};

/**
 * App ready handler.
 * Initializes all modules and creates the main window.
 */
app.on("ready", () => {
  console.log("Creature Initialized");

  // Initialize telemetry early to capture all events
  telemetry.init();

  setupDockIcon();
  createAppMenu();
  registerAllIpcHandlers();

  // Configure webview permissions
  configureWebviewPermissions();

  // Initialize auto-updater (production only)
  if (app.isPackaged) {
    initAutoUpdater();
  } else {
    // Register stub handler in dev to prevent console errors
    ipcMain.handle("updater:getPendingInfo", () => ({
      pending: false,
      version: null,
    }));
  }

  // MCPs are now initialized when a folder is opened (not on app startup)
  // Chat server is also started when a folder is opened (not on app startup)

  // Create the main window
  createMainWindow();

  // Track app ready with startup timing
  const startupMs = Date.now() - appStartTime;
  telemetry.track("app_ready", { startup_ms: startupMs });
});

// Quit when all windows are closed, except on macOS
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Clean up MCP connections, chat server, and telemetry before quitting
app.on("before-quit", async (event) => {
  console.log(`[App] before-quit fired, isQuitting=${isQuitting}, isPackaged=${app.isPackaged}`);
  
  // If already cleaned up, allow the quit to proceed normally
  if (isQuitting) {
    console.log("[App] Already quitting, allowing quit to proceed");
    return;
  }

  isQuitting = true;

  // If an update is pending, let electron-updater handle the quit naturally
  // Don't prevent default or do async cleanup that could interfere with the update
  if (app.isPackaged && isUpdatePending()) {
    console.log("[App] Update pending - letting electron-updater handle quit (not preventing default)");
    // Do quick synchronous cleanup only
    return;
  }

  // No update pending - we can do async cleanup
  console.log("[App] No update pending - doing async cleanup");
  event.preventDefault();

  try {
    // Shutdown telemetry first to capture final events
    await telemetry.shutdown();
    console.log("[App] Telemetry shutdown complete");

    // Close the chat server (if running)
    const chatServer = getChatServer();
    if (chatServer) {
      await stopChatServer();
      console.log("[App] Chat server closed");
    }

    // Close MCP connections
    await closeMcpConnections();
    console.log("[App] Cleanup complete, quitting...");
  } catch (e) {
    console.error("[App] Cleanup error:", e);
  }

  // Force quit without re-triggering before-quit
  app.exit(0);
});

// Log when app is about to quit (after all before-quit handlers)
app.on("will-quit", (event) => {
  console.log("[App] will-quit fired - app is about to exit");
});

// On macOS, re-create window when dock icon is clicked
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

// Track uncaught exceptions for error telemetry
process.on("uncaughtException", (error) => {
  console.error("[App] Uncaught exception:", error);
  telemetry.track("error_uncaught", {
    type: "exception",
    name: error.name,
    message: error.message?.slice(0, 500), // Truncate for safety
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("[App] Unhandled rejection:", reason);
  const error = reason instanceof Error ? reason : new Error(String(reason));
  telemetry.track("error_uncaught", {
    type: "rejection",
    name: error.name,
    message: error.message?.slice(0, 500), // Truncate for safety
  });
});
