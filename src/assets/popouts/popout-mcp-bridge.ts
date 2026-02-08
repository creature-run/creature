/**
 * Popout MCP Bridge
 *
 * AppBridge integration for MCP pip popout windows.
 * This script runs in the popout window's renderer process and manages
 * communication between the iframe (Guest UI) and the main process.
 *
 * Architecture:
 * - Main Process: injects metadata + HTML content after window loads
 * - This Script: creates AppBridge, connects transport, handles IPC
 * - Iframe: runs the Guest UI (MCP App)
 *
 * Browser Mode:
 * - For browser pips, we use a special layout with nav bar iframe + webview
 * - The nav bar sends browser/* commands which we handle to control the webview
 * - We send browser/state-changed back to the nav bar
 *
 * This ensures popout windows have identical behavior to PipMcp.tsx/PipBrowser.tsx,
 * following the MCP Apps protocol exactly.
 */

import {
  createCreatureAppBridge,
  type CreatureAppBridgeInstance,
} from "../../lib/appBridge";
import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";

/**
 * Popout metadata injected by main process via executeJavaScript.
 * Contains everything needed to initialize the AppBridge.
 */
interface PopoutMetadata {
  instanceId: string;
  mcpServer: string;
  resourceUri?: string;
  theme: "dark" | "light";
  /** MCP Apps spec style variables read from main renderer's DOM */
  styles: Record<string, string>;
  /** Widget state from control plane for MCP App state restoration */
  widgetState?: Record<string, unknown> | null;
}

interface UiRuntimeError {
  name?: string;
  message?: string;
  stack?: string;
  source?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  timestamp?: string;
}

/**
 * Extended WebviewTag interface with Electron-specific methods.
 */
interface WebviewElement extends HTMLElement {
  src: string;
  loadURL: (url: string) => Promise<void>;
  reload: () => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getURL: () => string;
  getTitle: () => string;
  isLoading: () => boolean;
  setZoomFactor: (factor: number) => void;
  addEventListener: (event: string, callback: (event: Event) => void) => void;
  removeEventListener: (event: string, callback: (event: Event) => void) => void;
}

declare global {
  interface Window {
    /** Pip metadata injected by main process */
    __POPOUT_METADATA__?: PopoutMetadata;
    /** HTML content to inject into iframe */
    __POPOUT_HTML_CONTENT__?: string;
    /** Initialization function exposed for main process to call */
    initializePopout?: () => Promise<void>;
  }
}

/** Active bridge instance for cleanup and notifications */
let bridgeInstance: CreatureAppBridgeInstance | null = null;

/** Track whether initialization has been called */
let isInitialized = false;

/** Browser webview reference (only used in browser mode) */
let browserWebview: WebviewElement | null = null;

/** Browser instance ID (only used in browser mode) */
let browserInstanceId: string | undefined;

/** Loading overlay element — visible by default, hidden when Guest sends initialized */
let loadingOverlay: HTMLDivElement | null = null;

/** Track if browser navigation has started (prevents double loadURL from tool-input + tool-result) */
let browserNavigationStarted = false;

/** Track if browser webview dom-ready has fired */
let browserWebviewReady = false;

/** Queue of browser commands received before webview was ready */
let pendingBrowserCommands: Array<{ command: string; params: Record<string, unknown> }> = [];

/** Track the active iframe for UI error capture */
let activeIframe: HTMLIFrameElement | null = null;

/** UI error overlay elements */
let uiErrorOverlay: HTMLDivElement | null = null;
let uiErrorBody: HTMLDivElement | null = null;
let uiErrorCopyButton: HTMLButtonElement | null = null;

/**
 * Hide the loading overlay with a fade-out transition.
 * Called when the Guest sends ui/notifications/initialized, signaling
 * the MCP App is ready to be displayed to the user.
 */
const hideLoadingOverlay = (): void => {
  if (!loadingOverlay) {
    loadingOverlay = document.getElementById("loading-overlay") as HTMLDivElement | null;
  }
  if (loadingOverlay) {
    loadingOverlay.classList.add("hidden");
  }
};

/**
 * Show the loading overlay (reset to visible state).
 * Called before re-initializing content on refresh so the user
 * sees a spinner while the new content boots.
 */
const showLoadingOverlay = (): void => {
  if (!loadingOverlay) {
    loadingOverlay = document.getElementById("loading-overlay") as HTMLDivElement | null;
  }
  if (loadingOverlay) {
    loadingOverlay.classList.remove("hidden");
  }
};

