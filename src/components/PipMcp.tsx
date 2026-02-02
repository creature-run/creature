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

interface PipMcpContentProps {
  /** Pip data from context */
  pip: Pip;
  /** Theme colors for consistent styling */
  colors: ThemeColors;
}

/**
 * PipMcpContent Component
 *
 * Renders the content of an MCP pip using the MCP Apps protocol via AppBridge SDK.
 * The AppBridge handles all JSON-RPC communication with the Guest UI:
 * - ui/initialize (request/response handshake)
 * - ui/notifications/tool-input (sends tool arguments)
 * - ui/notifications/tool-result (sends tool execution result)
 * - ui/notifications/host-context-changed (theme/viewport changes)
 * - tools/call (Guest UI can call server tools)
 * - ui/resource-teardown (cleanup before pip closes)
 *
 * Lifecycle (per MCP Apps spec):
 * 1. Iframe loads with placeholder content (creates contentWindow)
 * 2. AppBridge connects, establishing transport
 * 3. Real HTML content is injected into iframe
 * 4. Guest UI sends ui/initialize request
 * 5. Host (AppBridge) responds with McpUiInitializeResult
 * 6. Guest UI sends ui/notifications/initialized
 * 7. onInitialized callback fires, renderer notifies main process via pip:ready
 * 8. Main process sends ui/notifications/tool-input via IPC
 * 9. Renderer forwards notification to Guest via AppBridge
 */
