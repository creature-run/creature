/**
 * Control Plane
 *
 * Manages Pip Instances and routes MCP Apps protocol notifications.
 *
 * ## View-Based Routing
 *
 * Routing is determined by the `views` configuration on UI resources.
 * Views maps URL-like path patterns to tool names:
 *
 * ```typescript
 * views: {
 *   "/": ["notes_list"],                    // Root view, single instance
 *   "/editor": ["notes_create"],            // Creates new, gets identity from response
 *   "/editor/:noteId": ["notes_open", ...]  // One instance per unique noteId
 * }
 * ```
 *
 * Routing priority:
 * 1. Explicit instanceId in args → route to that pip directly
 * 2. Find view path for tool → derive routing behavior from path pattern
 *    - `/` (root) → single instance for root
 *    - `/path` (no params) → creates new instance
 *    - `/path/:param` → one instance per unique param value
 *
 * MCP App developers must set routing params in widgetState.modelContent
 * via setState() (e.g., `modelContent: { noteId: "note_123" }`).
 *
 * IPC Events (main → renderer):
 * - pip:created - Renderer should create iframe and establish AppBridge
 * - pip:closed - Renderer should tear down pip
 * - pip:tool-input - Renderer forwards to iframe as ui/notifications/tool-input
 * - pip:tool-result - Renderer forwards to iframe as ui/notifications/tool-result
 *
 * IPC Events (renderer → main):
 * - pip:ready - Guest UI has completed initialization (sent ui/notifications/initialized)
 *
 * The Control Plane waits for pip:ready before sending tool-input and tool-result.
 * Per MCP Apps spec, Host must send ui/notifications/tool-input after initialization completes.
 */

import { BrowserWindow } from "electron";
import { readResource, callTool, getTool, getToolsForResourceUri, clearResourceCache, getResourceMetadata, type ResourceIcon, type Views } from "./client";
import { getPopoutWindow } from "../window/popoutWindows";
import { logAggregator } from "../logging";
import * as browserManager from "../browser";
import type { WidgetState } from "../../shared/types";
import { resolveInstanceIdForTool, type RoutingResult } from "./routing";

export type { WidgetState };

/**
 * BROWSER MCP SPECIAL HANDLING
 *
 * The mcp-browser MCP server is handled specially by the Host.
 * Instead of the MCP server managing the browser, the Host renders
 * a native webview for perfect quality.
 *
 * When browser_create is called:
 * 1. Host creates an instance in browserManager
 * 2. Host returns instanceId to the agent
 * 3. Pip is created with the MCP App (navigation bar only)
 * 4. PipBrowser renders the native webview
 *
 * For other browser tools (navigate, click, etc.):
 * 1. Host forwards the command to the renderer (PipBrowser)
 * 2. PipBrowser executes on the native webview
 * 3. Host returns success to the agent
 */
const BROWSER_MCP_NAME = "browser";

/**
 * Pip Instance represents a rendered UI Resource in pip (picture-in-picture) mode.
 * instanceId is the single identifier for the pip.
 */
export interface PipInstance {
  /** Instance ID - the single identifier for this pip */
  instanceId: string;
  resourceUri: string;
  serverName: string;
  toolName: string;
  title: string;
  htmlContent: string;
  /** Custom icon from resource metadata (_meta.ui.icon) */
  icon?: ResourceIcon;
  createdAt: number;
  ready: boolean;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  /** Widget state set by the Guest UI via setWidgetState() */
  widgetState?: WidgetState;
  /** Cached tool-result for resend on popout/reinit */
  lastToolResult?: {
    toolName: string;
    result: unknown;
    isError: boolean;
    source: "agent" | "ui";
  };
  /** Cached tool-input for resend on popout/reinit */
  lastToolInput?: {
    toolName: string;
    arguments: Record<string, unknown>;
  };
}

// Pip Instance registry
const pipInstances = new Map<string, PipInstance>();

/**
 * Event emitted when a UI-initiated tool call completes.
 * Used to inject the tool call into the agent's conversation history.
 *
 * Per AI SDK v6, tool calls should be represented as assistant message parts
 * with type 'dynamic-tool' to maintain the correct conversation structure.
 */
export interface UIToolExecutedEvent {
  /** Unique identifier for this tool call */
  toolCallId: string;
  /** Instance ID that initiated the call */
  instanceId: string;
  /** UI Resource URI of the pip */
  resourceUri: string;
  /** MCP server that handled the call */
  serverName: string;
  /** Tool that was called */
  toolName: string;
  /** Arguments passed to the tool */
  args: Record<string, unknown>;
  /** Result from the tool execution */
  result: unknown;
  /** Timestamp of execution */
  timestamp: number;
}

/**
 * Event emitted when a new Pip Instance is created.
 * Used to inject into the agent's conversation history so it knows about new pips.
 */
export interface PipCreatedEvent {
  /** Instance ID - the single identifier for this pip */
  instanceId: string;
  /** The resource URI of the pip */
  resourceUri: string;
  /** The MCP server (app) name that provides this tool */
  serverName: string;
  /** The tool that triggered pip creation */
  toolName: string;
  /** Timestamp of creation */
  timestamp: number;
}

