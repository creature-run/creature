/**
 * ChatGPT Web Host Client
 *
 * Host client for the ChatGPT web environment.
 * Bridges the ChatGPT Apps SDK (`window.openai`) to the unified interface.
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
 * OpenAI bridge interface exposed by ChatGPT Apps SDK.
 * Available on `window.openai` when running inside ChatGPT.
 */
interface OpenAIBridge {
  toolOutput?: Record<string, unknown>;
  widgetState?: WidgetState;
  setWidgetState?: (state: WidgetState) => void;
  callTool?: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
  }>;
  requestDisplayMode?: (args: { mode: string }) => Promise<{ mode: string }>;
  sendFollowUpMessage?: (prompt: string) => Promise<void>;
  requestModal?: (options: { title?: string; params?: Record<string, unknown> }) => Promise<unknown>;
  requestClose?: () => Promise<void>;
}

declare global {
  interface Window {
    openai?: OpenAIBridge;
  }
}

/**
 * ChatGPT Web host client implementation.
 *
 * Bridges the ChatGPT Apps SDK to provide a unified interface.
 * MCP-specific features are no-ops.
 */
export class ChatGptWebHostClient extends Subscribable implements UnifiedHostClient {
  readonly environment = "chatgpt" as const;

  private state: HostClientState = {
    isReady: false,
    environment: "chatgpt",
    widgetState: null,
  };
  private config: HostClientConfig;
  private connected = false;
  private hasProcessedInitialData = false;
  private globalsHandler: ((event: Event) => void) | null = null;
  private lastToolOutputJson: string | null = null;
  private lastWidgetStateJson: string | null = null;

  constructor(config: HostClientConfig) {
    super();
    this.config = config;
  }

  // ============================================================================
  // Static Factory
  // ============================================================================

  /**
   * Create a ChatGPT Web host client instance.
   */
  static create(config: HostClientConfig): ChatGptWebHostClient {
    return new ChatGptWebHostClient(config);
  }

  /**
   * Check if the current environment is ChatGPT.
   */
  static detect(): boolean {
    if (typeof window === "undefined") return false;
    return "openai" in window && !!window.openai;
  }

  // ============================================================================
  // UnifiedHostClient Implementation
  // ============================================================================

  getState(): HostClientState {
    return this.state;
  }

  /**
   * Get host context - returns null for ChatGPT as it doesn't use MCP Apps protocol.
   */
  getHostContext(): HostContext | null {
    return null;
  }

  subscribe(listener: StateListener): () => void {
    return this.subscribeToState(listener);
  }

  /**
   * Connect to the ChatGPT host.
   *
   * Processes initial data from `window.openai` and sets up a listener
   * for subsequent `openai:set_globals` events.
   */
  connect(): void {
    if (this.connected) return;
    this.connected = true;

    this.processInitialData();
    this.setupGlobalsListener();
  }

  /**
   * Disconnect from the host.
   */
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;

