/**
 * Claude Desktop Host Client
 *
 * Host client for the Claude Desktop environment.
 * Handles iframe postMessage communication with the Claude Desktop host application.
 */

import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";
import { Subscribable } from "../subscribable.js";
import type {
  ContentBlock,
  DisplayMode,
  ExpHostApi,
  HostClientConfig,
  HostClientEvents,
  HostClientState,
  HostContext,
  LogLevel,
  StateListener,
  ToolResult,
  UnifiedHostClient,
  WidgetState,
} from "../types.js";

/**
 * Claude Desktop host client implementation.
 *
 * Provides MCP Apps support for Claude Desktop:
 * - Single-instance only (no multi-instance support)
 * - No dynamic title changes
 * - Inline display mode only
 *
 * Event Buffering:
 * Tool-input and tool-result events may arrive before React components
 * have subscribed (due to useEffect timing). We buffer these events and
 * replay them when the first subscriber is added, ensuring no data is lost.
 */
export class ClaudeDesktopHostClient extends Subscribable implements UnifiedHostClient {
  readonly environment = "mcp-apps" as const;

  private state: HostClientState = {
    isReady: false,
    environment: "mcp-apps",
    widgetState: null,
  };
  private config: HostClientConfig;
  private app: App | null = null;
  private connected = false;
  private hostContext: HostContext | null = null;

  /**
   * Whether this view was triggered by a tool call.
   * Determined from openContext.triggeredBy in hostContext.
   */
  private triggeredByTool = true;

  /**
   * Whether we've received the initial tool-result notification.
   * Used to gate isReady when triggeredByTool is true.
   */
  private hasReceivedToolResult = false;

  /**
   * The initial tool result received when view was opened by agent.
   * Stored for getInitialToolResult() access.
   */
  private initialToolResult: ToolResult | null = null;

  /**
   * Buffered events for replay when subscribers are added.
   *
   * Events may arrive before React's useEffect sets up subscriptions.
   * We buffer them here and replay when the first subscriber is added.
   */
  private bufferedToolInput: Record<string, unknown> | null = null;
  private bufferedToolResult: ToolResult | null = null;

  constructor(config: HostClientConfig) {
    super();
    this.config = config;
  }

  // ============================================================================
  // Static Factory
  // ============================================================================

  /**
   * Create a Claude Desktop host client instance.
   */
  static create(config: HostClientConfig): ClaudeDesktopHostClient {
    return new ClaudeDesktopHostClient(config);
  }

  // ============================================================================
  // UnifiedHostClient Implementation
  // ============================================================================

  getState(): HostClientState {
    return this.state;
  }

  getHostContext(): HostContext | null {
    return this.hostContext;
  }

  subscribe(listener: StateListener): () => void {
    return this.subscribeToState(listener);
  }

  /**
   * Connect to the Claude Desktop host.
   *
   * Creates the App instance, registers notification handlers, and initiates
   * the protocol handshake. The host responds with hostContext including
   * theme, styles, and widgetState.
   */
  connect(): void {
    if (this.connected) return;
    this.connected = true;

    this.app = new App(
      { name: this.config.name, version: this.config.version },
      {},
      { autoResize: true }
    );

    this.setupHandlers();
    this.initiateConnection();
  }

  /**
   * Disconnect from the host.
   */
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;

    if (this.app) {
      this.app.close();
      this.app = null;
    }

    // Clear buffered events and state
    this.bufferedToolInput = null;
    this.bufferedToolResult = null;
    this.hasReceivedToolResult = false;
    this.initialToolResult = null;
    this.triggeredByTool = true;