// Reference to main window for IPC
let mainWindowRef: BrowserWindow | null = null;

/**
 * Set the main window reference for IPC.
 */
export const setMainWindow = (window: BrowserWindow | null) => {
  mainWindowRef = window;
};

/**
 * Send IPC message to renderer (main window).
 */
const sendToRenderer = (channel: string, data: unknown) => {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, data);
  }
};

/**
 * Send IPC message to the appropriate window for a pip.
 * If the pip is in a popout, sends ONLY to the popout window.
 * Otherwise sends to the main window.
 *
 * IMPORTANT: We don't send to both windows simultaneously because:
 * 1. It causes duplicate processing (e.g., double navigation)
 * 2. The React state for poppedOutPipIds hasn't updated when the popout
 *    calls pipReady, so renderer-side checks fail due to race condition
 *
 * When a pip returns from popout (popout window closes), the popout
 * is removed from the map, so messages go to main window correctly.
 */
const sendToPipWindow = (instanceId: string, channel: string, data: unknown) => {
  const popoutWindow = getPopoutWindow(instanceId);
  
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.webContents.send(channel, data);
  } else {
    sendToRenderer(channel, data);
  }
};

/**
 * Create a new Pip Instance for a UI Resource.
 * Fetches HTML content and notifies the renderer to create iframe.
 * The pip is not ready until the renderer sends pip:ready.
 *
 * @param resourceUri - URI of the UI resource
 * @param serverName - Name of the MCP server
 * @param toolName - Name of the tool that created this pip
 * @param instanceId - Instance ID from SDK (required - SDK generates before handler runs)
 * @param creatureAuth - Creature auth configuration from tool metadata
 * @param triggeredByTool - Whether pip was opened by a tool call (vs user action)
 */
export const createPipInstance = async ({
  resourceUri,
  serverName,
  toolName,
  instanceId,
  creatureAuth,
  triggeredByTool = true,
}: {
  resourceUri: string;
  serverName: string;
  toolName: string;
  instanceId: string;
  creatureAuth?: { managed?: boolean };
  triggeredByTool?: boolean;
}): Promise<PipInstance> => {
  // Fetch HTML content and icon from MCP server
  const { html: htmlContent, icon } = await readResource({
    serverName,
    uri: resourceUri,
  });

  // Create a promise that resolves when the pip is ready
  let resolveReady: () => void = () => {};
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const pip: PipInstance = {
    instanceId,
    resourceUri,
    serverName,
    toolName,
    title: "",
    htmlContent,
    icon,
    createdAt: Date.now(),
    ready: false,
    readyPromise,
    resolveReady,
  };

  pipInstances.set(pip.instanceId, pip);

  // Tell renderer to create iframe and perform ui/initialize
  sendToRenderer("pip:created", {
    instanceId: pip.instanceId,
    resourceUri: pip.resourceUri,
    htmlContent: pip.htmlContent,
    icon: pip.icon,
    mcpServer: pip.serverName,
    toolName: pip.toolName,
    title: pip.title,
    createdAt: pip.createdAt,
    creatureAuth,
    triggeredByTool,
  });

  return pip;
};

/**
 * Refresh all pips belonging to a specific MCP server.
 * Re-fetches HTML content and icon, notifies the renderer to update iframes.
 * Called when an MCP server is restarted.
 */
export const refreshPipsForMcp = async ({ mcpName }: { mcpName: string }): Promise<void> => {
  const pipsToRefresh = Array.from(pipInstances.values()).filter(
    (p) => p.serverName === mcpName
  );

  if (pipsToRefresh.length === 0) {
    return;
  }

  for (const pip of pipsToRefresh) {
    try {
      // Fetch fresh HTML content and icon
      const { html: htmlContent, icon } = await readResource({
        serverName: pip.serverName,
        uri: pip.resourceUri,
      });

      // Update pip instance
      pip.htmlContent = htmlContent;
      pip.icon = icon;
      pip.ready = false;

      // Create new ready promise
      let resolveReady: () => void = () => {};
      const readyPromise = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      pip.readyPromise = readyPromise;
      pip.resolveReady = resolveReady;

      // Notify renderer to update the iframe
      sendToRenderer("pip:refresh", {
        instanceId: pip.instanceId,
        htmlContent: pip.htmlContent,
        icon: pip.icon,
      });

    } catch (error) {
      console.error(`[Control Plane] Failed to refresh pip`, { instanceId: pip.instanceId, error });
    }
  }
};

/**
 * Refresh a single pip's HTML content and icon.
 * Clears the resource cache and re-fetches fresh content.
 * Does NOT restart the MCP server - just refreshes the UI content.
 */