    if (this.globalsHandler) {
      window.removeEventListener("openai:set_globals", this.globalsHandler);
      this.globalsHandler = null;
    }
  }

  /**
   * Call a tool on the MCP server via the ChatGPT bridge.
   */
  async callTool<T = Record<string, unknown>>(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolResult<T>> {
    const openai = window.openai;

    if (!openai?.callTool) {
      throw new Error("ChatGPT bridge not available");
    }

    const response = await openai.callTool(toolName, args);

    const result: ToolResult<T> = {
      structuredContent: response?.structuredContent as T,
      content: response?.content?.map((c) => ({
        type: c.type,
        text: c.text || "",
      })),
      source: "ui",
    };

    this.emit("tool-result", result as ToolResult);
    return result;
  }

  /**
   * Request a display mode change from the ChatGPT host.
   */
  async requestDisplayMode(params: { mode: DisplayMode }): Promise<{ mode: DisplayMode }> {
    const openai = window.openai;

    if (openai?.requestDisplayMode) {
      const result = await openai.requestDisplayMode({ mode: params.mode });
      return { mode: result.mode as DisplayMode };
    }

    return { mode: params.mode };
  }

  /**
   * Log a message to the console.
   * ChatGPT doesn't have a DevConsole, so logs go to browser console only.
   */
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const consoleMethod = level === "error" ? "error" : level === "warning" ? "warn" : "log";
    console[consoleMethod](`[${this.config.name}]`, message, data ?? "");
  }

  /**
   * Update model context for future turns.
   *
   * On ChatGPT, this maps to setWidgetState per their MCP Apps compatibility.
   * The content blocks are converted to a string and stored as modelContent.
   */
  async updateModelContext(content: ContentBlock[]): Promise<void> {
    if (!window.openai?.setWidgetState) return;

    // Convert content blocks to string (only text blocks supported)
    const textContent = content
      .filter((block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof (block as { text?: string }).text === "string"
      )
      .map((block) => block.text)
      .join("\n");

    if (!textContent) return;

    // Get existing widget state to preserve privateContent
    const existingState = this.state.widgetState || {};
    const newState: WidgetState = {
      ...existingState,
      modelContent: textContent,
    };

    // Update local state and notify ChatGPT
    this.setState({ widgetState: newState });
    window.openai.setWidgetState(newState);
    this.emit("widget-state-change", newState);
  }

  on<K extends keyof HostClientEvents>(
    event: K,
    handler: HostClientEvents[K]
  ): () => void {
    // theme-change and teardown are no-ops on ChatGPT
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
   * Experimental APIs (shared across all hosts).
   * Behavior varies by host - see ExpHostApi for details.
   */
  get exp(): ExpHostApi {
    return {
      setWidgetState: (state: WidgetState | null) => {
        this.setState({ widgetState: state });

        if (window.openai?.setWidgetState) {
          // Pass empty object when clearing state (ChatGPT may not support null)
          window.openai.setWidgetState(state ?? {});
        }

        this.emit("widget-state-change", state);
      },

      // MCP Apps-only (no-op on ChatGPT)
      setTitle: (_title: string) => {},

      // MCP Apps-only (no-op on ChatGPT)
      sendNotification: (_method: string, _params: unknown) => {},

      getInstanceId: () => {
        // ChatGPT may have widgetSessionId, but we don't expose it
        return null;
      },

      supportsMultiInstance: () => {
        return false;
      },

      getInitialToolResult: () => {
        // ChatGPT uses toolOutput which is already processed on connect
        return null;
      },

      // ChatGPT-specific APIs
      sendFollowUpMessage: async (prompt: string) => {
        if (window.openai?.sendFollowUpMessage) {
          await window.openai.sendFollowUpMessage(prompt);
        }
      },

      requestModal: async (options: { title?: string; params?: Record<string, unknown> }) => {
        if (window.openai?.requestModal) {
          return await window.openai.requestModal(options);
        }
        return null;
      },

      requestClose: async () => {
        if (window.openai?.requestClose) {
          await window.openai.requestClose();
        }
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

  /**
   * Process initial data from `window.openai`.
   */
  private processInitialData(): void {
    if (this.hasProcessedInitialData) return;

    const openai = window.openai;
    if (!openai) {
      console.warn("[SDK] window.openai not available");
      return;
    }

    this.hasProcessedInitialData = true;
    this.setState({ isReady: true });

    if (openai.toolOutput) {
      this.emit("tool-input", openai.toolOutput);
      this.emit("tool-result", { structuredContent: openai.toolOutput });
    }

    if (openai.widgetState) {
      this.setState({ widgetState: openai.widgetState });
      this.emit("widget-state-change", openai.widgetState);
    }
  }

  /**
   * Set up listener for `openai:set_globals` events.
   */
  private setupGlobalsListener(): void {
    this.globalsHandler = (event: Event) => {
      const customEvent = event as CustomEvent<{
        globals?: {
          toolOutput?: Record<string, unknown>;
          widgetState?: WidgetState;
        };
      }>;
      const globals = customEvent.detail?.globals;

      if (globals?.toolOutput) {
        const toolOutputJson = JSON.stringify(globals.toolOutput);
        if (toolOutputJson !== this.lastToolOutputJson) {
          this.lastToolOutputJson = toolOutputJson;
          this.emit("tool-input", globals.toolOutput);
          this.emit("tool-result", { structuredContent: globals.toolOutput });
        }
      }

      if (globals?.widgetState !== undefined) {
        const widgetStateJson = JSON.stringify(globals.widgetState);
        if (widgetStateJson !== this.lastWidgetStateJson) {
          this.lastWidgetStateJson = widgetStateJson;
          this.setState({ widgetState: globals.widgetState });
          this.emit("widget-state-change", globals.widgetState);
        }
      }
    };

    window.addEventListener("openai:set_globals", this.globalsHandler, { passive: true });
  }
}
