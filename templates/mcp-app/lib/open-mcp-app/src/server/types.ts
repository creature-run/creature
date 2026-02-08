import type { z } from "zod";

// ============================================================================
// Constants
// ============================================================================

/**
 * MIME types for cross-platform compatibility.
 */
export const MIME_TYPES = {
  MCP_APPS: "text/html;profile=mcp-app",
  CHATGPT: "text/html+skybridge",
} as const;

// ============================================================================
// Display & Visibility
// ============================================================================

/**
 * Display modes for UI resources.
 */
export type DisplayMode = "pip" | "inline" | "fullscreen";

/**
 * Visibility options for tools.
 * - "model": AI/Agent can call the tool
 * - "app": UI can call the tool
 */
export type ToolVisibility = "model" | "app";

// ============================================================================
// Resources
// ============================================================================

/**
 * Icon configuration for UI resources.
 */
export interface IconConfig {
  /** SVG string (must use currentColor for theming) */
  svg: string;
  /** Alt text for accessibility */
  alt: string;
}

// ============================================================================
// Views (URL-based Routing)
// ============================================================================

/**
 * View routing configuration.
 *
 * Maps URL-like path patterns to arrays of tool names. The path pattern
 * determines instance routing behavior automatically:
 *
 * - `/` - Root path, single instance
 * - `/editor` - Creates new instance, becomes `/editor/:noteId` after response
 * - `/editor/:noteId` - One instance per unique `noteId` value
 *
 * @example
 * ```typescript
 * views: {
 *   "/": ["notes_list"],
 *   "/editor": ["notes_create"],
 *   "/editor/:noteId": ["notes_open", "notes_save", "notes_delete"]
 * }
 * ```
 *
 * Routing behavior:
 * - Params in tool input resolve path before routing (e.g., `notes_open({noteId: "abc"})` → `/editor/abc`)
 * - Params only in output create new instance, identity assigned from response
 * - Each unique resolved path gets its own instance on multi-instance hosts
 * - Single-instance hosts (ChatGPT, etc.) manage view state internally
 */
export type Views = Record<string, string[]>;

// ============================================================================
// Resource Experimental Config
// ============================================================================

/**
 * Experimental resource options.
 *
 * These are non-standard extensions that may not be supported by all hosts.
 * Per MCP Apps spec, experimental features are namespaced under `experimental`.
 */
export interface ResourceExperimentalConfig {
  /**
   * Enable WebSocket for real-time communication with the UI.
   * When true, SDK automatically manages WebSocket lifecycle and provides
   * `context.send()` and `context.onMessage()` in tool handlers.
   *
   * Note: WebSocket is only supported on Creature. Not part of MCP Apps spec.
   */
  websocket?: boolean;
}

/**
 * Resource configuration.
 */
export interface ResourceConfig {
  /** Display name shown in UI */
  name: string;
  /** Resource URI (must start with ui://) */
  uri: string;
  /** Optional description */
  description?: string;
  /** Supported display modes */
  displayModes: DisplayMode[];
  /**
   * HTML content for the resource.
   *
   * Accepts three formats:
   * 1. **File path** (local development): `"ui/main.html"` - loaded from filesystem
   * 2. **Raw HTML** (serverless-safe): `"<!DOCTYPE html>..."` - used directly
   * 3. **Function** (lazy loading): `() => htmlContent` - called when needed
   *
   * The SDK auto-detects HTML content (starts with `<`) vs file paths.
   * For serverless (Vercel, Lambda), use raw HTML or a function.
   *
   * @example
   * // Local development - file path
   * html: "ui/main.html"
   *
   * @example
   * // Serverless - bundled HTML (import at build time)
   * import { BUNDLED_HTML } from "./ui-bundle.js";
   * html: BUNDLED_HTML
   *
   * @example
   * // Serverless - function (lazy)
   * html: () => fs.readFileSync("./dist/ui/main.html", "utf-8")
   */
  html: string | (() => string | Promise<string>);
  /** Optional icon for pips */
  icon?: IconConfig;
  /** CSP configuration for external API access */
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
  };
  /**
   * View routing configuration.
   *
   * Maps URL-like path patterns to arrays of tool names. Determines how
   * tool calls are routed to instances and how the UI switches views.
   *
   * @example
   * ```typescript
   * views: {
   *   "/": ["notes_list"],
   *   "/editor": ["notes_create"],
   *   "/editor/:noteId": ["notes_open", "notes_save", "notes_delete"]
   * }
   * ```
   *
   * Path patterns:
   * - `/` - Root view, single instance
   * - `/path` - Static path, creates new instance
   * - `/path/:param` - One instance per unique param value
   *
   * On multi-instance hosts (Creature), each unique resolved path gets its own instance.
   * On single-instance hosts (ChatGPT, etc.), the SDK manages view state internally.
   */
  views?: Views;
  /**
   * Instance mode for pip routing.
   *
   * - `"single"` (default): One pip per resource. Reuses existing pip if found.
   * - `"multiple"`: View-based routing. Uses `views` config to determine instances.
   *
   * Most apps should use the default ("single"). Use "multiple" for apps that
   * need separate instances per view (e.g., a notes app with list + multiple editors).
   */
  instanceMode?: "single" | "multiple";
  /**
   * Experimental (non-standard) resource options.
   *
   * These features are host-specific extensions that may not be supported everywhere.
   * Per MCP Apps spec, they are namespaced under `experimental`.
   */
  experimental?: ResourceExperimentalConfig;
}