export const refreshSinglePip = async ({
  instanceId,
}: {
  instanceId: string;
}): Promise<{ success: boolean; error?: string }> => {
  const pip = pipInstances.get(instanceId);
  if (!pip) {
    return { success: false, error: `Pip not found: ${instanceId}` };
  }

  try {
    // Clear the resource cache so we get fresh content
    clearResourceCache({
      serverName: pip.serverName,
      uri: pip.resourceUri,
    });

    // Fetch fresh HTML content and icon
    const { html: htmlContent, icon } = await readResource({
      serverName: pip.serverName,
      uri: pip.resourceUri,
    });

    // Update pip instance
    pip.htmlContent = htmlContent;
    pip.icon = icon;
    pip.ready = false;

    // Create new ready promise
    let resolveReady: () => void = () => {};
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    pip.readyPromise = readyPromise;
    pip.resolveReady = resolveReady;

    sendToRenderer("pip:refresh", {
      instanceId: pip.instanceId,
      htmlContent: pip.htmlContent,
      icon: pip.icon,
    });

    console.debug(`[Control Plane] Pip refreshed`, { instanceId: pip.instanceId, htmlLength: pip.htmlContent?.length });
    return { success: true };
  } catch (error) {
    console.error(`[Control Plane] Pip refresh failed`, { instanceId, error });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
};

/**
 * Mark a Pip Instance as ready.
 * Called when the renderer notifies that ui/initialize completed.
 *
 * Always resends lastToolInput and lastToolResult when they exist.
 * This handles both initial creation (data set after pip ready) and
 * refresh/popout return (data exists from before reinit).
 */
export const markPipReady = (instanceId: string): boolean => {
  const pip = pipInstances.get(instanceId);
  if (!pip) return false;

  const wasReady = pip.ready;

  if (!pip.ready) {
    pip.ready = true;
    pip.resolveReady();
  }

  // Resend tool data if it exists (for refresh/popout return scenarios)
  // For initial creation, this data won't exist yet - it gets sent after tool execution
  if (pip.lastToolInput) {
    sendToPipWindow(instanceId, "pip:tool-input", {
      instanceId,
      toolName: pip.lastToolInput.toolName,
      arguments: pip.lastToolInput.arguments,
    });
  }

  if (pip.lastToolResult) {
    sendToPipWindow(instanceId, "pip:tool-result", {
      instanceId,
      toolName: pip.lastToolResult.toolName,
      result: pip.lastToolResult.result,
      isError: pip.lastToolResult.isError,
      source: pip.lastToolResult.source,
    });
  }

  return true;
};

/**
 * Wait for a Pip Instance to be ready.
 * Times out after 10 seconds.
 */
const waitForPipReady = async (instanceId: string): Promise<void> => {
  const pip = pipInstances.get(instanceId);
  if (!pip) {
    throw new Error(`Pip not found: ${instanceId}`);
  }

  if (pip.ready) {
    return;
  }

  const TIMEOUT = 10000;
  let timeoutId: ReturnType<typeof setTimeout>;
  let resolved = false;
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (!resolved) {
        console.error(`[Control Plane] Pip ready timeout`, { instanceId, timeoutMs: TIMEOUT });
        reject(new Error(`Pip ready timeout: ${instanceId}`));
      }
    }, TIMEOUT);
  });

  try {
    await Promise.race([pip.readyPromise, timeoutPromise]);
    resolved = true;
  } finally {
    clearTimeout(timeoutId!);
  }
};

/**
 * Event emitted when a pip is destroyed.
 * Used to inject a message into the conversation history so the agent
 * knows the pip is no longer valid.
 */
export interface PipDestroyedEvent {
  /** Instance ID of the pip that was destroyed */
  instanceId: string;
  /** The resource URI of the pip */
  resourceUri: string;
  /** The MCP server (app) name that provided this tool */
  serverName: string;
  /** The tool that created the pip */
  toolName: string;
  /** Timestamp of destruction */
  timestamp: number;
}

/**
 * Close a Pip Instance.
 *
 * Per MCP Apps spec (SEP-1865), the proper cleanup flow is:
 * 1. Send ui/resource-teardown request to the UI iframe
 * 2. Wait for the iframe to respond (graceful termination)
 * 3. Then tear down the pip
 *
 * The renderer handles sending ui/resource-teardown to the iframe.
 * We send pip:teardown to initiate this, then pip:closed after confirmation.
 */
export const closePipInstance = async (instanceId: string): Promise<boolean> => {
  const pip = pipInstances.get(instanceId);
  if (!pip) {
    return false;
  }

  console.debug(`[Control Plane] Closing pip`, { instanceId });

  // Request teardown - renderer will send ui/resource-teardown to iframe
  // and call pip:teardown-complete when done
  sendToPipWindow(instanceId, "pip:teardown", {
    instanceId,
    reason: "Pip closed by user",
  });

  // Wait for teardown confirmation with timeout
  try {
    await waitForTeardownComplete(instanceId);
  } catch (_error) {
    // Timeout is acceptable - proceed with closure
  }

  // Capture pip info before deletion for the destroyed event
  const destroyedEvent: PipDestroyedEvent = {
    instanceId: pip.instanceId,
    resourceUri: pip.resourceUri,
    serverName: pip.serverName,
    toolName: pip.toolName,
    timestamp: Date.now(),
  };

  pipInstances.delete(instanceId);
  console.debug(`[Control Plane] Pip closed`, { instanceId });

  // Tell renderer to tear down the pip UI
  sendToRenderer("pip:closed", instanceId);

  // Emit destroyed event for conversation history injection
  // This tells the agent that this pip is no longer valid
  sendToRenderer("pip:destroyed", destroyedEvent);

  return true;
};

