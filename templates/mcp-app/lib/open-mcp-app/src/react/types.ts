import type {
  ContentBlock,
  DisplayMode,
  Environment,
  LogLevel,
  ToolResult,
  WidgetState,
  HostContext,
  WebSocketStatus,
  ExpHostApi,
} from "../core/types.js";

export type { ContentBlock, DisplayMode, Environment, LogLevel, ToolResult, WidgetState, HostContext, WebSocketStatus, ExpHostApi };

export { type StructuredWidgetState } from "../core/types.js";

// ============================================================================
// useHost
// ============================================================================

export interface UseHostConfig {
  name: string;
  version: string;
  onToolInput?: (args: Record<string, unknown>) => void;
  onToolResult?: (result: ToolResult) => void;
  onThemeChange?: (theme: "light" | "dark") => void;
  onTeardown?: () => Promise<void>;
  /** Called when widget state changes (restored from host or updated) */
  onWidgetStateChange?: (widgetState: WidgetState | null) => void;
  /**
   * Optional throttle for widget state updates (milliseconds).
   * When set, rapid widgetState updates are coalesced to reduce render loops.
   */
  widgetStateThrottleMs?: number;
}

// ============================================================================
// Tool Calling
// ============================================================================

/**
 * Status of a tool call.
 */
export type ToolCallStatus = "idle" | "loading" | "success" | "error";

/**
 * State returned from a tool call.
 * Contains the status, data, and metadata from the tool result.
 */
export interface ToolCallState<T = Record<string, unknown>> {
  /** Current status of the tool call */
  status: ToolCallStatus;
  /** Structured data from tool result (from structuredContent) */
  data: T | null;
  /** Full tool result object */
  result: ToolResult<T> | null;
  /** Error if the tool call failed */
  error: unknown | null;
  /** Whether the result is an error (from isError flag or thrown exception) */
  isError: boolean;
  /** Text content for AI context (from content[0].text) */
  text: string | null;
  /** Title for PIP tab (from structuredContent.title) */
  title: string | null;
  /** Instance ID for this widget (from structuredContent.instanceId) */
  instanceId: string | null;
}

/**
 * Function to call a tool with optional arguments.
 * Returns a promise that resolves to the tool result.
 */
export type ToolCallFunction<T = Record<string, unknown>> = (
  args?: Record<string, unknown>
) => Promise<ToolResult<T>>;

/**
 * Tuple returned from callTool().
 * First element is the function to call the tool, second is the current state.
 */
export type ToolCallTuple<T = Record<string, unknown>> = [
  ToolCallFunction<T>,
  ToolCallState<T>
];

/**
 * Logger interface with convenience methods for each log level.
 *
 * Provides both a default `log(message, data?)` method (logs at "info" level)
 * and explicit level methods: `debug()`, `info()`, `notice()`, `warn()`, `error()`.
 */
export interface Logger {
  /**
   * Log a message at "info" level (default).
   * @param message - Log message
   * @param data - Optional structured data
   */
  (message: string, data?: Record<string, unknown>): void;

  /**
   * Log at "debug" level. Gray in DevConsole, typically hidden by default.
   */
  debug: (message: string, data?: Record<string, unknown>) => void;

  /**
   * Log at "info" level. Normal text color in DevConsole.
   */
  info: (message: string, data?: Record<string, unknown>) => void;

  /**
   * Log at "notice" level. Blue in DevConsole, for notable events.
   */
  notice: (message: string, data?: Record<string, unknown>) => void;

  /**
   * Log at "warning" level. Yellow in DevConsole.
   */
  warn: (message: string, data?: Record<string, unknown>) => void;

  /**
   * Log at "error" level. Red in DevConsole.
   */
  error: (message: string, data?: Record<string, unknown>) => void;
}

export interface UseHostReturn {
  isReady: boolean;

  /**
   * Get a tool caller for the given tool name.
   * Returns a tuple of [callFn, state] where:
   * - callFn: Function to call the tool with optional args (defaults to {})
   * - state: Current state of the tool call (status, data, error, etc.)
   *
   * @example
   * ```tsx
   * const { callTool, isReady } = useHost({ name: "my-app", version: "1.0.0" });
   * const [listTodos, listTodosState] = callTool<TodoData>("todos_list");
   * const [addTodo, addTodoState] = callTool<TodoData>("todos_add");
   *
   * useEffect(() => {
   *   if (isReady) {
   *     listTodos(); // Call with no args
   *   }
   * }, [isReady, listTodos]);
   *
   * // Use the state
   * if (listTodosState.status === "loading") return <Spinner />;
   * if (listTodosState.data) return <TodoList todos={listTodosState.data.todos} />;
   *
   * // Call with args
   * <button onClick={() => addTodo({ text: "New todo" })}>Add</button>
   * ```
   */
  callTool: <T = Record<string, unknown>>(toolName: string) => ToolCallTuple<T>;

