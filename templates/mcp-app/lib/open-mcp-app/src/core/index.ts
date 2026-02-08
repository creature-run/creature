/**
 * Core Host Client Module
 *
 * Provides the unified host client factory and all related types.
 * This is the main entry point for client-side SDK usage.
 */

import { ChatGptWebHostClient } from "./clients/ChatGptWebHostClient.js";
import { CreatureDesktopHostClient } from "./clients/CreatureDesktopHostClient.js";
import { ClaudeDesktopHostClient } from "./clients/ClaudeDesktopHostClient.js";
import { StandaloneHostClient } from "./clients/StandaloneHostClient.js";
import type { UnifiedHostClient, Environment, HostClientConfig } from "./types.js";

// ============================================================================
// Environment Detection
// ============================================================================

/**
 * Detect the current host environment.
 *
 * Used to auto-select the appropriate host client implementation:
 * - "chatgpt": Running inside ChatGPT's widget system
 * - "mcp-apps": Running inside an MCP Apps host (iframe with parent)
 * - "standalone": Running outside any host environment
 *
 * @returns The detected environment
 */
export const detectEnvironment = (): Environment => {
  if (typeof window === "undefined") {
    return "standalone";
  }

  if ("openai" in window && (window as { openai?: unknown }).openai) {
    return "chatgpt";
  }

  if (window.parent !== window) {
    return "mcp-apps";
  }

  return "standalone";
};

/**
 * Check if running in an MCP Apps environment (iframe with parent, no window.openai).
 */
const isMcpAppsEnvironment = (): boolean => {
  if (typeof window === "undefined") return false;
  return window.parent !== window && !("openai" in window && (window as { openai?: unknown }).openai);
};

// ============================================================================
// Host Client Factory
// ============================================================================

/**
 * Create a host client for the detected environment.
 *
 * Automatically selects the appropriate client based on runtime detection:
 * - ChatGPT Web: Uses ChatGptWebHostClient (detects window.openai)
 * - MCP Apps: Uses CreatureDesktopHostClient (detects iframe with parent)
 * - Standalone: Uses StandaloneHostClient for development/testing
 *
 * Note: For MCP Apps environments, this returns CreatureDesktopHostClient by default.
 * Use createHostAsync() for proper host detection via userAgent after connection.
 *
 * @param config - Configuration for the host client
 * @returns The appropriate host client for the environment
 *
 * @example
 * ```typescript
 * const host = createHost({ name: "my-app", version: "1.0.0" });
 * host.connect();
 *
 * // Call tools
 * const result = await host.callTool("get_todos", {});
 *
 * // Use experimental features (graceful degradation)
 * host.exp.setTitle("My Widget");
 * ```
 */
export const createHost = (config: HostClientConfig): UnifiedHostClient => {
  // 1. ChatGPT Web (most specific - has window.openai)
  if (ChatGptWebHostClient.detect()) {
    return ChatGptWebHostClient.create(config);
  }

  // 2. MCP Apps (iframe-based host) - default to Creature
  if (isMcpAppsEnvironment()) {
    return CreatureDesktopHostClient.create(config);
  }

  // 3. Standalone fallback
  return StandaloneHostClient.create(config);
};

/**
 * Create a host client asynchronously with proper host detection.
 *
 * Unlike createHost(), this function:
 * 1. Connects to the host
 * 2. Detects the specific host type via userAgent
 * 3. Returns the appropriate client (CreatureDesktop, ClaudeDesktop, etc.)
 *
 * For MCP Apps environments, this performs deferred detection by connecting
 * first, then checking the userAgent to select the correct client.
 *
 * @param config - Configuration for the host client
 * @returns Promise that resolves to the configured host client after connection
 *
 * @example
 * ```typescript
 * const host = await createHostAsync({ name: "my-app", version: "1.0.0" });
 * // host is now ready to use with correct host-specific behavior
 * ```
 */
export const createHostAsync = async (config: HostClientConfig): Promise<UnifiedHostClient> => {
  // 1. ChatGPT Web (detected synchronously via window.openai)
  if (ChatGptWebHostClient.detect()) {
    const host = ChatGptWebHostClient.create(config);
    host.connect();
    return host;
  }

  // 2. MCP Apps - requires connection to detect specific host
  if (isMcpAppsEnvironment()) {
    // Connect with Creature client first to get hostContext
    const probeHost = CreatureDesktopHostClient.create(config);

    await new Promise<void>((resolve) => {
      const unsub = probeHost.subscribe((state) => {
        if (state.isReady) {
          unsub();
          resolve();
        }
      });
      probeHost.connect();
    });

    const userAgent = probeHost.getHostContext()?.userAgent?.toLowerCase() ?? "";

    // If connected to Claude Desktop, switch to Claude client
    if (userAgent.startsWith("claude")) {
      probeHost.disconnect();

      const claudeHost = ClaudeDesktopHostClient.create(config);

      await new Promise<void>((resolve) => {
        const unsub = claudeHost.subscribe((state) => {
          if (state.isReady) {
            unsub();
            resolve();
          }
        });
        claudeHost.connect();
      });

      return claudeHost;
    }

    // Already connected to Creature (or unknown MCP Apps host)
    return probeHost;
  }

  // 3. Standalone fallback
  const host = StandaloneHostClient.create(config);
  host.connect();
  return host;
};

// ============================================================================
// Re-exports: Types
// ============================================================================

export type {
  // Environment & Logging
  Environment,
  DisplayMode,
  LogLevel,
  // Widget State
  StructuredWidgetState,
  WidgetState,
  // Tool Results
  ToolResult,
  // Host Context
  HostContext,
  OpenContext,
  // Content Blocks
  ContentBlock,
  TextContentBlock,
  ImageContentBlock,
  // Host Client
  HostClientConfig,
  HostClientState,
  HostClientEvents,
  StateListener,
  UnifiedHostClient,
  ExpHostApi,
  // WebSocket
  WebSocketStatus,
  WebSocketClientConfig,
  WebSocketClient,
} from "./types.js";

// ============================================================================
// Re-exports: Host Clients (for advanced/explicit usage)
// ============================================================================

export {
  CreatureDesktopHostClient,
  ClaudeDesktopHostClient,
  ChatGptWebHostClient,
  StandaloneHostClient,
} from "./clients/index.js";

// ============================================================================
// Re-exports: Utilities from MCP Apps SDK
// ============================================================================

/**
 * Re-export style utilities from the official MCP Apps SDK.
 *
 * These provide spec-compliant theme and style application. Consumers can use
 * these directly or rely on the automatic application by the host clients.
 */
export {
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
  getDocumentTheme,
} from "@modelcontextprotocol/ext-apps";

// ============================================================================
// Re-exports: Styles
// ============================================================================

export { applyStyles } from "./styles.js";

// ============================================================================
// Re-exports: WebSocket
// ============================================================================

export { createWebSocket } from "./websocket.js";
