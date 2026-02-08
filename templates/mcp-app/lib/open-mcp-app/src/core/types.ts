/**
 * Core SDK Types
 *
 * Unified type definitions for the MCP Apps SDK.
 * Provides a single, consistent API across all host environments.
 */

// ============================================================================
// Environment & Logging
// ============================================================================

/**
 * Environment types for host detection.
 * The SDK automatically detects which environment it's running in.
 */
export type Environment = "chatgpt" | "mcp-apps" | "standalone";

/**
 * Display modes for UI resources.
 * - "inline": Embedded within the conversation flow
 * - "pip": Picture-in-picture floating panel
 * - "fullscreen": Full-screen overlay
 */
export type DisplayMode = "inline" | "pip" | "fullscreen";

/**
 * Log severity levels matching MCP protocol LoggingLevel.
 * Logs are displayed in the host's DevConsole with appropriate colors.
 */
export type LogLevel = "debug" | "info" | "notice" | "warning" | "error";

// ============================================================================
// Widget State
// ============================================================================

/**
 * Structured widget state format (ChatGPT-compatible).
 * Allows separating model-visible content from private UI state.
 */
export interface StructuredWidgetState {
  /** Content visible to the AI model on follow-up turns */
  modelContent?: string | Record<string, unknown> | null;
  /** UI-only state, hidden from model */
  privateContent?: Record<string, unknown> | null;
  /** File IDs for images the model can see */
  imageIds?: string[];
}

/**
 * Widget state can be structured (with modelContent/privateContent)
 * or a simple key-value object.
 */
export type WidgetState = StructuredWidgetState | Record<string, unknown>;

// ============================================================================
// Tool Results
// ============================================================================

/**
 * Tool call result structure.
 */
export interface ToolResult<T = Record<string, unknown>> {
  content?: Array<{ type: string; text: string }>;
  structuredContent?: T;
  isError?: boolean;
  source?: "agent" | "ui";
  /** Tool name that produced this result (for view routing) */
  toolName?: string;
}

// ============================================================================
// Host Context
// ============================================================================

/**
 * Context about how the view was opened.
 * SDK uses this to determine initialization behavior.
 */
export interface OpenContext {
  /**
   * How the view was opened:
   * - "tool": Opened by an agent tool call (expect tool-input/tool-result)
   * - "user": Opened directly by user (no tool notifications coming)
   * - "restore": Restoring previous state (popout, pop-back-in, refresh).
   *              Uses widgetState.modelContent.view for initial view.
   */
  triggeredBy: "tool" | "user" | "restore";
}

/**
 * Host context sent from MCP Apps host.
 * Follows MCP Apps spec with extensions via [key: string]: unknown.
 */
export interface HostContext {
  theme?: "light" | "dark";
  styles?: {
    variables?: Record<string, string>;
    css?: { fonts?: string };
  };
  displayMode?: DisplayMode;
  availableDisplayModes?: DisplayMode[];
  viewport?: { width: number; height: number };
  platform?: string;
  /**
   * Host application identifier per MCP Apps spec.
   * Format: "<host>/<version>" (e.g. "creature/1.0.0", "chatgpt/2.0.0").
   */
  userAgent?: string;
  /**
   * Widget state restored from previous widget instance.
   */
  widgetState?: WidgetState;
  /**
   * Context about how the view was opened.
   * Per MCP Apps spec extensibility, sent in hostContext.
   */
  openContext?: OpenContext;
  /**
   * Experimental (non-standard) extensions.
   * Follows the SDK's `experimental` namespace paradigm.
   */
  experimental?: {
    /**
     * Additional CSS variables beyond the MCP Apps spec.
     * Apps should apply these alongside spec styles for enhanced theming.
     */
    styles?: {
      variables?: Record<string, string | undefined>;
    };
  };
  /**
   * Allow additional host-specific properties.
   */
  [key: string]: unknown;
}

// ============================================================================
// Content Blocks
// ============================================================================

/**
 * Content block types for model context updates.
 */