/**
 * Initialize the UI error overlay elements.
 * Captures references and wires the copy handler for fast access.
 */
const initializeUiErrorOverlay = (): void => {
  if (uiErrorOverlay) return;
  uiErrorOverlay = document.getElementById("ui-error-overlay") as HTMLDivElement | null;
  uiErrorBody = document.getElementById("ui-error-body") as HTMLDivElement | null;
  uiErrorCopyButton = document.getElementById("ui-error-copy") as HTMLButtonElement | null;

  if (uiErrorCopyButton) {
    uiErrorCopyButton.addEventListener("click", () => {
      const text = uiErrorBody?.textContent || "";
      if (!text) return;
      navigator.clipboard.writeText(text).catch(() => {
        // Ignore clipboard failures to avoid blocking the UI error overlay
      });
    });
  }
};

/**
 * Format UI runtime errors for display and logging.
 * Ensures a consistent, readable error string in overlays and logs.
 */
const formatUiError = ({ error }: { error: UiRuntimeError }): string => {
  const headerParts = [error.name || "Error", error.message || "Unknown error"].filter(Boolean);
  const header = headerParts.join(": ");
  const location = error.filename
    ? `${error.filename}${error.lineno ? `:${error.lineno}` : ""}${error.colno ? `:${error.colno}` : ""}`
    : "";
  const source = error.source ? `Source: ${error.source}` : "";
  const timestamp = error.timestamp ? `Time: ${error.timestamp}` : "";
  const stack = error.stack ? `\n${error.stack}` : "";
  const extras = [location, source, timestamp].filter(Boolean).join("\n");
  return [header, extras].filter(Boolean).join("\n") + stack;
};

/**
 * Show UI error overlay with formatted details.
 * Keeps the app background while surfacing the failure clearly.
 */
const showUiErrorOverlay = ({ error }: { error: UiRuntimeError }): void => {
  initializeUiErrorOverlay();
  if (!uiErrorOverlay || !uiErrorBody) return;
  uiErrorBody.textContent = formatUiError({ error });
  uiErrorOverlay.classList.add("visible");
};

/**
 * Hide the UI error overlay.
 * Clears previous error content to avoid stale display after recovery.
 */
const clearUiErrorOverlay = (): void => {
  if (!uiErrorOverlay || !uiErrorBody) return;
  uiErrorBody.textContent = "";
  uiErrorOverlay.classList.remove("visible");
};

/**
 * Handle UI error messages posted from the iframe.
 * Captures runtime errors and forwards them to the Dev Console logs.
 */
const handleUiErrorMessage = (event: MessageEvent): void => {
  if (!activeIframe || event.source !== activeIframe.contentWindow) return;
  const data = event.data as { method?: string; params?: UiRuntimeError } | null;
  if (!data || data.method !== "ui/error") return;

  const errorPayload = data.params || {};
  showUiErrorOverlay({ error: errorPayload });

  const metadata = window.__POPOUT_METADATA__;
  if (!metadata) return;

  window.electronAPI.logs.fromUI({
    instanceId: metadata.instanceId,
    mcpServer: metadata.mcpServer,
    level: "error",
    message: formatUiError({ error: errorPayload }),
    timestamp: errorPayload.timestamp || new Date().toISOString(),
  });
};

/**
 * Initialize the popout with AppBridge.
 * Called by main process after metadata and HTML content are injected.
 *
 * Flow:
 * 1. Main process loads popout-mcp.html
 * 2. This script loads and exposes initializePopout
 * 3. Main process injects __POPOUT_METADATA__ and __POPOUT_HTML_CONTENT__
 * 4. Main process calls initializePopout()
 * 5. For browser: switch to browser layout, set up webview
 * 6. Inject HTML content into iframe (after load for correct contentWindow)
 * 7. Create AppBridge
 * 8. Guest UI sends ui/initialize, AppBridge responds
 * 9. Guest sends ui/notifications/initialized, we notify main process
 */