/**
 * Internal resource definition.
 */
export interface ResourceDefinition {
  config: ResourceConfig;
}

// ============================================================================
// Tools
// ============================================================================

/**
 * Experimental tool options.
 * 
 * These are non-standard extensions that may not be supported by all hosts.
 * Per MCP Apps spec, experimental features are namespaced under `experimental`.
 */
export interface ToolExperimentalConfig {
  /**
   * Preferred display mode when the agent doesn't specify one.
   * 
   * Note: defaultDisplayMode is a Creature extension. Not part of MCP Apps spec.
   */
  defaultDisplayMode?: DisplayMode;
  /**
   * Whether a new pip should open in background when another pip is already active.
   * Note: openInBackground is a Creature extension.
   */
  openInBackground?: boolean;
}

/**
 * Tool configuration.
 */
export interface ToolConfig<TInput extends z.ZodType = z.ZodType> {
  /** Tool description (shown to AI) */
  description: string;
  /** Zod schema for input validation */
  input?: TInput;
  /** Resource URI to link this tool to a UI */
  ui?: string;
  /** Who can call this tool */
  visibility?: ToolVisibility[];
  /** Supported display modes for this tool */
  displayModes?: DisplayMode[];
  /** Loading message shown while tool is running (used by ChatGPT) */
  loadingMessage?: string;
  /** Completion message shown when tool finishes (used by ChatGPT) */
  completedMessage?: string;
  /**
   * Experimental (non-standard) tool options.
   * 
   * These features are host-specific extensions that may not be supported everywhere.
   * Per MCP Apps spec, they are namespaced under `experimental`.
   */
  experimental?: ToolExperimentalConfig;
}

/**
 * Tool result returned from handler.
 */
export interface ToolResult {
  /** Structured data for UI rendering */
  data?: Record<string, unknown>;
  /** Text content for AI context */
  text?: string;
  /** Title for panel/widget */
  title?: string;
  /** Height hint for inline widgets (60-300px) */
  inlineHeight?: number;
  /** Whether this is an error result */
  isError?: boolean;
}

/**
 * Tool handler function type.
 */
export type ToolHandler<TInput> = (
  input: TInput,
  context: ToolContext
) => ToolResult | Promise<ToolResult>;

/**
 * Context passed to tool handlers.
 * Provides access to instanceId, state management, and WebSocket communication.
 */
export interface ToolContext {
  /** 
   * The instance ID for this tool call.
   * Generated before handler runs. Use for server-side state keying.
   * Automatically attached to tool result for UI routing.
   */
  instanceId: string;
  /**
   * Get server-side state for this instance.
   * State is NOT sent to UI — use for PIDs, connections, handles.
   */
  getState: <T>() => T | undefined;
  /**
   * Set server-side state for this instance.
   * State is NOT sent to UI — use for PIDs, connections, handles.
   */
  setState: <T>(state: T) => void;
  /**
   * Send a message to the UI via WebSocket.
   * Only available if the resource has `websocket: true`.
   * For singleton resources, sends to the single shared WebSocket.
   * For multi-instance resources, sends to this instance's WebSocket.
   */
  send: <T>(message: T) => void;
  /**
   * Register a handler for messages from the UI.
   * Only available if the resource has `websocket: true`.
   */
  onMessage: <T>(handler: (message: T) => void) => void;
  /**
   * Register a handler called when a UI client connects to the WebSocket.
   * Useful for sending buffered data when a client connects.
   * Only available if the resource has `websocket: true`.
   */
  onConnect: (handler: () => void) => void;
  /**
   * WebSocket URL for the UI to connect to.
   * Only available if the resource has `websocket: true`.
   * Automatically included in tool result's structuredContent.
   */
  websocketUrl: string | undefined;
}