// Track pending teardown completions
const teardownPromises = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

/**
 * Wait for a pip teardown to complete.
 * Times out after 5 seconds to prevent hanging.
 */
const waitForTeardownComplete = (instanceId: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const TIMEOUT = 5000;

    teardownPromises.set(instanceId, { resolve, reject });

    setTimeout(() => {
      if (teardownPromises.has(instanceId)) {
        teardownPromises.delete(instanceId);
        reject(new Error(`Teardown timeout: ${instanceId}`));
      }
    }, TIMEOUT);
  });
};

/**
 * Mark a pip teardown as complete.
 * Called by the renderer after the iframe responds to ui/resource-teardown.
 */
export const markTeardownComplete = (instanceId: string): void => {
  const pending = teardownPromises.get(instanceId);
  if (pending) {
    teardownPromises.delete(instanceId);
    pending.resolve();
  }
};

/**
 * Get all active Pip Instances.
 */
export const getPipInstances = (): PipInstance[] => {
  return Array.from(pipInstances.values());
};

/**
 * Get a Pip Instance by ID.
 */
export const getPipInstance = (instanceId: string): PipInstance | undefined => {
  return pipInstances.get(instanceId);
};

/**
 * Update a pip's title.
 * Used by browser pips to sync the webpage title to the pip tab.
 */
export const updatePipTitle = ({
  instanceId,
  title,
}: {
  instanceId: string;
  title: string;
}): boolean => {
  const pip = pipInstances.get(instanceId);
  if (!pip) return false;

  if (pip.title !== title) {
    pip.title = title;
    sendToPipWindow(instanceId, "pip:title-changed", { instanceId, title });
  }

  return true;
};

/**
 * Update a pip's widget state.
 * Called when the Guest UI sends a widget-state-changed notification.
 * The modelContent is included in the system prompt for AI continuity.
 *
 * @param instanceId - The pip instanceId to update
 * @param widgetState - The new widget state (or null to clear)
 * @returns true if the pip was found and updated
 */
export const updatePipWidgetState = ({
  instanceId,
  widgetState,
}: {
  instanceId: string;
  widgetState: WidgetState | null;
}): boolean => {
  const pip = pipInstances.get(instanceId);
  if (!pip) return false;

  if (widgetState) {
    pip.widgetState = widgetState;
  } else {
    delete pip.widgetState;
  }

  return true;
};

/**
 * Get a pip's widget state.
 * Used to pass widget state to popout windows for reinstantiation.
 *
 * @param instanceId - The pip instanceId to query
 * @returns The widget state or null if not found
 */
export const getPipWidgetState = ({
  instanceId,
}: {
  instanceId: string;
}): WidgetState | null => {
  const pip = pipInstances.get(instanceId);
  return pip?.widgetState ?? null;
};

/**
 * Find all Pip Instances by serverName.
 * Used for broadcasting state changes to all pips from the same MCP server.
 * For example, when an inline todo_add action happens, all pips
 * for that MCP server should receive the update.
 */
export const findPipsByServerName = (serverName: string): PipInstance[] => {
  const pips: PipInstance[] = [];
  for (const pip of pipInstances.values()) {
    if (pip.serverName === serverName) {
      pips.push(pip);
    }
  }
  return pips;
};

/**
 * Launch a pip for a UI resource directly (without a tool call).
 * If a pip already exists for this resource, returns its instanceId to focus it.
 * Otherwise creates a new pip.
 *
 * This is used by the sidebar to open MCP App pips without going through a tool call.
 */
export const launchResourcePip = async ({
  serverName,
  resourceUri,
}: {
  serverName: string;
  resourceUri: string;
}): Promise<{ success: boolean; instanceId?: string; isExisting?: boolean; error?: string }> => {
  // Check if a pip already exists for this resourceUri
  for (const pip of pipInstances.values()) {
    if (pip.resourceUri === resourceUri && pip.serverName === serverName) {
      // Found existing pip - return it to be focused
      return { success: true, instanceId: pip.instanceId, isExisting: true };
    }
  }

  // No existing pip - create a new one
  // Generate instanceId (matches SDK format for consistency)
  const instanceId = `inst_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  try {
    // Extract resource name from URI for the title (e.g., "ui://server/dashboard" -> "dashboard")
    const resourceName = resourceUri.split("/").pop() || "App";
    const title = resourceName.replace(/-/g, " ").replace(/_/g, " ");

    const pip = await createPipInstance({
      resourceUri,
      serverName,
      toolName: resourceName,
      instanceId,
      triggeredByTool: false,
    });

    return { success: true, instanceId: pip.instanceId, isExisting: false };
  } catch (error) {
    console.error(`[Control Plane] Failed to launch resource pip:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
};

/**
 * Close all Pip Instances.
 * Called when project closes to clean up all pips.
 * This prevents stale pips from being reused when a new project loads.
 */