const initializePopout = async (): Promise<void> => {
  // Prevent double initialization
  if (isInitialized) {
    console.warn("[Popout] Already initialized, skipping");
    return;
  }
  isInitialized = true;

  const metadata = window.__POPOUT_METADATA__;
  const htmlContent = window.__POPOUT_HTML_CONTENT__;

  if (!metadata) {
    console.error("[Popout] Missing metadata");
    return;
  }

  if (!htmlContent) {
    console.error("[Popout] Missing HTML content");
    return;
  }

  console.log("[Popout] Initializing", { instanceId: metadata.instanceId, mcpServer: metadata.mcpServer });

  // Check if this is a browser pip
  const isBrowserMode = metadata.mcpServer === "browser";
  
  // Get the appropriate iframe based on mode
  const iframe = isBrowserMode 
    ? document.getElementById("browser-nav-frame") as HTMLIFrameElement
    : document.getElementById("content-frame") as HTMLIFrameElement;
    
  if (!iframe) {
    console.error("[Popout] Iframe not found");
    return;
  }

  // For browser mode, switch the layout and set up webview
  if (isBrowserMode) {
    document.body.classList.add("browser-mode");
    const webviewEl = document.getElementById("browser-webview");
    browserWebview = webviewEl as WebviewElement;
    if (browserWebview) {
      setupBrowserWebview(browserWebview, iframe);
    } else {
      console.error("[Popout] Browser webview not found");
    }
  }

  // Brief wait for iframe to be fully ready
  await new Promise((resolve) => setTimeout(resolve, 50));

  if (!iframe.contentWindow) {
    console.error("[Popout] Iframe contentWindow not available");
    return;
  }

  // Set browser instance ID for browser mode
  if (isBrowserMode) {
    browserInstanceId = metadata.instanceId;
  }

  // Track active iframe for UI error capture and reset overlay
  activeIframe = iframe;
  initializeUiErrorOverlay();
  clearUiErrorOverlay();

  // Inject HTML content FIRST - this triggers iframe reload
  // The iframe needs to load with the real content so AppBridge gets the correct contentWindow
  iframe.srcdoc = htmlContent;

  // Wait for iframe to reload with new content
  await new Promise<void>((resolve) => {
    const onLoad = () => {
      iframe.removeEventListener("load", onLoad);
      resolve();
    };
    iframe.addEventListener("load", onLoad);
    // Timeout fallback in case load event doesn't fire
    setTimeout(resolve, 500);
  });

  if (!iframe.contentWindow) {
    console.error("[Popout] Iframe contentWindow not available after load");
    return;
  }

  // Set up IPC listeners BEFORE creating bridge to avoid race condition
  // (pipReady is called in onInitialized, and control plane sends tool-result immediately)
  setupToolNotificationListeners(metadata.instanceId);
  setupTeardownListener(metadata.instanceId);
  setupThemeChangeListener();
  setupTitleChangeListener(metadata.instanceId);
  setupPipRefreshListener(metadata.instanceId, iframe);
  window.addEventListener("message", handleUiErrorMessage);

  try {
    // Create bridge AFTER content is loaded so we get the correct contentWindow
    bridgeInstance = await createCreatureAppBridge({
      iframe,
      instanceId: metadata.instanceId,
      serverName: metadata.mcpServer,
      resourceUri: metadata.resourceUri,
      hostContextParams: {
        theme: metadata.theme,
        displayMode: "pip" as McpUiDisplayMode,
        // Popout windows only support pip mode
        availableDisplayModes: ["pip"],
        containerDimensions: {
          maxWidth: iframe.clientWidth || 800,
          maxHeight: iframe.clientHeight || 600,
        },
        // Use pre-computed styles from main renderer (popout window has no globals.css)
        styles: metadata.styles,
        // Pass widget state for MCP App state restoration
        widgetState: metadata.widgetState || undefined,
        // Use triggeredBy: "restore" for popout/refresh scenarios.
        // SDK sets isReady immediately and useViews uses widgetState.modelContent.view
        // to restore the previous view without needing a tool result.
        openContext: { triggeredBy: "restore" },
      },
      onInitialized: () => {
        console.log("[Popout] Ready", { instanceId: metadata.instanceId });

        // Reveal the MCP App by hiding the loading overlay
        hideLoadingOverlay();

        // Notify main process that pip is ready to receive notifications
        window.electronAPI.controlPlane
          .pipReady(metadata.instanceId)
          .catch((error) => {
            console.error("[Popout] Pip ready failed:", error);
          });
          
        // For browser mode, send initial state after initialization
        if (isBrowserMode && browserWebview) {
          sendBrowserState(iframe, browserWebview);
        }
      },
      onLog: (params) => {
        // Forward Guest logs to DevConsole via main process
        window.electronAPI.logs.fromUI({
          instanceId: metadata.instanceId,
          mcpServer: metadata.mcpServer,
          level: params.level,
          message:
            typeof params.data === "string"
              ? params.data
              : JSON.stringify(params.data),
          timestamp: new Date().toISOString(),
        });
      },
    });

    // Set up resize observer after bridge is created
    setupResizeObserver(iframe);
    
    // For browser mode, listen for browser/* commands from the nav bar iframe
    if (isBrowserMode) {
      setupBrowserCommandListener(iframe);
    }
  } catch (error) {
    console.error("[Popout] Failed to create AppBridge:", error);
  }
};

