import { useState, useCallback, useEffect, useRef } from "react";
import { useHost } from "open-mcp-app/react";
import { Text } from "open-mcp-app-ui";
import { NavigationBar } from "./components/NavigationBar";
import "open-mcp-app-ui/styles.css";
import "./App.css";

// =============================================================================
// Types
// =============================================================================

/** Browser state received from the Host */
interface BrowserState {
  instanceId: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

/** Widget state structure for persistence */
interface BrowserWidgetState {
  modelContent: { currentUrl: string; title: string };
  privateContent: { browserState: BrowserState | null };
}

// =============================================================================
// Component
// =============================================================================

/**
 * Browser MCP App
 *
 * Minimal UI that provides only the navigation bar.
 * The actual browser content is rendered by the Host in a native webview.
 *
 * Communication:
 * - Sends navigation commands to Host via postMessage (browser/*)
 * - Receives state updates from Host via postMessage (browser/state-changed)
 */
const App = () => {
  const [browserState, setBrowserState] = useState<BrowserState | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const browserStateRef = useRef<BrowserState | null>(null);
  
  /** 
   * Track restoration state to prevent overwriting saved state during popout.
   * When restoring, we skip saving until the webview reaches the target URL.
   */
  const restoringRef = useRef<{ targetUrl: string } | null>(null);
  const hasAttemptedRestoreRef = useRef(false);

  // ---------------------------------------------------------------------------
  // SDK Connection
  // ---------------------------------------------------------------------------

  const { isReady, exp_widgetState } = useHost({
    name: "Browser",
    version: "1.0.0",
    onTeardown: useCallback(async () => {
      // No cleanup needed - host manages the webview
    }, []),
  });

  const [widgetState, setWidgetState] = exp_widgetState<BrowserWidgetState>();

  // ---------------------------------------------------------------------------
  // Widget State Persistence
  // ---------------------------------------------------------------------------

  /**
   * Save current browser state to widget state for persistence.
   * Skips saving during restoration to prevent overwriting with blank URLs.
   */
  const saveWidgetState = useCallback(() => {
    const state = browserStateRef.current;
    if (!state) return;

    // Skip saving during restoration - wait until we reach the target URL
    if (restoringRef.current) {
      const { targetUrl } = restoringRef.current;
      // Check if we've reached the target URL (comparing origins to handle trailing slashes)
      const currentOrigin = state.url ? new URL(state.url).origin : "";
      const targetOrigin = targetUrl ? new URL(targetUrl).origin : "";
      if (currentOrigin === targetOrigin && state.url.startsWith(targetOrigin)) {
        // We've reached the target - clear restoration flag
        restoringRef.current = null;
      } else {
        // Still restoring - don't save yet
        return;
      }
    }

    setWidgetState({
      modelContent: {
        currentUrl: state.url,
        title: state.title,
      },
      privateContent: {
        browserState: state,
      },
    } satisfies BrowserWidgetState);
  }, [setWidgetState]);

  /**
   * Restore browser state from widget state on refresh/popout.
   * Sets up restoration tracking and tells Host to navigate to the saved URL.
   */
  useEffect(() => {
    // Only attempt restore once
    if (hasAttemptedRestoreRef.current) return;
    
    const saved = widgetState as BrowserWidgetState | null;
    const savedUrl = saved?.privateContent?.browserState?.url;
    
    // Only restore if we have a meaningful URL (not empty or about:blank)
    if (savedUrl && savedUrl !== "about:blank" && savedUrl !== "") {
      hasAttemptedRestoreRef.current = true;
      const restored = saved.privateContent.browserState!;
      
      // Set restoration flag to prevent saving until we reach the target
      restoringRef.current = { targetUrl: savedUrl };
      
      // Update local state with restored values
      setBrowserState(restored);
      browserStateRef.current = restored;
      
      // Tell Host to navigate to the restored URL
      window.parent.postMessage(
        {
          jsonrpc: "2.0",
          method: "browser/navigate",
          params: { instanceId: restored.instanceId, url: savedUrl },
        },
        "*"
      );
    }
  }, [widgetState]);

  // ---------------------------------------------------------------------------
  // Browser State Updates from Host
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (data.method === "browser/state-changed" && data.params) {
        const state = data.params as BrowserState;
        setBrowserState(state);
        browserStateRef.current = state;
        setIsConnected(true);
        saveWidgetState();
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [saveWidgetState]);

  // ---------------------------------------------------------------------------
  // Navigation Commands
  // ---------------------------------------------------------------------------

  /**
   * Send a browser command to the Host.
   */
  const sendBrowserCommand = useCallback(
    (command: string, params: Record<string, unknown> = {}) => {
      window.parent.postMessage(
        {
          jsonrpc: "2.0",
          method: `browser/${command}`,
          params: { instanceId: browserState?.instanceId, ...params },
        },
        "*"
      );
    },
    [browserState?.instanceId]
  );

  const handleNavigate = useCallback(
    (url: string) => sendBrowserCommand("navigate", { url }),
    [sendBrowserCommand]
  );

  const handleReload = useCallback(
    () => sendBrowserCommand("reload"),
    [sendBrowserCommand]
  );

  const handleBack = useCallback(
    () => sendBrowserCommand("back"),
    [sendBrowserCommand]
  );

  const handleForward = useCallback(
    () => sendBrowserCommand("forward"),
    [sendBrowserCommand]
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!isReady) {
    return (
      <div className="flex items-center justify-center h-10 w-full bg-bg-primary">
        <Text size="sm" variant="secondary">Connecting...</Text>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full">
      <NavigationBar
        currentUrl={browserState?.url === "about:blank" ? "" : (browserState?.url || "")}
        isLoading={browserState?.isLoading || false}
        onNavigate={handleNavigate}
        onReload={handleReload}
        onBack={handleBack}
        onForward={handleForward}
      />
      {!isConnected && (
        <div className="py-2 text-center bg-bg-primary">
          <Text size="sm" variant="secondary">Waiting for browser...</Text>
        </div>
      )}
    </div>
  );
};

export default App;