export const closeAllPips = async (): Promise<void> => {
  const pipsToClose = Array.from(pipInstances.values());
  if (pipsToClose.length === 0) return;

  console.debug(`[Control Plane] Closing all pips (${pipsToClose.length} total)`);
  
  // Close all pips in parallel with timeout
  const closePromises = pipsToClose.map(async (pip) => {
    try {
      await closePipInstance(pip.instanceId);
    } catch (e) {
      // Force remove from map if close fails
      console.warn(`[Control Plane] Failed to close pip ${pip.instanceId}, force removing`);
      pipInstances.delete(pip.instanceId);
    }
  });

  // Wait for all with a timeout
  await Promise.race([
    Promise.all(closePromises),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);

  // Force clear any remaining pips
  if (pipInstances.size > 0) {
    console.warn(`[Control Plane] Force clearing ${pipInstances.size} remaining pips`);
    pipInstances.clear();
  }
};

/**
 * Generate a unique tool call ID for UI-initiated calls.
 */
const generateToolCallId = (): string => {
  return `ui_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
};

// =============================================================================
// View-Based Routing Logic (imported from ./routing.ts)
// =============================================================================

// =============================================================================
// Tool Result Helpers
// =============================================================================

/**
 * Extract instanceId from an MCP tool result.
 * Looks in structuredContent.instanceId first, then parses content[0].text as JSON.
 *
 * Tools with UI return `instanceId` in their responses to identify
 * which instance the result belongs to.
 */
const extractInstanceId = (result: unknown): string | undefined => {
  if (!result || typeof result !== "object") return undefined;

  const r = result as Record<string, unknown>;

  // Check structuredContent.instanceId first (preferred location)
  if (r.structuredContent && typeof r.structuredContent === "object") {
    const sc = r.structuredContent as Record<string, unknown>;
    if (typeof sc.instanceId === "string") {
      return sc.instanceId;
    }
  }

  // Fallback: parse content[0].text as JSON
  if (Array.isArray(r.content) && r.content.length > 0) {
    const first = r.content[0];
    if (first && typeof first === "object" && first.type === "text" && typeof first.text === "string") {
      try {
        const parsed = JSON.parse(first.text);
        if (typeof parsed.instanceId === "string") {
          return parsed.instanceId;
        }
      } catch {
        // Not JSON, ignore
      }
    }
  }

  return undefined;
};

/**
 * Extract title from an MCP tool result's structuredContent.
 * Per MCP Apps spec, structuredContent contains structured data for UI rendering.
 *
 * Any MCP can return a `title` field in structuredContent to update the pip title.
 * This provides a generic interface for all MCPs to control their pip's display title.
 */
const extractTitle = (result: unknown): string | undefined => {
  if (!result || typeof result !== "object") return undefined;

  const r = result as Record<string, unknown>;

  // Check structuredContent.title (preferred location per MCP Apps spec)
  if (r.structuredContent && typeof r.structuredContent === "object") {
    const sc = r.structuredContent as Record<string, unknown>;
    if (typeof sc.title === "string" && sc.title.length > 0) {
      return sc.title;
    }
  }

  return undefined;
};

/**
 * Strip structuredContent from tool result for conversation history.
 *
 * Per MCP Apps spec, structuredContent is for UI rendering only,
 * not for model context. This prevents duplicate content in the
 * conversation history which bloats context and increases costs.
 *
 * The UI pip still receives the full result via pip:tool-result IPC.
 */
const stripStructuredContent = (result: unknown): unknown => {
  if (!result || typeof result !== "object") return result;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { structuredContent, ...rest } = result as Record<string, unknown>;
  return rest;
};

/**
 * Strip large image data from tool results to prevent token limit errors.
 * 
 * Screenshots and other image content can be 100k+ tokens when base64 encoded.
 * This replaces image content with a placeholder message while preserving
 * the result structure for the agent.
 * 
 * The UI pip still receives the full result via pip:tool-result IPC.
 */
const stripLargeImageData = (result: unknown): unknown => {
  if (!result || typeof result !== "object") return result;
  
  const resultObj = result as Record<string, unknown>;
  if (!resultObj.content || !Array.isArray(resultObj.content)) return result;
  
  const hasLargeImage = resultObj.content.some(
    (item: { type?: string; data?: string }) => 
      item.type === "image" && item.data && item.data.length > 1000
  );
  
  if (!hasLargeImage) return result;
  
  // Replace image content with placeholder
  return {
    ...resultObj,
    content: resultObj.content.map((item: { type?: string; data?: string }) => {
      if (item.type === "image" && item.data && item.data.length > 1000) {
        return {
          type: "text",
          text: "[Screenshot captured - image omitted from conversation to save tokens. View in browser pip.]",
        };
      }
      return item;
    }),
  };
};

/**
 * Handle browser tool calls.
 *
 * Browser tools are executed by the Host, not the MCP server.
 * The MCP server just declares the tools - the Host manages the native webview.
 *
 * For browser_create:
 * - Create an instance in browserManager
 * - Return success with instanceId
 *
 * For other browser tools:
 * - Forward the command to the renderer (PipBrowser)
 * - PipBrowser executes on the native webview
 */
const handleBrowserToolCall = async ({
  toolName,
  args,
  instanceId: inputInstanceId,
}: {
  toolName: string;
  args: Record<string, unknown>;
  instanceId?: string;
}): Promise<unknown> => {
  const action = toolName.replace("browser_", "");

  if (action === "create") {
    // Create a new browser instance
    const url = (args.url as string) || "about:blank";

    // Generate instanceId if not provided (matches SDK format for consistency)
    const instanceId = inputInstanceId || `inst_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    browserManager.createInstance({
      instanceId,
      url,
    });

    // Return instanceId for routing - Host will create pip based on this
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, instanceId, url }) }],
      structuredContent: {
        instanceId,
        url,
        title: "New Browser",
      },
    };
  }

  // For other browser tools, forward to the renderer
  // The agent passes instanceId which routes to the pip
  const instanceId = args.instanceId as string;
  if (!instanceId) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: "instanceId required" }) }],
      structuredContent: { success: false, error: "instanceId required" },
    };
  }

  const instance = browserManager.getInstance(instanceId);
  if (!instance) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: "Instance not found" }) }],
      structuredContent: { success: false, error: "Instance not found" },
    };
  }

  // Forward command to renderer
  await browserManager.executeCommand({
    instanceId,
    command: {
      action,
      url: args.url as string | undefined,
      x: args.x as number | undefined,
      y: args.y as number | undefined,
      selector: args.selector as string | undefined,
      text: args.text as string | undefined,
      direction: args.direction as "up" | "down" | undefined,
      amount: args.amount as number | undefined,
      fullPage: args.fullPage as boolean | undefined,
    },
  });

  // For screenshot, we need to handle it specially (capture from webview)
  if (action === "screenshot") {
    // Screenshot is handled asynchronously by PipBrowser
    // For now, return a placeholder - the actual screenshot will be sent via IPC
    return {
      content: [{ type: "text", text: "Screenshot requested - see browser pip" }],
      structuredContent: { success: true, action: "screenshot" },
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ success: true, action }) }],
    structuredContent: { success: true, action, instanceId },
  };
};