/**
 * Set up listeners for tool-input and tool-result from main process.
 * These are forwarded to the Guest UI via AppBridge.
 * 
 * NOTE: For browser mode, we handle the URL immediately even if bridgeInstance
 * isn't ready yet. The AppBridge forwarding is best-effort.
 */
const setupToolNotificationListeners = (instanceId: string): void => {
  // Forward tool-input from main process to Guest via AppBridge
  window.electronAPI.controlPlane.onToolInput((data) => {
    if (data.instanceId !== instanceId) return;

    // For browser mode, extract initial URL from tool-input (handle immediately)
    // Only navigate if we haven't already started navigation (prevents double loadURL)
    if (browserWebview && data.arguments?.url && !browserNavigationStarted) {
      const url = data.arguments.url as string;
      console.log("[Popout] Browser navigating to:", url);
      browserNavigationStarted = true;
      browserWebview.loadURL(url).catch((err) => {
        console.error("[Popout] Failed to load URL:", err);
      });
    }

    // Forward to Guest UI if bridge is ready
    if (bridgeInstance) {
      bridgeInstance.bridge.sendToolInput({
        arguments: data.arguments,
      });
    }
  });

  // Forward tool-result from main process to Guest via AppBridge
  window.electronAPI.controlPlane.onToolResult((data) => {
    if (data.instanceId !== instanceId) return;

    const result = data.result as {
      content?: Array<{ type: string; text: string }>;
      structuredContent?: { instanceId?: string; url?: string };
    };

    // For browser mode, extract instanceId and initial URL from tool-result
    if (browserWebview && result?.structuredContent) {
      if (result.structuredContent.instanceId) {
        browserInstanceId = result.structuredContent.instanceId;
      }
      // Only navigate if we haven't already started navigation (tool-input may have already triggered it)
      if (result.structuredContent.url && !browserNavigationStarted) {
        const currentUrl = browserWebview.getURL();
        if (!currentUrl || currentUrl === "about:blank") {
          console.log("[Popout] Browser navigating to:", result.structuredContent.url);
          browserNavigationStarted = true;
          browserWebview.loadURL(result.structuredContent.url).catch((err) => {
            console.error("[Popout] Failed to load URL:", err);
          });
        }
      }
    }

    // Forward to Guest UI if bridge is ready
    if (bridgeInstance) {
      bridgeInstance.bridge.sendToolResult({
        content: result?.content || [
          { type: "text", text: JSON.stringify(data.result) },
        ],
        structuredContent: result?.structuredContent,
        isError: data.isError,
        source: data.source,
        toolName: data.toolName,
      });
    }
  });
};

/**
 * Set up listener for teardown requests from the control plane.
 * Ensures graceful cleanup when the popout window is closed.
 */
const setupTeardownListener = (instanceId: string): void => {
  window.electronAPI.controlPlane.onPipTeardown(async (data) => {
    if (data.instanceId !== instanceId || !bridgeInstance) return;

    console.debug("[Popout] Teardown requested, cleaning up bridge");
    try {
      // AppBridge handles sending ui/resource-teardown with a short timeout
      await bridgeInstance.cleanup();
    } catch {
      // Teardown errors are expected if pip already closed
    }

    // Notify control plane that teardown is complete
    console.debug("[Popout] Teardown complete, notifying control plane");
    window.electronAPI.controlPlane.pipTeardownComplete(instanceId);
  });
};

/**
 * Set up resize observer to notify Guest UI of container dimension changes.
 * Sends ui/notifications/host-context-changed with updated dimensions.
 */
const setupResizeObserver = (iframe: HTMLIFrameElement): void => {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      const roundedWidth = Math.round(width);
      const roundedHeight = Math.round(height);

      // Debounce resize notifications
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        if (!bridgeInstance) return;

        bridgeInstance.bridge.sendHostContextChange({
          containerDimensions: {
            maxWidth: roundedWidth,
            maxHeight: roundedHeight,
          },
        });
        debounceTimer = null;
      }, 100);
    }
  });

  resizeObserver.observe(iframe);
};