export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ImageContentBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

// ============================================================================
// Host Client Configuration
// ============================================================================

/**
 * Configuration for creating a host client.
 */
export interface HostClientConfig {
  /** Name of the client (for protocol handshake) */
  name: string;
  /** Version of the client */
  version: string;
}

/**
 * State managed by the host client.
 */
export interface HostClientState {
  /** Whether the host connection is ready */
  isReady: boolean;
  /** The detected environment */
  environment: Environment;
  /** Current widget state */
  widgetState: WidgetState | null;
}

/**
 * Listener for state changes.
 */
export type StateListener = (state: HostClientState, prevState: HostClientState) => void;

// ============================================================================
// Events
// ============================================================================

/**
 * All events supported by the unified host client.
 * Events that aren't supported by a host are no-op subscriptions.
 */
export interface HostClientEvents {
  /** Called when tool input is received (before execution) */
  "tool-input": (args: Record<string, unknown>) => void;
  /** Called when tool result is received */
  "tool-result": (result: ToolResult) => void;
  /** Called when widget state changes (restored or updated) */
  "widget-state-change": (widgetState: WidgetState | null) => void;
  /** Called when theme changes (MCP Apps only, no-op on ChatGPT) */
  "theme-change": (theme: "light" | "dark") => void;
  /** Called when host requests teardown (MCP Apps only, no-op on ChatGPT) */
  "teardown": () => Promise<void> | void;
}

// ============================================================================
// Experimental Host API
// ============================================================================

/**
 * Experimental host APIs that are not part of the MCP Apps spec.
 *
 * These APIs provide access to host-specific features that may not be
 * supported by all hosts. Methods gracefully degrade (no-op or return null)
 * when called on unsupported hosts.
 */
export interface ExpHostApi {
  /**
   * Set widget state and notify the host.
   *
   * Widget state is synchronized with the host for persistence across
   * sessions and visibility to the AI model.
   *
   * - ChatGPT: Native support via `window.openai.setWidgetState`
   * - Creature: Extension via `ui/notifications/widget-state-changed`
   * - Generic MCP Apps hosts: May not support (state stored locally)
   * - Standalone: Stores locally
   */
  setWidgetState(state: WidgetState | null): void;

  /**
   * Set the pip/widget title displayed in the host UI.
   *
   * Creature only - no-op on ChatGPT and generic MCP Apps hosts.
   */
  setTitle(title: string): void;

  /**
   * Send a raw notification to the host.
   *
   * Low-level API for power users. Most apps should use higher-level methods.
   * MCP Apps only - no-op on ChatGPT.
   */
  sendNotification(method: string, params: unknown): void;

  /**
   * Get the instance ID for this widget.
   *
   * Multi-instance support is a Creature extension.
   * - Creature: Full support for multiple instances with independent state
   * - ChatGPT: May return session ID, singleton behavior
   * - Generic MCP Apps hosts: Returns null
   */
  getInstanceId(): string | null;

  /**
   * Check if the host supports multi-instance resources.
   *
   * - Creature: true
   * - ChatGPT: false (singleton only)
   * - Generic MCP Apps hosts: false
   */
  supportsMultiInstance(): boolean;

  /**
   * Get the initial tool result if view was opened by an agent tool call.
   *
   * Returns the first tool result received, or null if:
   * - View was opened directly by user (no tool call)
   * - Tool result hasn't arrived yet (shouldn't happen after isReady=true)
   *
   * This enables clean initialization:
   * ```typescript
   * const { isReady, getInitialToolResult } = useHost();
   * useEffect(() => {
   *   if (!isReady) return;
   *   const initial = getInitialToolResult();
   *   if (initial) {
   *     // View opened by agent - use the tool result data
   *     processData(initial.structuredContent);
   *   } else {
   *     // View opened by user - fetch initial data
   *     fetchData();
   *   }
   * }, [isReady]);
   * ```
   */
  getInitialToolResult(): ToolResult | null;

  // ============================================================================
  // ChatGPT-specific APIs (no-op on MCP Apps hosts)
  // ============================================================================