/**
 * Wrapper around routing.resolveInstanceIdForTool that provides
 * the pipInstances map and logging.
 */
const resolveInstanceIdForToolCall = ({
  serverName,
  toolName,
  args,
  resourceUri,
}: {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  resourceUri: string;
}): RoutingResult => {
  const resourceMeta = getResourceMetadata({ serverName, uri: resourceUri });

  const result = resolveInstanceIdForTool({
    pipInstances: pipInstances.values(),
    getPipById: (id) => pipInstances.get(id),
    resourceMetadata: resourceMeta,
    serverName,
    toolName,
    args,
    resourceUri,
  });

  return result;
};

/**
 * Handle a tool call from the Agent or UI.
 *
 * Pip Routing Flow (control plane owns instanceId):
 * 1. Resolve instanceId based on views config BEFORE calling the tool
 * 2. Inject instanceId into args when calling the SDK
 * 3. Execute tool on MCP server
 * 4. Create pip if needed (for new instanceIds)
 * 5. Send ui/notifications/tool-input and tool-result to pip
 *
 * The control plane generates instanceId because it knows about views routing.
 * The SDK receives instanceId and uses it for state management only.
 *
 * Source Tracking:
 * - 'agent': Tool call initiated by the AI agent (already in conversation history via AI SDK)
 * - 'ui': Tool call initiated by user interaction with a Pip (needs to be injected into history)
 *
 * @returns Tool result from MCP server
 */