/**
 * Set up listener for theme changes broadcast from main app.
 * When user toggles theme in main window, all popouts receive this notification
 * and forward it to their MCP Apps via AppBridge.
 */
const setupThemeChangeListener = (): void => {
  window.electronAPI.window.onThemeChanged((data) => {
    if (!bridgeInstance) return;

    // Forward theme change to MCP App via AppBridge
    bridgeInstance.bridge.sendHostContextChange({
      theme: data.theme,
      styles: {
        variables: data.styles,
      },
    });
  });
};

/**
 * Set up listener for title changes from the control plane.
 * Updates the popout window's document title when the pip title changes.
 */
const setupTitleChangeListener = (instanceId: string): void => {
  window.electronAPI.controlPlane.onPipTitleChanged((data) => {
    if (data.instanceId !== instanceId) return;
    
    // Update the document title, which Electron uses for the window title bar
    document.title = data.title;
  });
};

/**
 * Set up listener for pip refresh events.
 * When the control plane refreshes the pip content, update the iframe's srcdoc
 * with the new HTML.
 */
const setupPipRefreshListener = (instanceId: string, iframe: HTMLIFrameElement): void => {
  window.electronAPI.controlPlane.onPipRefresh(async (data) => {
    if (data.instanceId !== instanceId) return;
    
    console.log("[Popout] Pip refresh received", { 
      instanceId, 
      htmlLength: data.htmlContent?.length || 0 
    });

    // Show loading overlay while new content boots
    showLoadingOverlay();

    // Clean up existing bridge before loading new content.
    // The cleanup function has a short teardown timeout (1.5s) so this
    // won't block for long even if the Guest is unresponsive.
    if (bridgeInstance) {
      console.debug("[Popout] Cleaning up existing bridge before refresh");
      try {
        await bridgeInstance.cleanup();
      } catch {
        // Cleanup errors are expected during refresh — Guest may be unloading
      }
      bridgeInstance = null;
      console.debug("[Popout] Previous bridge cleaned up");
    }

    // Reset UI error overlay for fresh content
    activeIframe = iframe;
    clearUiErrorOverlay();

    // Inject new HTML content
    iframe.srcdoc = data.htmlContent;

    // Wait for iframe to reload with new content
    await new Promise<void>((resolve) => {
      const onLoad = () => {
        iframe.removeEventListener("load", onLoad);
        resolve();
      };
      iframe.addEventListener("load", onLoad);
      // Timeout fallback
      setTimeout(resolve, 500);
    });

    if (!iframe.contentWindow) {
      console.error("[Popout] Iframe contentWindow not available after refresh");
      return;
    }

    const metadata = window.__POPOUT_METADATA__;
    if (!metadata) {
      console.error("[Popout] Missing metadata for refresh");
      return;
    }

    // Recreate bridge with fresh content
    console.debug("[Popout] Recreating AppBridge after refresh");
    try {
      bridgeInstance = await createCreatureAppBridge({
        iframe,
        instanceId: metadata.instanceId,
        serverName: metadata.mcpServer,
        resourceUri: metadata.resourceUri,
        hostContextParams: {
          theme: metadata.theme,
          displayMode: "pip",
          availableDisplayModes: ["pip"],
          containerDimensions: {
            maxWidth: iframe.clientWidth || 800,
            maxHeight: iframe.clientHeight || 600,
          },
          styles: metadata.styles,
          widgetState: metadata.widgetState || undefined,
          // Use triggeredBy: "restore" for refresh - restore view from widgetState
          openContext: { triggeredBy: "restore" },
        },
        onInitialized: () => {
          console.log("[Popout] Refreshed pip ready", { instanceId: metadata.instanceId });

          // Reveal the refreshed MCP App
          hideLoadingOverlay();

          window.electronAPI.controlPlane
            .pipReady(metadata.instanceId)
            .catch((error) => {
              console.error("[Popout] Pip ready failed after refresh:", error);
            });
        },
        onLog: (params) => {
          window.electronAPI.logs.fromUI({
            instanceId: metadata.instanceId,
            mcpServer: metadata.mcpServer,
            level: params.level,
            message:
              typeof params.data === "string"
                ? params.data
                : JSON.stringify(params.data),
            timestamp: new Date().toISOString(),
          });
        },
      });
      console.debug("[Popout] AppBridge recreated, waiting for Guest initialization");
    } catch (error) {
      console.error("[Popout] Failed to recreate AppBridge after refresh:", error);
    }
  });
};