  environment: Environment;
  /** Current widget state (read-only). Use exp_widgetState() for read/write access. */
  widgetState: WidgetState | null;
  requestDisplayMode: (params: { mode: DisplayMode }) => Promise<{ mode: DisplayMode }>;

  /**
   * Get the host context received from the host.
   * Contains theme, styles, userAgent, and host-specific properties.
   * Returns null before connection is established.
   */
  hostContext: HostContext | null;

  /**
   * Logger for sending messages to the host's DevConsole.
   *
   * @example
   * ```tsx
   * const { log } = useHost({ name: "my-app", version: "1.0.0" });
   *
   * // Default level (info)
   * log("User clicked button");
   *
   * // With data
   * log("Processing item", { itemId: 123 });
   *
   * // Specific levels
   * log.debug("Verbose debugging info");
   * log.info("General information");
   * log.notice("Notable event");
   * log.warn("Something looks off");
   * log.error("Something went wrong", { error: err.message });
   * ```
   */
  log: Logger;

  /**
   * Update the model context for future turns.
   *
   * Use this for ephemeral notifications that don't need persistence.
   * For persistent context, use widgetState.modelContent instead.
   *
   * @example
   * ```tsx
   * const { updateModelContext } = useHost();
   *
   * // Inform the model about a user action
   * await updateModelContext([
   *   { type: "text", text: "User selected file: /src/App.tsx" }
   * ]);
   * ```
   */
  updateModelContext: (content: ContentBlock[]) => Promise<void>;

  /**
   * Experimental APIs for non-standard features.
   *
   * These APIs provide access to host-specific features that may not be
   * supported by all hosts. Methods gracefully degrade on unsupported hosts.
   *
   * @example
   * ```tsx
   * const { exp } = useHost({ name: "my-app", version: "1.0.0" });
   *
   * // Set widget state (non-spec extension)
   * exp.setWidgetState({ count: 42 });
   *
   * // Set title (Creature-only, no-op on others)
   * exp.setTitle("My Widget");
   * ```
   */
  exp: ExpHostApi;

  /**
   * Get widget state as a useState-like tuple.
   * Returns [state, setState] for reading and updating widget state.
   *
   * Widget state is persisted by the host across sessions and restored
   * when the widget is re-opened.
   *
   * @example
   * ```tsx
   * const { exp_widgetState } = useHost({ name: "my-app", version: "1.0.0" });
   * const [widgetState, setWidgetState] = exp_widgetState<MyState>();
   *
   * return (
   *   <button onClick={() => setWidgetState({ count: (widgetState?.count ?? 0) + 1 })}>
   *     Count: {widgetState?.count ?? 0}
   *   </button>
   * );
   * ```
   */
  exp_widgetState: <T extends WidgetState = WidgetState>() => [
    T | null,
    (state: T | null) => void
  ];

  /**
   * Subscribe to tool results from external sources (e.g., agent calls).
   *
   * This allows reacting to tool calls made by the agent, not just UI-initiated calls.
   * Returns an unsubscribe function.
   *
   * @example
   * ```tsx
   * const { onToolResult } = useHost();
   *
   * useEffect(() => {
   *   return onToolResult((result) => {
   *     if (result.structuredContent?.todos) {
   *       setTodos(result.structuredContent.todos);
   *     }
   *   });
   * }, [onToolResult]);
   * ```
   */
  onToolResult: (callback: (result: ToolResult) => void) => () => void;
}

// ============================================================================
// useToolResult
// ============================================================================

export interface UseToolResultReturn<T> {
  /** Structured data from tool result */
  data: T | null;
  /** Instance ID for this widget */
  instanceId: string | null;
  /** Title for PIP tab */
  title: string | null;
  /** Whether this is an error result */
  isError: boolean;
  /** Text content for AI context */
  text: string | null;
  /** Callback to handle tool result */
  onToolResult: (result: ToolResult) => void;
  /** Reset all state */
  reset: () => void;
}

// ============================================================================
// useWebSocket
// ============================================================================

export interface UseWebSocketConfig<TReceive = unknown> {
  onMessage?: (message: TReceive) => void;
  enabled?: boolean;
}

export interface UseWebSocketReturn<TSend = unknown> {
  status: WebSocketStatus;
  error: string | undefined;
  send: (message: TSend) => void;
}

// ============================================================================
// CreatureIcon
// ============================================================================

export interface CreatureIconProps {
  /** Whether the app is in dark mode */
  isDarkMode: boolean;
  /** Whether to show the eyes (default: true) */
  showEyes?: boolean;
  /** Whether to enable eye blinking animation (default: false) */
  enableBlink?: boolean;
  /** Width of the icon in pixels */
  width?: number;
  /** Height of the icon in pixels */
  height?: number;
  /** Optional className for additional styling */
  className?: string;
}