export const handleToolCall = async ({
  serverName,
  toolName,
  args,
  instanceId: callerInstanceId,
  source = "agent",
}: {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Only used for UI-initiated calls to identify which instance made the call */
  instanceId?: string;
  /** Source of the tool call - 'agent' for AI-initiated, 'ui' for user pip interaction */
  source?: "agent" | "ui";
}) => {
  // Log tool call input to Dev Console
  logAggregator.log({
    source: "host",
    level: "info",
    message: `[Tool Call] ${serverName}/${toolName} (${source}) Input: ${JSON.stringify(args)}`,
  });

  // Get tool metadata to check for UI Resource
  const toolDef = getTool(serverName, toolName);
  const resourceUri = toolDef?.resourceUri;

  // Determine display mode from args.displayMode.
  // All MCPs must use "displayMode" as the standardized parameter name.
  const requestedDisplayMode = typeof args.displayMode === "string" ? args.displayMode : undefined;
  const displayMode = requestedDisplayMode || toolDef?.defaultDisplayMode || "pip";
  const isInlineMode = displayMode === "inline" && source === "agent";

  let targetInstanceId = callerInstanceId;
  let isNewPip = false;
  let isReusingReadyPip = false;

  // Determine if we should create/manage a pip:
  // - Agent-initiated calls with pip mode (not inline mode)
  // - UI-initiated calls WITHOUT instanceId (from inline widgets) with pip mode
  //   This handles the "expand to pip" action from inline widgets.
  //
  // NOTE: UI-initiated calls FROM a pip (with callerInstanceId) do NOT create new pips.
  // The result is returned to the calling pip, which handles view switching client-side.
  // This keeps pip management simple - only agents can spawn new pips.
  const shouldManagePip = resourceUri && !isInlineMode && (
    source === "agent" ||
    (source === "ui" && !callerInstanceId && displayMode === "pip")
  );

  // Resolve instanceId BEFORE calling the tool (control plane owns routing)
  if (shouldManagePip && resourceUri) {
    const resolved = resolveInstanceIdForToolCall({
      serverName,
      toolName,
      args,
      resourceUri,
    });

    // Skip pip management if routing returned an error
    if (!resolved.error && resolved.instanceId) {
      targetInstanceId = resolved.instanceId;
      // Cast to PipInstance since pipInstances map stores full PipInstance objects
      const existingPip = resolved.existingPip as PipInstance | undefined;
      isReusingReadyPip = existingPip?.ready ?? false;

      // If no existing pip, we'll create one after the tool call
      if (!existingPip) {
        isNewPip = true;
      }
    }
  }

  // Execute tool on MCP server with instanceId in args
  // SPECIAL HANDLING: Browser MCP tools are executed by the Host
  let result: unknown;

  if (serverName === BROWSER_MCP_NAME && toolName.startsWith("browser_")) {
    result = await handleBrowserToolCall({
      toolName,
      args,
      instanceId: targetInstanceId,
    });
  } else {
    // Inject _source and _instanceId into args
    // The SDK uses _instanceId for state management and WebSocket routing
    // Note: _instanceId is injected whenever we have a targetInstanceId and resourceUri,
    // regardless of shouldManagePip (which only controls pip CREATION)
    const shouldInjectInstanceId = targetInstanceId && resourceUri;
    const argsWithContext = {
      ...args,
      _source: source,
      ...(shouldInjectInstanceId ? { _instanceId: targetInstanceId } : {}),
    };

    result = await callTool({ serverName, toolName, args: argsWithContext });
  }

  // Log tool call result to Dev Console
  logAggregator.log({
    source: "host",
    level: "info",
    message: `[Tool Result] ${serverName}/${toolName} Output: ${JSON.stringify(result)}`,
  });

  // Create pip if needed (for new instanceIds)
  if (shouldManagePip && resourceUri && targetInstanceId && isNewPip) {
    await createPipInstance({
      resourceUri,
      serverName,
      toolName,
      instanceId: targetInstanceId,
      creatureAuth: toolDef?.creatureAuth,
    });
  }

  // Per MCP Apps spec, Host MUST send ui/notifications/tool-input after Guest's
  // initialize request completes. Queue this to be sent when pip is ready.
  if (shouldManagePip && targetInstanceId) {
    const instanceId = targetInstanceId;
    const targetPip = pipInstances.get(instanceId);
    
    // Store tool-input for resend on reinit (popout close, refresh)
    if (targetPip) {
      targetPip.lastToolInput = { toolName, arguments: args || {} };
    }
    
    const toolInputPayload = {
      instanceId,
      toolName,
      arguments: args || {},
    };
    
    // If reusing an already-ready pip, send immediately (no waitForPipReady needed).
    // Otherwise wait for pip to become ready (new pip or pip still loading).
    if (isReusingReadyPip) {
      sendToPipWindow(instanceId, "pip:tool-input", toolInputPayload);
    } else {
      waitForPipReady(instanceId).then(() => {
        sendToPipWindow(instanceId, "pip:tool-input", toolInputPayload);
      });
    }
  }

  // Extract title from MCP result's structuredContent.
  // Per MCP Apps spec, any MCP can return a `title` field to update the pip title.
  // This provides a generic interface for all MCPs to control their pip's display.
  //
  // Only update the title if the tool's resourceUri matches the pip's resourceUri.
  // This prevents inline tools (e.g., todo_toggle with resourceUri "todo-card") from
  // incorrectly updating the pip's title (e.g., "todos") when called from its UI.
  //
  // MCP Apps that need title updates after mutations should call their list/refresh
  // tool which will return the correct title for that resource.
  if (targetInstanceId && resourceUri) {
    const pip = pipInstances.get(targetInstanceId);
    const extractedTitle = extractTitle(result);
    
    // Only update title if resource URIs match (prevents inline tools from updating pip titles)
    if (pip && extractedTitle && pip.resourceUri === resourceUri) {
      updatePipTitle({ instanceId: targetInstanceId, title: extractedTitle });
    }
  }

  // If a new pip was created, emit event for conversation history injection.
  if (isNewPip && targetInstanceId && resourceUri) {
    const createdEvent: PipCreatedEvent = {
      instanceId: targetInstanceId,
      resourceUri,
      serverName,
      toolName,
      timestamp: Date.now(),
    };
    sendToRenderer("pip:created-history", createdEvent);
  }

  // Send tool-result notification to the pip if:
  // - Agent-initiated call with UI resource (routes to target pip based on views config)
  // - UI-initiated call that created a new pip (expand from inline to pip)
  //
  // Queue this to be sent when pip is ready (non-blocking).
  // This ensures the streaming isn't disrupted while still delivering
  // notifications to the pip.
  if (resourceUri && targetInstanceId && (source === "agent" || isNewPip)) {
    const instanceId = targetInstanceId;
    const toolResultPayload = {
      instanceId,
      toolName,
      result,
      isError: false,
      source, // Include source so UI can distinguish agent vs UI calls
    };

    const targetPip = pipInstances.get(instanceId);
    if (targetPip) {
      // Store tool-result for resend on popout/reinit
      targetPip.lastToolResult = { toolName, result, isError: false, source };
    }

    // If reusing an already-ready pip, send immediately (no waitForPipReady needed).
    // Otherwise wait for pip to become ready (new pip or pip still loading).
    if (isReusingReadyPip) {
      sendToPipWindow(instanceId, "pip:tool-result", toolResultPayload);
    } else {
      waitForPipReady(instanceId).then(() => {
        sendToPipWindow(instanceId, "pip:tool-result", toolResultPayload);
      });
    }
  }

  // For UI-initiated calls from a pip, send tool-result back to the calling pip.
  // This enables SPA-like behavior where the pip's useViews hook can switch views
  // based on the tool result. The pip handles view transitions client-side.
  // Note: This is separate from agent routing - UI calls always return to caller.
  if (source === "ui" && callerInstanceId && resourceUri) {
    const callerPip = pipInstances.get(callerInstanceId);
    if (callerPip) {
      // Store tool-result for resend on popout/reinit (preserves view state)
      callerPip.lastToolResult = { toolName, result, isError: false, source };
      callerPip.lastToolInput = { toolName, arguments: args || {} };

      const toolResultPayload = {
        instanceId: callerInstanceId,
        toolName,
        result,
        isError: false,
        source,
      };
      // Caller pip should already be ready (user just clicked in it)
      sendToPipWindow(callerInstanceId, "pip:tool-result", toolResultPayload);
    }
  }

  // For UI-initiated calls, emit event so the renderer can inject into conversation history
  // Agent-initiated calls are already in the history via AI SDK streaming
  if (source === "ui" && callerInstanceId) {
    const pip = pipInstances.get(callerInstanceId);
    // Strip structuredContent per MCP Apps spec - it's for UI only, not model context
    const event: UIToolExecutedEvent = {
      toolCallId: generateToolCallId(),
      instanceId: callerInstanceId,
      resourceUri: pip?.resourceUri || "",
      serverName,
      toolName,
      args,
      result: stripStructuredContent(result),
      timestamp: Date.now(),
    };
    sendToRenderer("ui-tool:executed", event);
  }

  // For inline mode, add metadata so the renderer knows to display inline widget.
  // IMPORTANT: Do NOT include htmlContent here - it would bloat conversation history
  // and exceed API token limits. The InlineWidget fetches HTML via IPC instead.
  if (isInlineMode && resourceUri) {
    // Broadcast tool-result to all pips for the same server ONLY for single-instance tools.
    // This allows the pip (e.g., todo list) to update when an inline action
    // (e.g., todo_add confirmation) happens. The pips share the same MCP server state.
    //
    // For multi-instance tools (those with instanceId in result), each instance is
    // independent so we skip broadcasting.
    const instanceIdFromResult = extractInstanceId(result);
    const isMultiInstance = !!instanceIdFromResult;

    if (!isMultiInstance) {
      const pips = findPipsByServerName(serverName);
      for (const pip of pips) {
        sendToPipWindow(pip.instanceId, "pip:tool-result", {
          instanceId: pip.instanceId,
          toolName,
          result,
          isError: false,
          source: "agent", // Inline mode is always agent-initiated
        });
      }
    }

    const resultObj = result as Record<string, unknown>;
    // Strip large image data to prevent token limit errors
    const sanitizedResult = stripLargeImageData(resultObj);
    return {
      ...(sanitizedResult as Record<string, unknown>),
      _inlineDisplay: {
        resourceUri,
        serverName,
        toolName,
        displayModes: toolDef?.displayModes || ["pip"],
        creatureAuth: toolDef?.creatureAuth,
      },
    };
  }

  // Strip large image data (e.g., screenshots) to prevent token limit errors.
  // The UI pip already received the full result via pip:tool-result IPC.
  return stripLargeImageData(result);
};