// =============================================================================
// Browser Mode Functions
// =============================================================================

/**
 * Set up webview event listeners for browser mode.
 * Updates the nav bar iframe when webview state changes.
 */
const setupBrowserWebview = (webview: WebviewElement, navFrame: HTMLIFrameElement): void => {
  // Wait for webview to be ready before allowing commands
  webview.addEventListener("dom-ready", () => {
    webview.setZoomFactor(1.0);
    browserWebviewReady = true;
    sendBrowserState(navFrame, webview);
    
    // Execute any commands that arrived before webview was ready
    if (pendingBrowserCommands.length > 0) {
      console.log(`[Popout] Executing ${pendingBrowserCommands.length} queued browser commands`);
      for (const { command, params } of pendingBrowserCommands) {
        executeBrowserCommand(command, params, navFrame);
      }
      pendingBrowserCommands = [];
    }
  });

  // Update state on navigation events
  webview.addEventListener("did-navigate", () => sendBrowserState(navFrame, webview));
  webview.addEventListener("did-navigate-in-page", () => sendBrowserState(navFrame, webview));
  webview.addEventListener("did-start-loading", () => sendBrowserState(navFrame, webview));
  webview.addEventListener("did-stop-loading", () => {
    sendBrowserState(navFrame, webview);
    // Update window title when page finishes loading
    const title = webview.getTitle();
    if (title) {
      document.title = title;
    }
  });
};

/**
 * Send browser state to the nav bar iframe.
 * The nav bar UI uses this to update its display.
 */
const sendBrowserState = (navFrame: HTMLIFrameElement, webview: WebviewElement): void => {
  if (!navFrame.contentWindow) return;
  
  try {
    navFrame.contentWindow.postMessage({
      jsonrpc: "2.0",
      method: "browser/state-changed",
      params: {
        instanceId: browserInstanceId,
        url: webview.getURL(),
        title: webview.getTitle(),
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
        isLoading: webview.isLoading(),
      },
    }, "*");
  } catch (err) {
    // Webview might not be ready yet
  }
};

/**
 * Listen for browser/* commands from the nav bar iframe.
 */
const setupBrowserCommandListener = (navFrame: HTMLIFrameElement): void => {
  window.addEventListener("message", (event) => {
    // Only accept messages from our nav frame
    if (event.source !== navFrame.contentWindow) return;
    
    const data = event.data;
    if (!data || typeof data !== "object") return;
    
    // Handle browser/* commands
    if (data.method?.startsWith("browser/")) {
      const command = data.method.replace("browser/", "");
      handleBrowserCommand(command, data.params || {}, navFrame);
    }
  });
};

/**
 * Handle a browser command - queues if webview not ready, executes immediately otherwise.
 */
const handleBrowserCommand = (
  command: string,
  params: Record<string, unknown>,
  navFrame: HTMLIFrameElement
): void => {
  if (!browserWebview) {
    console.warn("[Popout] Browser webview not available for command:", command);
    return;
  }

  // Queue command if webview isn't ready yet
  if (!browserWebviewReady) {
    console.log(`[Popout] Queueing browser command until webview ready:`, command);
    pendingBrowserCommands.push({ command, params });
    return;
  }

  executeBrowserCommand(command, params, navFrame);
};

/**
 * Execute a browser command on the webview (webview must be ready).
 */
const executeBrowserCommand = async (
  command: string,
  params: Record<string, unknown>,
  navFrame: HTMLIFrameElement
): Promise<void> => {
  if (!browserWebview) return;

  switch (command) {
    case "navigate": {
      const url = params.url as string;
      if (url) {
        try {
          await browserWebview.loadURL(url);
        } catch (err) {
          console.error("[Popout] Failed to navigate:", err);
        }
      }
      break;
    }
    case "back":
      browserWebview.goBack();
      break;
    case "forward":
      browserWebview.goForward();
      break;
    case "reload":
      browserWebview.reload();
      break;
    default:
      console.warn("[Popout] Unknown browser command:", command);
  }
  
  // Send updated state after command
  setTimeout(() => sendBrowserState(navFrame, browserWebview!), 100);
};

// Expose initialization function globally for main process to call
window.initializePopout = initializePopout;
