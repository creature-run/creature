/**
 * WebView Manager
 *
 * Manages browser instances for the mcp-browser MCP server.
 * Browser instances are rendered using Electron's native webview tag
 * in the renderer process (PipBrowser.tsx).
 *
 * IMPORTANT: This is a Host-specific feature that deviates from the MCP Apps spec.
 * Normal MCP Apps render their UI entirely in an iframe. The mcp-browser MCP
 * uses a hybrid approach where:
 * 1. The MCP App iframe contains only the navigation bar
 * 2. The Host renders a native webview for the actual browser content
 *
 * This provides perfect rendering quality while still following MCP patterns.
 * Other MCP servers cannot use this - it's hardcoded to mcp-browser only.
 *
 * Instance Management:
 * - Instances are identified by instanceId (same as other MCPs)
 * - Instances are created when browser_create tool is called
 * - Instances persist when pips are minimized
 * - Instances are destroyed when pips are closed
 */

import { BrowserWindow } from "electron";

/**
 * Represents a browser instance.
 * The actual webview is rendered in the renderer process.
 */
export interface BrowserInstance {
  instanceId: string;
  url: string;
  title: string;
  createdAt: Date;
}

/**
 * State sent to the MCP App UI (navigation bar).
 */
export interface BrowserState {
  instanceId: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

/**
 * Browser command from MCP tool or UI.
 */
export interface BrowserCommand {
  action: string;
  instanceId?: string;
  url?: string;
  x?: number;
  y?: number;
  selector?: string;
  text?: string;
  direction?: "up" | "down";
  amount?: number;
  fullPage?: boolean;
}

// Instance registry keyed by instanceId
const instances = new Map<string, BrowserInstance>();

// Reference to main window for IPC
let mainWindowRef: BrowserWindow | null = null;

/**
 * Set the main window reference for IPC communication.
 */
export const setMainWindow = (window: BrowserWindow | null) => {
  mainWindowRef = window;
};

/**
 * Send a message to the renderer process.
 */
const sendToRenderer = (channel: string, data: unknown) => {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, data);
  }
};

/**
 * Create a new browser instance.
 *
 * This is called when the browser_create tool is invoked.
 * The actual webview is created in the renderer process (PipBrowser.tsx).
 */
export const createInstance = ({
  instanceId,
  url = "about:blank",
}: {
  instanceId: string;
  url?: string;
}): BrowserInstance => {
  const instance: BrowserInstance = {
    instanceId,
    url,
    title: "",
    createdAt: new Date(),
  };

  instances.set(instanceId, instance);

  // Tell renderer to create the webview
  sendToRenderer("browser:instance-created", {
    instanceId,
    url,
  });

  return instance;
};

/**
 * Get an instance by ID.
 */
export const getInstance = (instanceId: string): BrowserInstance | undefined => {
  return instances.get(instanceId);
};

/**
 * Update instance state from renderer.
 * Called when the webview navigates or changes state.
 */
export const updateInstanceState = ({
  instanceId,
  url,
  title,
}: {
  instanceId: string;
  url?: string;
  title?: string;
}) => {
  const instance = instances.get(instanceId);
  if (!instance) return;

  if (url !== undefined) instance.url = url;
  if (title !== undefined) instance.title = title;
};

/**
 * Execute a browser command on an instance.
 *
 * Commands are forwarded to the renderer process which executes
 * them on the native webview.
 */
export const executeCommand = async ({
  instanceId,
  command,
}: {
  instanceId: string;
  command: BrowserCommand;
}): Promise<{ success: boolean; error?: string; data?: unknown }> => {
  const instance = instances.get(instanceId);
  if (!instance) {
    return { success: false, error: "Instance not found" };
  }

  // Forward command to renderer
  sendToRenderer("browser:command", {
    instanceId,
    command,
  });

  // For most commands, we return immediately.
  // The renderer will handle the command and send state updates.
  return { success: true };
};

/**
 * Close a browser instance.
 */
export const closeInstance = (instanceId: string): boolean => {
  const instance = instances.get(instanceId);
  if (!instance) return false;

  instances.delete(instanceId);

  // Tell renderer to destroy the webview
  sendToRenderer("browser:instance-closed", { instanceId });

  return true;
};

/**
 * List all active instances.
 */
export const listInstances = (): BrowserInstance[] => {
  return Array.from(instances.values());
};

/**
 * Close all instances.
 * Called during shutdown.
 */
export const closeAllInstances = () => {
  const instanceIds = Array.from(instances.keys());

  for (const instanceId of instanceIds) {
    closeInstance(instanceId);
  }
};