    this.setState({ isReady: false });
  }

  /**
   * Call a tool on the MCP server via the host.
   */
  async callTool<T = Record<string, unknown>>(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolResult<T>> {
    if (!this.app) {
      throw new Error("Not connected");
    }

    const sdkResult = await this.app.callServerTool({
      name: toolName,
      arguments: args,
    });

    const result: ToolResult<T> = {
      content: this.extractTextContent(sdkResult.content),
      structuredContent: sdkResult.structuredContent as T,
      isError: sdkResult.isError,
      source: "ui",
    };

    this.emit("tool-result", result as ToolResult);
    return result;
  }

  /**
   * Request a display mode change from the host.
   * Claude Desktop only supports inline mode.
   */
  async requestDisplayMode(params: { mode: DisplayMode }): Promise<{ mode: DisplayMode }> {
    if (!this.app) {
      return { mode: params.mode };
    }

    const result = await this.app.requestDisplayMode({ mode: params.mode });
    return { mode: result.mode as DisplayMode };
  }

  /**
   * Send a log message to the host's DevConsole.
   */
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!this.app) {
      const consoleMethod = level === "error" ? "error" : level === "warning" ? "warn" : "log";
      console[consoleMethod](`[${this.config.name}]`, message, data ?? "");
      return;
    }

    this.app.sendLog({
      level,
      logger: this.config.name,
      data: data ? { message, ...data } : message,
    });
  }

  /**
   * Update the model context for future turns.
   *
   * Sends `ui/update-model-context` notification per MCP Apps spec.
   * Context is available to the model in future turns without
   * triggering immediate response.
   */
  async updateModelContext(content: ContentBlock[]): Promise<void> {
    if (!this.app) return;
    // Type assertion needed for MCP Apps SDK
    this.app.notification({
      method: "ui/update-model-context",
      params: { content },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  on<K extends keyof HostClientEvents>(
    event: K,
    handler: HostClientEvents[K]
  ): () => void {
    if (event === "theme-change" || event === "teardown") {
      return this.onMcpEvent(
        event as "theme-change" | "teardown",
        handler as (theme: "light" | "dark") => void | (() => Promise<void> | void)
      );
    }

    // Register the handler
    const unsubscribe = this.onEvent(
      event as "tool-input" | "tool-result" | "widget-state-change",
      handler as HostClientEvents["tool-input" | "tool-result" | "widget-state-change"]
    );

    // Replay buffered events to the new subscriber.
    // Events may have arrived before React's useEffect set up subscriptions.
    if (event === "tool-input" && this.bufferedToolInput) {
      const buffered = this.bufferedToolInput;
      this.bufferedToolInput = null;
      (handler as HostClientEvents["tool-input"])(buffered);
    } else if (event === "tool-result" && this.bufferedToolResult) {
      const buffered = this.bufferedToolResult;
      this.bufferedToolResult = null;
      (handler as HostClientEvents["tool-result"])(buffered);
    }

    return unsubscribe;
  }

  // ============================================================================
  // Experimental API
  // ============================================================================

  /**
   * Experimental APIs (shared across all hosts).
   * Behavior varies by host - see ExpHostApi for details.
   */
  get exp(): ExpHostApi {
    return {
      setWidgetState: (state: WidgetState | null) => {
        this.setState({ widgetState: state });
        this.emit("widget-state-change", state);
        this.sendNotification("ui/notifications/widget-state-changed", {
          widgetState: state,
        });
      },

      // Not supported on Claude Desktop
      setTitle: (_title: string) => {},

      sendNotification: (method: string, params: unknown) => {
        this.sendNotification(method, params);
      },

      getInstanceId: () => {
        // Claude Desktop doesn't support multi-instance
        return null;
      },

      supportsMultiInstance: () => {
        return false;
      },

      getInitialToolResult: () => {
        return this.initialToolResult;
      },

      // ChatGPT-only APIs (no-op on MCP Apps hosts)
      sendFollowUpMessage: async (_prompt: string) => {},

      requestModal: async (_options: { title?: string; params?: Record<string, unknown> }) => {
        return null;
      },

      requestClose: async () => {},
    };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Send a notification to the host.
   */
  private sendNotification(method: string, params: unknown): void {
    if (!this.app) {
      console.warn(`[${this.config.name}] Cannot send notification before connection`);
      return;
    }
    // Type assertion needed for notifications not in the official MCP Apps spec
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.app.notification({ method, params } as any);
  }

  /**
   * Update internal state and notify listeners.
   */
  private setState(partial: Partial<HostClientState>): void {
    const prev = this.state;
    this.state = { ...this.state, ...partial };
    this.notifyStateChange(this.state, prev);
  }

  /**
   * Check if there are any subscribers for an event type.
   */
  private hasSubscribers(event: keyof HostClientEvents): boolean {
    return this.getSubscriberCount(event) > 0;
  }

  /**
   * Set up notification handlers on the App instance.
   *
   * Events are buffered if no subscribers exist yet. When a subscriber
   * is added via on(), buffered events are replayed immediately.
   *
   * For tool-triggered views, isReady is set after tool-result is received.
   * This ensures getInitialToolResult() has data when the app initializes.
   */
  private setupHandlers(): void {
    if (!this.app) return;

    this.app.ontoolinput = (params) => {
      console.debug(`[${this.config.name}] Received tool-input`, { args: params.arguments });

      const args = params.arguments || {};

      if (this.hasSubscribers("tool-input")) {
        this.emit("tool-input", args);
      } else {
        // Buffer for replay when subscriber is added
        this.bufferedToolInput = args;
        console.debug(`[${this.config.name}] Buffered tool-input (no subscribers yet)`);
      }
    };

    this.app.ontoolresult = (params) => {
      const result: ToolResult = {
        content: this.extractTextContent(params.content),
        structuredContent: params.structuredContent as Record<string, unknown>,
        isError: params.isError,
        source: params.source as "agent" | "ui",
        toolName: params.toolName as string | undefined,
      };

      // Store initial tool result and set isReady for tool-triggered views
      if (this.initialToolResult === null && params.source === "agent") {
        this.initialToolResult = result;

        // Set isReady now that we have the tool result
        if (!this.hasReceivedToolResult) {
          this.hasReceivedToolResult = true;
          if (this.triggeredByTool && !this.state.isReady) {
            this.setState({ isReady: true });
          }
        }
      }

      if (this.hasSubscribers("tool-result")) {
        this.emit("tool-result", result);
      } else {
        // Buffer for replay when subscriber is added
        this.bufferedToolResult = result;
        console.debug(`[${this.config.name}] Buffered tool-result (no subscribers yet)`);
      }
    };

    this.app.onhostcontextchanged = (params) => {
      console.debug(`[${this.config.name}] Host context changed`, { theme: params.theme });
      this.applyHostContext(params as HostContext);
    };

    this.app.onteardown = async (_params, _extra) => {
      console.debug(`[${this.config.name}] Teardown requested`);
      await this.emitMcpEvent("teardown");
      return {};
    };
  }

  /**
   * Initiate connection using PostMessageTransport.
   *
   * For user-triggered views: Sets isReady immediately after connection.
   * For tool-triggered views: Waits for tool-result before setting isReady.
   * This ensures getInitialToolResult() has data when the app initializes.
   *
   * Events that arrive before React subscribes are buffered and replayed.
   */
  private async initiateConnection(): Promise<void> {
    if (!this.app) return;

    try {
      const transport = new PostMessageTransport(window.parent, window.parent);
      await this.app.connect(transport);

      const hostContext = this.app.getHostContext() as HostContext | null;
      console.debug(`[${this.config.name}] Connected to host`, { theme: hostContext?.theme });

      if (hostContext) {
        this.hostContext = hostContext;
        this.applyHostContext(hostContext);

        // Determine if view was triggered by tool call.
        // "tool" (or undefined): wait for tool-result before setting isReady
        // "user" or "restore": set isReady immediately
        const triggeredBy = hostContext.openContext?.triggeredBy;
        this.triggeredByTool = triggeredBy !== "user" && triggeredBy !== "restore";

        // Restore widget state if provided by host
        if (hostContext.widgetState) {
          this.setState({ widgetState: hostContext.widgetState });
          this.emit("widget-state-change", hostContext.widgetState);
        }
      }

      // For user-triggered views, set ready immediately.
      // For tool-triggered views, wait for tool-result (handled in setupHandlers).
      if (!this.triggeredByTool) {
        this.setState({ isReady: true });
      }
      // If tool-triggered, isReady will be set when tool-result arrives
    } catch (error) {
      console.error(`[${this.config.name}] Connection failed`, { error });
    }
  }

  /**
   * Apply theme, styles, and fonts from host context.
   */
  private applyHostContext(context: HostContext): void {
    if (context.theme) {
      applyDocumentTheme(context.theme);
      this.emitMcpEvent("theme-change", context.theme);
    }

    // Apply spec-compliant styles
    if (context.styles?.variables) {
      applyHostStyleVariables(context.styles.variables as Parameters<typeof applyHostStyleVariables>[0]);
    }

    if (context.styles?.css?.fonts) {
      applyHostFonts(context.styles.css.fonts);
    }

    // Apply experimental styles (non-standard extensions)
    if (context.experimental?.styles?.variables) {
      this.applyExperimentalStyles(context.experimental.styles.variables);
    }
  }

  /**
   * Apply experimental CSS variables to the document root.
   * These are non-standard extensions that enhance the spec styles.
   */
  private applyExperimentalStyles(styles: Record<string, string | undefined>): void {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(styles)) {
      if (value !== undefined) {
        root.style.setProperty(key, value);
      }
    }
  }

  /**
   * Extract text content from SDK result content array.
   */
  private extractTextContent(
    content?: Array<{ type: string; text?: string }>
  ): Array<{ type: string; text: string }> | undefined {
    return content
      ?.filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => ({ type: item.type, text: item.text }));
  }
}