/**
 * Get active Pip Instances formatted for Agent system prompt.
 * Shows which pips exist and which tools can use them.
 * Agents pass instanceId to route to specific pips.
 *
 * The agent uses this information to decide:
 * - Whether to reuse an existing pip (pass instanceId in args)
 * - Which instanceId to pass to tools for multi-instance tools
 */
export const getActivePipsForPrompt = (): string => {
  const pips = getPipInstances();
  if (pips.length === 0) return "No active PIP tabs.";

  return pips
    .map((p) => {
      let info = `### ${p.instanceId}\n`;
      info += `  Resource: ${p.resourceUri}\n`;

      // Show which tools can use this pip
      const tools = getToolsForResourceUri(p.resourceUri);
      if (tools.length > 0) {
        info += `  Tools: ${tools.join(", ")}\n`;
      }

      // Include modelContent from widget state if available.
      // This allows the AI to see widget data on follow-up turns.
      if (p.widgetState?.modelContent) {
        const modelContent = p.widgetState.modelContent;
        const contentStr = typeof modelContent === "string"
          ? modelContent
          : JSON.stringify(modelContent, null, 2);
        info += `  Current Widget State:\n${contentStr.split("\n").map(line => `    ${line}`).join("\n")}`;
      }

      return info;
    })
    .join("\n\n");
};

