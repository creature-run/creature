/**
 * Standalone Host Client
 *
 * A minimal fallback for when running outside any host environment.
 * Useful for development and testing scenarios.
 */

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
 * Standalone host client implementation.
 *
 * A minimal fallback for development and testing scenarios.
 * Host-specific features are no-ops or console-logged.
 */
export class StandaloneHostClient extends Subscribable implements UnifiedHostClient {
  readonly environment = "standalone" as const;

  private state: HostClientState = {
    isReady: false,
    environment: "standalone",
    widgetState: null,
  };
  private config: HostClientConfig;
  private connected = false;

  constructor(config: HostClientConfig) {
    super();
    this.config = config;
  }

  // ============================================================================
  // Static Factory
  // ============================================================================

  /**
   * Create a Standalone host client instance.
   */
  static create(config: HostClientConfig): StandaloneHostClient {
    return new StandaloneHostClient(config);
  }

  /**
   * Check if the current environment is standalone.
   * Returns true when not in ChatGPT or MCP Apps.
   */
  static detect(): boolean {
    if (typeof window === "undefined") return true;
    // Not ChatGPT
    if ("openai" in window && window.openai) {
      return false;
    }
    // Not MCP Apps (iframe)
    if (window.parent !== window) {
      return false;
    }
    return true;
  }

  // ============================================================================
  // UnifiedHostClient Implementation
  // ============================================================================

  getState(): HostClientState {
    return this.state;
  }

  /**
   * Get host context - returns null for standalone mode.
   */
  getHostContext(): HostContext | null {
    return null;
  }

  subscribe(listener: StateListener): () => void {
    return this.subscribeToState(listener);
  }

  /**
   * Connect in standalone mode.
   * Simply marks the client as ready since there's no host to connect to.
   */
  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.setState({ isReady: true });
    console.info(`[${this.config.name}] Running in standalone mode`);
  }

  /**
   * Disconnect in standalone mode.
   */
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.setState({ isReady: false });
  }

  /**
   * Call a tool - not available in standalone mode.
   */
  async callTool<T = Record<string, unknown>>(
    toolName: string,
    _args: Record<string, unknown>
  ): Promise<ToolResult<T>> {
    console.warn(`[${this.config.name}] callTool("${toolName}") not available in standalone mode`);
    return {
      content: [{ type: "text", text: "Tool calls not available in standalone mode" }],
      isError: true,
    };
  }

  /**
   * Request a display mode - returns the requested mode since there's no host.
   */
  async requestDisplayMode(params: { mode: DisplayMode }): Promise<{ mode: DisplayMode }> {
    console.info(`[${this.config.name}] Display mode requested: ${params.mode} (standalone)`);
    return { mode: params.mode };
  }

  /**
   * Log a message to the console.
   */
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const consoleMethod = level === "error" ? "error" : level === "warning" ? "warn" : "log";
    console[consoleMethod](`[${this.config.name}]`, message, data ?? "");
  }

  /**
   * Update model context - logs in standalone mode.
   */
  async updateModelContext(content: ContentBlock[]): Promise<void> {
    console.debug(`[Standalone] updateModelContext(${content.length} blocks)`);
  }

  on<K extends keyof HostClientEvents>(
    event: K,
    handler: HostClientEvents[K]
  ): () => void {
    // theme-change and teardown are no-ops in standalone
    if (event === "theme-change" || event === "teardown") {
      return () => {};
    }
    return this.onEvent(
      event as "tool-input" | "tool-result" | "widget-state-change",
      handler as HostClientEvents["tool-input" | "tool-result" | "widget-state-change"]
    );
  }

  // ============================================================================
  // Experimental API
  // ============================================================================

  /**
   * Experimental APIs for non-standard features.
   * All methods are logged for development/debugging purposes.
   */
  get exp(): ExpHostApi {
    return {
      setWidgetState: (state: WidgetState | null) => {
        this.setState({ widgetState: state });
        this.emit("widget-state-change", state);
      },

      setTitle: (title: string) => {
        console.debug(`[Standalone] exp.setTitle("${title}")`);
      },

      sendNotification: (method: string, params: unknown) => {
        console.debug(`[Standalone] exp.sendNotification("${method}")`, params);
      },

      getInstanceId: () => {
        return null;
      },

      supportsMultiInstance: () => {
        return false;
      },

      getInitialToolResult: () => {
        // No tool results in standalone mode
        return null;
      },

      // ChatGPT-only APIs - no-ops
      sendFollowUpMessage: async (_prompt: string) => {
        // No-op
      },

      requestModal: async (_options: { title?: string; params?: Record<string, unknown> }) => {
        return null;
      },

      requestClose: async () => {
        // No-op
      },
    };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Update internal state and notify listeners.
   */
  private setState(partial: Partial<HostClientState>): void {
    const prev = this.state;
    this.state = { ...this.state, ...partial };
    this.notifyStateChange(this.state, prev);
  }
}