/**
 * Internal tool definition with handler.
 */
export interface ToolDefinition<TInput = unknown> {
  config: ToolConfig;
  handler: ToolHandler<TInput>;
}

// ============================================================================
// Instance Lifecycle
// ============================================================================

/**
 * Context passed to onInstanceDestroy callback.
 */
export interface InstanceDestroyContext {
  /** The instanceId being destroyed */
  instanceId: string;
  /** Last server-side state for this instance (from setState calls) */
  state: unknown;
}

// ============================================================================
// Transport Sessions
// ============================================================================

/**
 * Supported MCP transport types.
 * Currently only StreamableHTTP is supported by the SDK server.
 * Stdio may be added in the future.
 */
export type TransportType = "streamable-http" | "stdio";

/**
 * Information about a transport session.
 * Provides details about an active MCP protocol connection.
 */
export interface TransportSessionInfo {
  /** Unique session identifier */
  id: string;
  /** The transport type for this session */
  transport: TransportType;
}

// ============================================================================
// App Configuration
// ============================================================================

/**
 * App configuration.
 */
export interface AppConfig {
  /** App name (used in protocol handshake) */
  name: string;
  /** App version */
  version: string;
  /**
   * High-level instructions for using this MCP.
   * Sent to the model during initialization to provide context about
   * how to use the MCP's tools effectively.
   *
   * @example
   * instructions: `This MCP manages markdown notes.
   * When editing an existing note, ALWAYS use action:"read" first to get current content,
   * then apply your changes with action:"save" to avoid overwriting user edits.`
   */
  instructions?: string;
  /** Port for HTTP transport (default: 3000 or MCP_PORT env) */
  port?: number;
  /** Enable dev mode (default: auto-detect from NODE_ENV) */
  dev?: boolean;

  // Transport Session Lifecycle Callbacks

  /**
   * Called when a new transport session is created.
   * Transport sessions are MCP protocol connections (not instances).
   */
  onTransportSessionCreated?: (info: TransportSessionInfo) => void;

  /**
   * Called when a transport session is closed.
   * Clients should re-initialize to continue.
   */
  onTransportSessionClosed?: (info: TransportSessionInfo) => void;

  /**
   * Called when a transport session error occurs.
   * Useful for logging and monitoring connection health.
   */
  onTransportSessionError?: (info: TransportSessionInfo, error: Error) => void;

  /**
   * Called when a tool handler throws an error.
   * The error is still returned to the client as an MCP error.
   */
  onToolError?: (toolName: string, error: Error, args: unknown) => void;

  /**
   * Called during graceful shutdown, before closing connections.
   * Use this to clean up resources (e.g., close database connections).
   */
  onShutdown?: () => Promise<void> | void;

  // Timeouts

  /**
   * Timeout for graceful shutdown in milliseconds (default: 5000).
   * After this timeout, remaining connections are force-closed.
   */
  gracefulShutdownTimeout?: number;

  /**
   * HTTP keep-alive timeout during shutdown in milliseconds (default: 5000).
   * Controls how long to wait for in-flight requests to complete.
   */
  keepAliveTimeout?: number;
}

// ============================================================================
// WebSocket
// ============================================================================

/**
 * WebSocket connection for an instance.
 *
 * Provides real-time bidirectional communication between the server
 * and all UI clients connected to a particular instance.
 */
export interface WebSocketConnection<TServer = unknown, TClient = unknown> {
  /** The instance ID this WebSocket belongs to */
  instanceId: string;
  /** WebSocket URL for clients to connect */
  websocketUrl: string;
  /** Send a message to all connected clients */
  send: (message: TServer) => void;
  /** Register a handler for incoming client messages */
  onMessage: (handler: (message: TClient) => void) => void;
  /** Register a handler called when a new client connects */
  onConnect: (handler: () => void) => void;
  /** Close the WebSocket and disconnect all clients */
  close: () => void;
  /** Number of connected clients */
  readonly clientCount: number;
}