  /**
   * Send a follow-up message to the conversation.
   *
   * ChatGPT only. Triggers a new model turn with the given prompt.
   * No-op on MCP Apps hosts.
   */
  sendFollowUpMessage(prompt: string): Promise<void>;

  /**
   * Open a modal dialog from the host.
   *
   * ChatGPT only. Returns null on MCP Apps hosts.
   */
  requestModal(options: { title?: string; params?: Record<string, unknown> }): Promise<unknown | null>;

  /**
   * Request the host to close this widget.
   *
   * ChatGPT only. No-op on MCP Apps hosts.
   */
  requestClose(): Promise<void>;
}

// ============================================================================
// Unified Host Client Interface
// ============================================================================

/**
 * Unified host client interface.
 *
 * This is the primary interface returned by `createHost()`.
 * Provides a consistent API across all host environments (ChatGPT, MCP Apps, Standalone).
 */
export interface UnifiedHostClient {
  /**
   * The detected environment.
   */
  readonly environment: Environment;

  /**
   * Get current client state.
   */
  getState(): HostClientState;

  /**
   * Subscribe to state changes. Returns unsubscribe function.
   */
  subscribe(listener: StateListener): () => void;

  /**
   * Get the host context received from the host.
   * Contains theme, styles, userAgent, and host-specific properties.
   * Returns null before connection is established or on ChatGPT.
   */
  getHostContext(): HostContext | null;

  /**
   * Call a tool on the MCP server.
   */
  callTool<T = Record<string, unknown>>(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolResult<T>>;

  /**
   * Request a display mode change from the host.
   */
  requestDisplayMode(params: { mode: DisplayMode }): Promise<{ mode: DisplayMode }>;

  /**
   * Send a log message to host DevConsole.
   * Falls back to browser console on ChatGPT.
   */
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void;

  /**
   * Update the model context for future turns.
   *
   * In MCP Apps spec as `ui/update-model-context`. Context is available
   * to the model in future turns without triggering immediate response.
   * Each call overwrites previous context.
   *
   * Use this for ephemeral notifications that don't need persistence.
   * For persistent context, use widgetState.modelContent instead.
   *
   * - MCP Apps hosts: Sends `ui/update-model-context` notification
   * - ChatGPT: Maps to setWidgetState per MCP Apps compatibility
   */
  updateModelContext(content: ContentBlock[]): Promise<void>;

  /**
   * Register an event handler. Returns unsubscribe function.
   */
  on<K extends keyof HostClientEvents>(event: K, handler: HostClientEvents[K]): () => void;

  /**
   * Start listening for host messages.
   */
  connect(): void;

  /**
   * Stop listening for host messages.
   */
  disconnect(): void;

  /**
   * Experimental APIs for non-standard features.
   *
   * These APIs provide access to host-specific features that may not be
   * supported by all hosts. Methods gracefully degrade when unsupported.
   */
  readonly exp: ExpHostApi;
}

// ============================================================================
// WebSocket Types
// ============================================================================

/**
 * WebSocket connection status.
 */
export type WebSocketStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * Configuration for creating a WebSocket client.
 */
export interface WebSocketClientConfig<TReceive = unknown> {
  /** Called when a message is received */
  onMessage?: (message: TReceive) => void;
  /** Called when connection status changes */
  onStatusChange?: (status: WebSocketStatus, error?: string) => void;
  /** Whether to auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;
  /** Base interval for reconnection attempts in ms (default: 1000) */
  reconnectInterval?: number;
}

/**
 * WebSocket client interface.
 */
export interface WebSocketClient<TSend = unknown, TReceive = unknown> {
  /** Current connection status */
  readonly status: WebSocketStatus;
  /** Error message if status is "error" */
  readonly error: string | undefined;
  /** Connect to the WebSocket server */
  connect(): void;
  /** Disconnect from the WebSocket server */
  disconnect(): void;
  /** Send a message to the server */
  send(message: TSend): void;
}
