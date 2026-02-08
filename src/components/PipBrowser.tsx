import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Pip } from "../contexts/AppContext";
import { useApp } from "../contexts/AppContext";
import { useTheme, type ThemeColors } from "../contexts/ThemeContext";
import {
  createCreatureAppBridge,
  type CreatureAppBridgeInstance,
} from "../lib/appBridge";
import { widgetStateStore } from "../lib/widgetStateStore";
import type { McpUiTheme, McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";

/** Minimal placeholder HTML to initialize iframe before injecting real content */
const PLACEHOLDER_HTML = `<!DOCTYPE html><html><head></head><body></body></html>`;

/**
 * Extended WebviewTag interface with Electron-specific methods.
 * The standard HTMLElement doesn't include webview-specific APIs.
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
  executeJavaScript: (code: string) => Promise<unknown>;
  insertText: (text: string) => Promise<void>;
  sendInputEvent: (event: Electron.InputEvent) => void;
  capturePage: () => Promise<Electron.NativeImage>;
  setZoomFactor: (factor: number) => void;
  getZoomFactor: () => number;
  addEventListener: (event: string, callback: (event: Event) => void) => void;
  removeEventListener: (event: string, callback: (event: Event) => void) => void;
}

interface PipBrowserProps {
  pip: Pip;
  colors: ThemeColors;
}

/**
 * PipBrowser Component
 *
 * Renders a browser pip using a hybrid approach:
 * 1. MCP App iframe (navigation bar) - follows MCP Apps spec
 * 2. Native webview (browser content) - Host-managed for quality
 *
 * IMPORTANT: This deviates from the pure MCP Apps specification.
 * Normal MCP Apps render their entire UI in the iframe. This component
 * renders a native webview alongside the iframe to provide perfect
 * rendering quality. This capability is hardcoded to mcp-browser only
 * via the hostManagedWebview flag in the resource metadata.
 *
 * Communication:
 * - MCP App iframe sends navigation commands via postMessage (browser/*)
 * - We execute commands on the native webview
 * - We send state updates back to the iframe (browser/state-changed)
 */
export function PipBrowser({ pip, colors }: PipBrowserProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const webviewRef = useRef<WebviewElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isWebviewReady, setIsWebviewReady] = useState(false);
  const [initialUrl, setInitialUrl] = useState<string | null>(null);
  const hasNavigatedRef = useRef(false);
  
  /** Queue of browser commands received before webview was ready */
  const pendingCommandsRef = useRef<Array<{ command: string; params: Record<string, unknown> }>>([]);

  // Navigation bar height - matches the MCP App UI
  const NAV_BAR_HEIGHT = 40;

  // AppBridge and initialization state (same pattern as PipMcp)
  const { isDarkMode, specStyleVariables } = useTheme();
  const { session, pips } = useApp();
  const [bridgeReady, setBridgeReady] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const bridgeRef = useRef<CreatureAppBridgeInstance | null>(null);
  const lastInitializedVersionRef = useRef<string>("");

  /**
   * Widget state key for PIP pips: conversationId:pip:instanceId
   */
  const widgetStateKey = useMemo(
    () => `${session.sessionId}:pip:${pip.instanceId}`,
    [session.sessionId, pip.instanceId]
  );

  /**
   * Get theme value for hostContext.
   */
  const getTheme = useCallback((): McpUiTheme => {
    return isDarkMode ? "dark" : "light";
  }, [isDarkMode]);

  /** Instance ID for this pip. */
  const instanceId = pip.instanceId;

  /**
   * Send a JSON-RPC message to the MCP App iframe.
   */
  const sendToIframe = useCallback((message: object) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(message, "*");
  }, []);

  /**
   * Send browser state to the MCP App iframe.
   * The navigation bar uses this to update its display.
   */
  const sendBrowserState = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return;

    sendToIframe({
      jsonrpc: "2.0",
      method: "browser/state-changed",
      params: {
        instanceId,
        url: webview.getURL(),
        title: webview.getTitle(),
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
        isLoading: webview.isLoading(),
      },
    });
  }, [instanceId, isWebviewReady, sendToIframe]);

  /**
   * Execute a browser command on the webview (webview must be ready).
   */
  const executeBrowserCommand = useCallback(
    async (command: string, params: Record<string, unknown>) => {
      const webview = webviewRef.current;
      if (!webview) return;

      switch (command) {
        case "navigate": {
          const url = params.url as string;
          if (url) {
            try {
              await webview.loadURL(url);
            } catch (err) {
              // ERR_ABORTED (-3) is common during redirects (e.g., http→https)
              // and can be safely ignored as the final URL will still load
              console.debug(`[PipBrowser] Navigation error (may be redirect):`, err);
            }
          }
          break;
        }
        case "back":
          webview.goBack();
          break;
        case "forward":
          webview.goForward();
          break;
        case "reload":
          webview.reload();
          break;
        default:
          console.warn(`[PipBrowser] Unknown command: ${command}`);
      }
    },
    []
  );

  /**
   * Handle commands from the MCP App iframe.
   * Queues commands if webview isn't ready yet, executes immediately otherwise.
   */
  const handleBrowserCommand = useCallback(
    async (command: string, params: Record<string, unknown>) => {
      const webview = webviewRef.current;
      if (!webview) return;

      // Queue command if webview isn't ready yet
      if (!isWebviewReady) {
        console.log(`[PipBrowser] Queueing browser command until webview ready:`, command);
        pendingCommandsRef.current.push({ command, params });
        return;
      }

      await executeBrowserCommand(command, params);
    },
    [isWebviewReady, executeBrowserCommand]
  );

  /**
   * Phase 1: Create AppBridge BEFORE loading real content.
   * This ensures the Host is listening when the Guest sends ui/initialize.
   * Same pattern as PipMcp.
   */
  useEffect(() => {
    const iframe = iframeRef.current;
    const container = containerRef.current;
    if (!iframe || !container || !pip.htmlContent) return;

    // Version key to track initialization state
    const versionKey = `${pip.instanceId}-v${pip.refreshVersion ?? 0}`;

    // Skip if already initialized for this version
    if (lastInitializedVersionRef.current === versionKey) {
      return;
    }

    let isCleanedUp = false;
    let pendingBridge: CreatureAppBridgeInstance | null = null;

    const initBridge = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));

      if (isCleanedUp || !iframe.contentWindow) {
        return;
      }

      if (lastInitializedVersionRef.current === versionKey) {
        return;
      }

      lastInitializedVersionRef.current = versionKey;

      const viewportWidth = container.clientWidth || 400;
      const viewportHeight = container.clientHeight || 300;
      const restoredWidgetState = widgetStateStore.get(widgetStateKey);

      try {
        const bridgeInstance = await createCreatureAppBridge({
          iframe,
          instanceId: pip.instanceId || "",
          serverName: pip.mcpServer,
          resourceUri: pip.resourceUri,
          conversationId: session.sessionId,
          hostContextParams: {
            theme: getTheme(),
            displayMode: "pip" as McpUiDisplayMode,
            availableDisplayModes: ["inline", "pip"],
            containerDimensions: {
              maxWidth: viewportWidth,
              maxHeight: viewportHeight,
            },
            widgetState: restoredWidgetState || undefined,
            openContext: {
              // Use "restore" for restored tabs, pop-back-in flows, and refreshes with state.
              triggeredBy: pip.restored || restoredWidgetState
                ? "restore"
                : pip.triggeredByTool !== false
                  ? "tool"
                  : "user",
            },
          },
          onInitialized: () => {
            setInitialized(true);

            window.electronAPI.controlPlane.pipReady(pip.instanceId || "")
              .catch((error) => {
                console.error(`[PipBrowser] Pip ready failed`, { instanceId: pip.instanceId, error });
              });

            // Send initial browser state after initialization
            sendBrowserState();
          },
          onSizeChange: (_params) => {
            // Size changes handled by host
          },
          onLog: (params) => {
            window.electronAPI.logs.fromUI({
              instanceId: pip.instanceId || "",
              mcpServer: pip.mcpServer,
              level: params.level,
              message: typeof params.data === "string" ? params.data : JSON.stringify(params.data),
              timestamp: new Date().toISOString(),
            });
          },
        });

        if (isCleanedUp) {
          await bridgeInstance.cleanup();
          return;
        }

        pendingBridge = bridgeInstance;
        bridgeRef.current = bridgeInstance;
        setBridgeReady(true);
      } catch (error) {
        console.error(`[PipBrowser] Failed to create AppBridge`, { instanceId: pip.instanceId, error });
      }
    };

    initBridge();

    return () => {
      isCleanedUp = true;
      // Clean up either pending bridge OR current bridge
      // (pendingBridge may be null if unmount happens before initBridge completes)
      const bridgeToCleanup = pendingBridge || bridgeRef.current;
      if (bridgeToCleanup) {
        bridgeToCleanup.cleanup().catch(console.error);
      }
      setInitialized(false);
      setBridgeReady(false);
      bridgeRef.current = null;
      lastInitializedVersionRef.current = "";
    };
  // Note: getTheme and sendBrowserState are intentionally NOT in dependencies. 
  // Theme changes are handled by a separate effect that sends host-context-changed.
  // Including them here would cause unnecessary bridge recreation and iframe reloads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pip.htmlContent, pip.instanceId, pip.mcpServer, pip.resourceUri, pip.refreshVersion, session.sessionId, widgetStateKey]);

  /**
   * Phase 2: Inject real HTML content AFTER bridge is ready.
   */
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!bridgeReady || !iframe || !pip.htmlContent) return;
    iframe.srcdoc = pip.htmlContent;
  }, [bridgeReady, pip.htmlContent, pip.instanceId]);

  /**
   * Handle browser commands from iframe via postMessage.
   * The AppBridge doesn't handle custom browser/* methods, so we listen separately.
   */
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (event.source !== iframeRef.current?.contentWindow) return;

      if (data.method?.startsWith("browser/")) {
        const command = data.method.replace("browser/", "");
        handleBrowserCommand(command, data.params || {});
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleBrowserCommand]);

  /**
   * Listen for teardown requests from the control plane.
   * AppBridge.cleanup handles the ui/resource-teardown flow.
   */
  useEffect(() => {
    if (!pip.instanceId) return;

    const unsubscribe = window.electronAPI.controlPlane.onPipTeardown(async (data) => {
      if (data.instanceId !== pip.instanceId) return;

      console.log(`[PipBrowser] Received teardown request for pip ${pip.instanceId}`);

      const bridge = bridgeRef.current;
      if (bridge) {
        try {
          await bridge.cleanup();
        } catch (_error) {
          // Teardown errors are expected if pip already closed
        }
      }

      window.electronAPI.controlPlane.pipTeardownComplete(pip.instanceId || "");
    });

    return unsubscribe;
  }, [pip.instanceId]);

  /**
   * Send host-context-changed notification when theme changes.
   * Uses specStyleVariables from ThemeContext to avoid DOM timing issues.
   */
  useEffect(() => {
    if (!initialized || !bridgeRef.current) return;

    bridgeRef.current.bridge.sendHostContextChange({
      theme: getTheme(),
      styles: {
        variables: specStyleVariables,
      },
    });
  }, [initialized, isDarkMode, getTheme, specStyleVariables]);

  /**
   * Set up webview event listeners.
   */
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleDomReady = () => {
      setIsWebviewReady(true);
      // Reset zoom to 100% - the webview may inherit zoom from the parent window
      webview.setZoomFactor(1.0);
    };

    webview.addEventListener("dom-ready", handleDomReady);

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
    };
  }, [pip.instanceId]);

  /**
   * Execute any queued browser commands when webview becomes ready.
   */
  useEffect(() => {
    if (!isWebviewReady || pendingCommandsRef.current.length === 0) return;

    console.log(`[PipBrowser] Executing ${pendingCommandsRef.current.length} queued browser commands`);
    const commands = pendingCommandsRef.current;
    pendingCommandsRef.current = [];

    for (const { command, params } of commands) {
      executeBrowserCommand(command, params);
    }
  }, [isWebviewReady, executeBrowserCommand]);

  /**
   * Send browser state to navigation bar when webview state changes.
   * This runs whenever webview ready state or instanceId changes.
   */
  useEffect(() => {
    if (!isWebviewReady) return;
    sendBrowserState();
  }, [isWebviewReady, instanceId, sendBrowserState]);

  /**
   * Send browser state periodically while loading and after navigation.
   * This ensures the navigation bar stays in sync with the webview.
   * Also updates the pip title when the page finishes loading.
   */
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady) return;

    /**
     * Sync the webview's page title to the pip tab.
     * Filters out meaningless titles like "about:blank" so the tab
     * always shows either a real page title or the default "Browser".
     */
    const updateTitle = () => {
      const rawTitle = webview.getTitle();
      const isBlankTitle = !rawTitle || rawTitle === "about:blank";
      const title = isBlankTitle ? "Browser" : rawTitle;

      if (pip.instanceId && window.electronAPI?.controlPlane?.updatePipTitle) {
        window.electronAPI.controlPlane.updatePipTitle({
          instanceId: pip.instanceId,
          title,
        });
      }
    };

    // Set title immediately when webview is ready (covers the case where
    // about:blank already finished loading before event listeners were attached)
    updateTitle();

    const handleDidNavigate = () => sendBrowserState();
    const handleDidNavigateInPage = () => sendBrowserState();
    const handleDidStartLoading = () => sendBrowserState();
    const handleDidStopLoading = () => {
      sendBrowserState();
      updateTitle(); // Update pip title when page finishes loading
    };

    webview.addEventListener("did-navigate", handleDidNavigate);
    webview.addEventListener("did-navigate-in-page", handleDidNavigateInPage);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);

    return () => {
      webview.removeEventListener("did-navigate", handleDidNavigate);
      webview.removeEventListener("did-navigate-in-page", handleDidNavigateInPage);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
    };
  }, [isWebviewReady, sendBrowserState, pip.instanceId]);

  /**
   * Handle browser commands from main process (for AI control).
   * Ignores commands when pip is popped out - popout handles its own commands.
   */
  useEffect(() => {
    if (!pip.instanceId || !instanceId) return;

    const handleCommand = (data: {
      browserSessionId: string;
      instanceId: string;
      command: { action: string; url?: string; x?: number; y?: number; selector?: string; text?: string };
    }) => {
      if (data.instanceId !== pip.instanceId) return;
      
      // Ignore commands when pip is popped out
      if (pips.poppedOutPipIds.has(pip.instanceId)) return;

      const webview = webviewRef.current;
      if (!webview || !isWebviewReady) return;

      const { action, url, x, y, selector, text } = data.command;

      switch (action) {
        case "navigate":
          if (url) {
            webview.loadURL(url);
          }
          break;
        case "back":
          webview.goBack();
          break;
        case "forward":
          webview.goForward();
          break;
        case "reload":
          webview.reload();
          break;
        case "click":
          if (x !== undefined && y !== undefined) {
            // Click at coordinates
            webview.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 } as Electron.MouseInputEvent);
            webview.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 } as Electron.MouseInputEvent);
          } else if (selector) {
            // Click on element by selector
            webview.executeJavaScript(`
              (() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (el) el.click();
              })()
            `);
          }
          break;
        case "type":
          if (text) {
            if (selector) {
              // Focus element first, then type
              webview.executeJavaScript(`
                (() => {
                  const el = document.querySelector(${JSON.stringify(selector)});
                  if (el) el.focus();
                })()
              `).then(() => {
                webview.insertText(text);
              });
            } else {
              webview.insertText(text);
            }
          }
          break;
        case "scroll":
          // Handle scroll command
          break;
        case "screenshot":
          // Screenshot is handled by the main process via capturePage
          break;
      }
    };

    const unsubscribe = window.electronAPI?.controlPlane?.onBrowserCommand?.(handleCommand);
    return () => unsubscribe?.();
  }, [pip.instanceId, instanceId, isWebviewReady, pips.poppedOutPipIds]);

  /**
   * Get initial URL from tool input.
   * The control plane sends pip:tool-input after pip:ready.
   *
   * IMPORTANT: We ignore tool-input when the pip is popped out to prevent
   * duplicate navigation. The popout window handles its own tool-input.
   */
  useEffect(() => {
    if (!pip.instanceId) return;

    const handleToolInput = (data: { instanceId: string; toolName: string; arguments: Record<string, unknown> }) => {
      if (data.instanceId !== pip.instanceId) return;

      // Ignore tool-input when this pip is popped out - the popout handles it
      if (pips.poppedOutPipIds.has(pip.instanceId)) return;

      const url = data.arguments?.url;
      if (typeof url === "string") {
        setInitialUrl(url);
      }
    };

    const unsubscribe = window.electronAPI?.controlPlane?.onToolInput?.(handleToolInput);
    return () => unsubscribe?.();
  }, [pip.instanceId, pips.poppedOutPipIds]);

  /**
   * Forward tool-result to the MCP App iframe.
   * This is required for the SDK to set isReady=true for tool-triggered views.
   * Without this, the browser App stays in "Connecting..." state forever.
   */
  useEffect(() => {
    if (!pip.instanceId || !bridgeReady) return;

    const unsubscribe = window.electronAPI.controlPlane.onToolResult((data) => {
      if (data.instanceId !== pip.instanceId) return;

      // Ignore tool-result when this pip is popped out - the popout handles it
      if (pips.poppedOutPipIds.has(pip.instanceId)) return;

      const bridge = bridgeRef.current;
      if (!bridge) return;

      // Extract content from result
      const result = data.result as {
        content?: Array<{ type: string; text: string }>;
        structuredContent?: object;
      };

      bridge.bridge.sendToolResult({
        content: result.content || [{ type: "text", text: JSON.stringify(data.result) }],
        structuredContent: result.structuredContent,
        isError: data.isError,
        source: data.source,
        toolName: data.toolName,
      });
    });

    return unsubscribe;
  }, [pip.instanceId, bridgeReady, pips.poppedOutPipIds]);

  /**
   * Navigate webview to initial URL after dom-ready.
   * Electron's webview requires dom-ready before loadURL can be called.
   * We load about:blank first to trigger dom-ready, then navigate to the actual URL.
   */
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !isWebviewReady || !initialUrl || hasNavigatedRef.current) return;

    hasNavigatedRef.current = true;
    webview.loadURL(initialUrl).catch((err) => {
      console.error(`[PanelBrowser] Failed to load URL: ${err}`);
    });
  }, [isWebviewReady, initialUrl]);

  if (!pip.htmlContent) {
    return (
      <div
        className="w-full h-full flex items-center justify-center"
        style={{ backgroundColor: colors.backgroundPrimary, color: colors.textSecondary }}
      >
        <p>Loading browser...</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full flex flex-col">
      {/* MCP App iframe - navigation bar only */}
      {/* Uses placeholder HTML first, then real content after bridge is ready (2-phase loading) */}
      <iframe
        key={`${pip.instanceId}-v${pip.refreshVersion ?? 0}`}
        ref={iframeRef}
        srcDoc={PLACEHOLDER_HTML}
        sandbox="allow-scripts allow-same-origin allow-forms"
        className="w-full border-0 flex-shrink-0"
        style={{
          height: `${NAV_BAR_HEIGHT}px`,
          backgroundColor: colors.backgroundPrimary,
        }}
        title="Browser Navigation"
      />

      {/* Native webview - actual browser content */}
      {/* 
        DEVIATION FROM MCP APPS SPEC:
        This webview is rendered directly by the Host, not by the MCP App.
        It provides perfect rendering quality that cannot be achieved with
        screencast streaming or iframe embedding.
        
        NOTE: We set src="about:blank" to trigger dom-ready, which is required
        before loadURL() can be called.
      */}
      <webview
        ref={webviewRef as React.RefObject<HTMLElement>}
        src="about:blank"
        className="w-full flex-1"
        style={{
          backgroundColor: "#ffffff",
          minHeight: 0,
        }}
        // Security: partition isolates storage, webpreferences disables node integration
        partition={`persist:browser-${pip.instanceId}`}
        webpreferences="contextIsolation=yes, nodeIntegration=no"
      />
    </div>
  );
}
