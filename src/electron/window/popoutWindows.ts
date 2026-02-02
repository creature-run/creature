/**
 * Popout Window Management
 *
 * Creates and manages popout windows for MCP pips.
 */

import { BrowserWindow } from "electron";
import path from "node:path";
import { getMainWindow } from "./mainWindow";
import { getPopoutsDir } from "./paths";
import { getPipWidgetState } from "../mcp/controlPlane";

// Track popout windows by instanceId
const popoutWindows = new Map<string, BrowserWindow>();

/**
 * Style variables passed to the MCP App (MCP Apps spec CSS variable format).
 * Contains all 68+ spec-compliant CSS variables read from the main renderer's DOM.
 */
export type PopoutStyles = Record<string, string>;

/**
 * Popout parameters for MCP pips.
 */
export interface PopoutParams {
  type: "mcp";
  instanceId: string;
  title: string;
  /** Current theme - "dark" or "light" */
  theme: "dark" | "light";
  /** HTML content for MCP pips - injected via srcDoc */
  htmlContent: string;
  /** MCP server name for tool calls */
  mcpServer: string;
  /** Resource URI for the pip (used for widget state metadata) */
  resourceUri?: string;
  /** MCP Apps spec style variables for theming */
  styles: PopoutStyles;
}

/**
 * Create a popout window for an MCP pip.
 * Uses a lightweight HTML wrapper with an iframe that receives content via srcDoc.
 *
 * The popout window has its own preload script that exposes IPC for tool calls.
 * After the window loads, we inject:
 * 1. Pip metadata (instanceId, mcpServer, colors)
 * 2. HTML content via srcDoc
 * 3. The MCP Apps protocol handler script runs and sends ui/initialize
 */
export const createPopoutWindow = (params: PopoutParams): { success: boolean } => {
  const { instanceId, title, theme, htmlContent, mcpServer, resourceUri, styles } = params;
  
  // Get widget state directly from control plane for MCP App reinstantiation
  const widgetState = getPipWidgetState({ instanceId });

  const encodedTitle = encodeURIComponent(title);
  const themeParam = theme || "dark";

  const popoutsDir = getPopoutsDir();

  // Reuse main preload script - it exposes the IPC methods we need
  const preloadPath = path.join(__dirname, "preload.js");

  // MCP popout: iframe wrapper that receives HTML content via srcDoc
  const loadUrl = `file://${path.join(popoutsDir, "popout-mcp.html")}?title=${encodedTitle}&theme=${themeParam}`;
  const webPreferences: Electron.WebPreferences = {
    nodeIntegration: false,
    contextIsolation: true,
    preload: preloadPath,
    // Required for browser popouts to use <webview> tag with Electron's API
    webviewTag: true,
  };

  const popoutWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: title || "Pip",
    backgroundColor: "#0D0D0B",
    webPreferences,
  });

  popoutWindow.loadURL(loadUrl);

  // Inject pip metadata and HTML content after window loads
  popoutWindow.webContents.once("did-finish-load", () => {
    // Escape the HTML content for safe injection into JavaScript
    const escapedHtml = htmlContent
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$");

    // Inject metadata and HTML content, then call initializePopout
    // The bridge script handles creating AppBridge and injecting content into iframe
    popoutWindow.webContents.executeJavaScript(`
      (function() {
        window.__POPOUT_METADATA__ = {
          instanceId: ${JSON.stringify(instanceId)},
          mcpServer: ${JSON.stringify(mcpServer)},
          resourceUri: ${JSON.stringify(resourceUri)},
          theme: ${JSON.stringify(themeParam)},
          styles: ${JSON.stringify(styles)},
          widgetState: ${JSON.stringify(widgetState)},
        };
        window.__POPOUT_HTML_CONTENT__ = \`${escapedHtml}\`;

        // Initialize AppBridge (function is exposed by popout-mcp-bridge.js)
        if (typeof window.initializePopout === 'function') {
          window.initializePopout();
        } else {
          console.error('[Popout] initializePopout not available');
        }
      })();
    `);
  });

  // Track and clean up popout windows
  popoutWindows.set(instanceId, popoutWindow);
  popoutWindow.on("closed", () => {
    popoutWindows.delete(instanceId);
    // Get fresh widget state from control plane before notifying main window
    const closedWidgetState = getPipWidgetState({ instanceId });
    const mainWindow = getMainWindow();
    mainWindow?.webContents.send("window:popoutClosed", { instanceId, widgetState: closedWidgetState });
  });

  return { success: true };
};

/**
 * Focus a popout window by instance ID.
 */
export const focusPopoutWindow = (instanceId: string): { success: boolean } => {
  const popoutWindow = popoutWindows.get(instanceId);
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.focus();
    return { success: true };
  }
  return { success: false };
};

/**
 * Get a popout window by instance ID.
 */
export const getPopoutWindow = (instanceId: string): BrowserWindow | undefined => {
  return popoutWindows.get(instanceId);
};

/**
 * Broadcast theme change to all popout windows.
 * Called when user toggles theme in the main app.
 * Each popout window will forward this to its MCP App via AppBridge.
 */
export const broadcastThemeToPopouts = ({
  theme,
  styles,
}: {
  theme: "dark" | "light";
  styles: PopoutStyles;
}): void => {
  for (const [instanceId, popoutWindow] of popoutWindows) {
    if (!popoutWindow.isDestroyed()) {
      popoutWindow.webContents.send("popout:theme-changed", { theme, styles });
    }
  }
};