export function PipMcpContent({ pip, colors }: PipMcpContentProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [initialized, setInitialized] = useState(false);
  const { isDarkMode, specStyleVariables } = useTheme();
  const { session, auth } = useApp();

  /**
   * Track whether the bridge is ready to receive messages.
   * Content is only injected into iframe AFTER bridge is listening.
   */
  const [bridgeReady, setBridgeReady] = useState(false);

  /**
   * Widget state key for PIP pips: conversationId:pip:instanceId
   */
  const widgetStateKey = useMemo(
    () => `${session.sessionId}:pip:${pip.instanceId}`,
    [session.sessionId, pip.instanceId]
  );

  /**
   * AppBridge instance and cleanup function.
   * Stored in ref to persist across renders.
   */
  const bridgeRef = useRef<CreatureAppBridgeInstance | null>(null);

  /**
   * Track the last initialized pip version to prevent duplicate bridges.
   * Format: "instanceId-refreshVersion"
   */
  const lastInitializedVersionRef = useRef<string>("");

  /**
   * Get theme value for hostContext.
   */
  const getTheme = useCallback((): McpUiTheme => {
    return isDarkMode ? "dark" : "light";
  }, [isDarkMode]);

  /**
   * Phase 1: Create AppBridge BEFORE loading real content.
   * This ensures the Host is listening when the Guest sends ui/initialize.
   * 
   * Flow:
   * 1. Render iframe with placeholder content (creates contentWindow)
   * 2. Create AppBridge and call connect() - Host now listening
   * 3. Set bridgeReady=true, which triggers content injection
   * 4. Guest loads, sends ui/initialize, Host receives it
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

    /**
     * Initialize the AppBridge with placeholder iframe.
     * Bridge must be ready BEFORE real content is injected.
     */
    const initBridge = async () => {
      // Brief wait for iframe element to be fully ready
      await new Promise((resolve) => setTimeout(resolve, 50));

      if (isCleanedUp || !iframe.contentWindow) {
        return;
      }

      // Check again after wait (React Strict Mode protection)
      if (lastInitializedVersionRef.current === versionKey) {
        return;
      }

      lastInitializedVersionRef.current = versionKey;

      // Get container dimensions for hostContext
      const viewportWidth = container.clientWidth || 400;
      const viewportHeight = container.clientHeight || 300;

      // Restore widget state from in-memory store if available
      const widgetStateKey = `${session.sessionId}:pip:${pip.instanceId}`;
      const restoredWidgetState = widgetStateStore.get(widgetStateKey);

      try {
        const bridgeInstance = await createCreatureAppBridge({
          iframe,
          instanceId: pip.instanceId || "",
          serverName: pip.mcpServer,
          resourceUri: pip.resourceUri,
          conversationId: session.sessionId,
          // PIP pips don't have a messageId - they use instanceId instead
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
              // Use "restore" when we have widgetState to restore from (pop back in, refresh)
              // Otherwise use original trigger type
              triggeredBy: restoredWidgetState
                ? "restore"
                : pip.triggeredByTool !== false
                  ? "tool"
                  : "user",
            },
          },
          onInitialized: () => {
            const instanceIdValue = pip.instanceId || "";
            setInitialized(true);
            
            // Notify main process that pip is ready to receive notifications
            window.electronAPI.controlPlane.pipReady(instanceIdValue)
              .catch((error) => {
                console.error(`[PanelMcp] Pip ready failed`, { instanceId: instanceIdValue, error });
              });
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
        
        // Bridge is now listening - safe to inject real content
        setBridgeReady(true);
      } catch (error) {
        console.error(`[PanelMcp] Failed to create AppBridge`, { instanceId: pip.instanceId, error });
      }
    };

    // Start initialization immediately (iframe has placeholder content)
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
  // Note: getTheme is intentionally NOT in dependencies. Theme changes are handled
  // by a separate effect that sends host-context-changed notifications. Including
  // getTheme here would cause unnecessary bridge recreation and iframe reloads,
  // which loses app state (e.g., terminal buffer content).
  }, [pip.htmlContent, pip.instanceId, pip.mcpServer, pip.refreshVersion, session.sessionId]);

  /**
   * Phase 2: Inject real HTML content AFTER bridge is ready.
   * This ensures Host is listening before Guest sends ui/initialize.
   */
  useEffect(() => {
    const iframe = iframeRef.current;

    if (!bridgeReady || !iframe || !pip.htmlContent) {
      return;
    }

    // Inject real content now that bridge is listening
    iframe.srcdoc = pip.htmlContent;
  }, [bridgeReady, pip.htmlContent, pip.instanceId]);

  /**
   * Listen for tool-input notifications from main process.
   * Forward to Guest UI via AppBridge.
   */
  useEffect(() => {
    if (!pip.instanceId || !bridgeRef.current) return;

    const unsubscribe = window.electronAPI.controlPlane.onToolInput((data) => {
      if (data.instanceId !== pip.instanceId) return;

      const bridge = bridgeRef.current;
      if (!bridge) return;

      bridge.bridge.sendToolInput({
        arguments: data.arguments,
      });
    });

    return unsubscribe;
  }, [pip.instanceId, initialized]);

  /**
   * Listen for tool-result notifications from main process.
   * Forward to Guest UI via AppBridge.
   * 
   * Register as soon as bridge is ready (not waiting for initialized)
   * to avoid race condition where pipReady is called before this
   * effect runs due to React's rendering cycle.
   */
  useEffect(() => {
    if (!pip.instanceId || !bridgeReady) return;

    const unsubscribe = window.electronAPI.controlPlane.onToolResult((data) => {
      if (data.instanceId !== pip.instanceId) return;
      
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
  }, [pip.instanceId, bridgeReady]);

  /**
   * Listen for teardown requests from the control plane.
   * AppBridge.teardownResource handles the cleanup flow.
   */
  useEffect(() => {
    if (!pip.instanceId) return;

    const unsubscribe = window.electronAPI.controlPlane.onPipTeardown(async (data) => {
      if (data.instanceId !== pip.instanceId) return;

      const bridge = bridgeRef.current;
      if (bridge) {
        try {
          // AppBridge handles sending ui/resource-teardown and waiting for response
          await bridge.cleanup();
        } catch (_error) {
          // Teardown errors are expected if pip already closed
        }
      }

      // Notify control plane that teardown is complete
      window.electronAPI.controlPlane.pipTeardownComplete(pip.instanceId || "");
    });

    return unsubscribe;
  }, [pip.instanceId]);

  /**
   * Send host-context-changed notification when theme changes.
   * Uses specStyleVariables from ThemeContext to avoid DOM timing issues.
   * The variables are stored in context state after being loaded from IPC,
   * so they're always in sync with the current theme.
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
   * Send viewport change notifications when container resizes.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !initialized || !bridgeRef.current) return;

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
          const bridge = bridgeRef.current;
          if (!bridge) return;

          bridge.bridge.sendHostContextChange({
            containerDimensions: {
              maxWidth: roundedWidth,
              maxHeight: roundedHeight,
            },
          });
          debounceTimer = null;
        }, 100);
      }
    });

    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [initialized]);

  /**
   * Injects scrollbar-hiding styles into the iframe.
   */
  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    try {
      const style = iframe.contentDocument?.createElement("style");
      if (style) {
        style.textContent =
          "*::-webkit-scrollbar { display: none; } * { scrollbar-width: none; -ms-overflow-style: none; }";
        iframe.contentDocument?.head.appendChild(style);
      }
    } catch {
      // Cross-origin - can't inject styles
    }
  }, []);

  // If no HTML content, show loading state
  if (!pip.htmlContent) {
    return (
      <div
        className="w-full h-full flex items-center justify-center"
        style={{ backgroundColor: colors.backgroundPrimary, color: colors.textSecondary }}
      >
        <p>Loading pip...</p>
      </div>
    );
  }

  // Use refreshVersion as part of the key to force iframe remount when MCP is restarted
  const iframeKey = `${pip.instanceId}-v${pip.refreshVersion ?? 0}`;

  return (
    <div ref={containerRef} className="w-full h-full">
      <iframe
        key={iframeKey}
        ref={iframeRef}
        srcDoc={PLACEHOLDER_HTML}
        sandbox="allow-scripts allow-same-origin allow-forms"
        className="w-full h-full border-0"
        style={{ backgroundColor: colors.backgroundPrimary }}
        title={pip.title}
        onLoad={handleIframeLoad}
      />
    </div>
  );
}
