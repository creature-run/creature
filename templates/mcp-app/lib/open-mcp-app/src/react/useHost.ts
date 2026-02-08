import { useSyncExternalStore, useEffect, useRef, useMemo, useState, useCallback } from "react";
import { createHost, detectEnvironment } from "../core/index.js";
import type { UnifiedHostClient, Environment, ToolResult, WidgetState } from "../core/index.js";
import type { UseHostConfig, UseHostReturn, Logger, ToolCallState, ToolCallTuple, ToolCallFunction, LogLevel } from "./types.js";
import { useHostClientOptional } from "./HostContext.js";

export { detectEnvironment };
export type { Environment };

/**
 * Initial state for a tool call.
 */
const INITIAL_TOOL_STATE: ToolCallState = {
  status: "idle",
  data: null,
  result: null,
  error: null,
  isError: false,
  text: null,
  title: null,
  instanceId: null,
};

/**
 * Max number of queued log entries before dropping old entries.
 */
const MAX_PENDING_LOGS = 200;

/**
 * Max number of queued notifications before dropping old entries.
 */
const MAX_PENDING_NOTIFICATIONS = 200;

/**
 * Extract metadata from a tool result's structuredContent.
 */
const extractResultMetadata = <T>(result: ToolResult<T>): {
  data: T | null;
  title: string | null;
  instanceId: string | null;
  text: string | null;
} => {
  const structured = result.structuredContent as (T & { title?: string; instanceId?: string }) | undefined;
  let data: T | null = null;
  let title: string | null = null;
  let instanceId: string | null = null;

  if (structured) {
    const { title: resultTitle, instanceId: resultInstanceId, ...rest } = structured;
    data = rest as T;
    if (resultTitle) title = resultTitle;
    if (resultInstanceId) instanceId = resultInstanceId;
  }

  const text = result.content?.[0]?.text ?? null;

  return { data, title, instanceId, text };
};

/**
 * React hook for connecting to an MCP Apps host.
 *
 * Can be used in two ways:
 *
 * 1. **With HostProvider** (recommended): Call `useHost()` with no arguments
 *    inside a component wrapped by `<HostProvider>`. The client is shared
 *    via context, and connection is managed by the provider.
 *
 * 2. **Standalone**: Pass config to create and manage your own client.
 *    The hook handles connection/disconnection automatically.
 *
 * @param config - Optional configuration. If omitted, uses HostProvider context.
 * @returns Current state and methods for interacting with the host
 *
 * @example With HostProvider (recommended)
 * ```tsx
 * // App.tsx
 * function App() {
 *   return (
 *     <HostProvider name="my-app" version="1.0.0">
 *       <MyWidget />
 *     </HostProvider>
 *   );
 * }
 *
 * // MyWidget.tsx
 * function MyWidget() {
 *   const { callTool, isReady, log, exp_widgetState } = useHost();
 *   const [widgetState, setWidgetState] = exp_widgetState();
 *   const [listTodos, listTodosData] = callTool("todos_list");
 *
 *   useEffect(() => {
 *     if (isReady) listTodos();
 *   }, [isReady, listTodos]);
 * }
 * ```
 *
 * @example Standalone (creates own client)
 * ```tsx
 * function MyApp() {
 *   const { isReady, callTool, log } = useHost({
 *     name: "my-app",
 *     version: "1.0.0",
 *   });
 * }
 * ```
 */
export function useHost(config?: UseHostConfig): UseHostReturn {
  // Check if we're inside a HostProvider
  const contextClient = useHostClientOptional();

  // Determine if we should use context or create our own client
  const useContext = !config && contextClient !== null;

  const clientRef = useRef<UnifiedHostClient | null>(null);

  if (!useContext) {
    // Standalone mode: create our own client
    if (!config) {
      throw new Error(
        "useHost() requires either a HostProvider wrapper or config argument. " +
        "Either wrap your app with <HostProvider name=\"...\" version=\"...\"> " +
        "or pass { name, version } to useHost()."
      );
    }
    if (!clientRef.current) {
      clientRef.current = createHost({ name: config.name, version: config.version });
    }
  }

  // Use context client if available, otherwise our own
  const client = useContext ? contextClient! : clientRef.current!;

  // ============================================================================
  // Tool Call State Management
  // ============================================================================

  /**
   * Map of tool name -> current state for that tool.
   * Using useState to trigger re-renders when tool states change.
   */
  const [toolStates, setToolStates] = useState<Map<string, ToolCallState>>(
    () => new Map()
  );

  /**
   * Ref to store stable run functions for each tool.
   * This prevents creating new function identities on every render.
   */
  const toolFunctionsRef = useRef<Map<string, ToolCallFunction>>(new Map());

  /**
   * Track in-flight tool calls by tool+args to avoid duplicate requests.
   */
  const inflightToolCallsRef = useRef<Map<string, Promise<ToolResult<Record<string, unknown>>>>>(new Map());

  /**
   * Queue logs until the host connection is ready.
   */
  const pendingLogQueueRef = useRef<Array<{
    level: LogLevel;
    message: string;
    data?: Record<string, unknown>;
  }>>([]);

  /**
   * Queue notifications until the host connection is ready.
   */
  const pendingNotificationQueueRef = useRef<Array<{
    method: string;
    params: unknown;
  }>>([]);

  /**
   * Update the state for a specific tool.
   */
  const updateToolState = useCallback(
    <T>(toolName: string, newState: Partial<ToolCallState<T>>) => {
      setToolStates((prev) => {
        const current = (prev.get(toolName) ?? INITIAL_TOOL_STATE) as ToolCallState<T>;
        const updated = { ...current, ...newState };
        const next = new Map(prev);
        next.set(toolName, updated as ToolCallState);
        return next;
      });
    },
    []
  );

  /**
   * Wait for the host connection to be ready before calling tools.
   * This queues early tool calls and avoids "Not connected" errors on mount.
   */
  const waitForReady = useCallback(async (): Promise<void> => {
    if (client.getState().isReady) return;

    await new Promise<void>((resolve) => {
      const unsubscribe = client.subscribe(() => {
        if (client.getState().isReady) {
          unsubscribe();
          resolve();
        }
      });
    });
  }, [client]);

  /**
   * Serialize tool arguments to build a stable inflight key.
   */
  const serializeToolArgs = useCallback(
    ({ args }: { args: Record<string, unknown> }): string => {
      try {
        return JSON.stringify(args);
      } catch {
        return "__unserializable__";
      }
    },
    []
  );

  /**
   * Build a stable inflight key for a tool call.
   */
  const buildToolCallKey = useCallback(
    ({ toolName, args }: { toolName: string; args: Record<string, unknown> }): string => {
      return `${toolName}::${serializeToolArgs({ args })}`;
    },
    [serializeToolArgs]
  );

  /**
   * Get or create a stable tool call function for the given tool name.
   */
  const getOrCreateToolFunction = useCallback(
    <T>(toolName: string): ToolCallFunction<T> => {
      const existing = toolFunctionsRef.current.get(toolName);
      if (existing) {
        return existing as ToolCallFunction<T>;
      }

      const runFn: ToolCallFunction<T> = async (args: Record<string, unknown> = {}) => {
        const key = buildToolCallKey({ toolName, args });
        const inflight = inflightToolCallsRef.current.get(key);
        if (inflight) {
          return inflight as Promise<ToolResult<T>>;
        }

        // Set loading state
        updateToolState<T>(toolName, {
          status: "loading",
          error: null,
        });

        const promise = (async () => {
          await waitForReady();
          return client.callTool<T>(toolName, args);
        })();

        inflightToolCallsRef.current.set(key, promise as Promise<ToolResult<Record<string, unknown>>>);

        try {
          const result = await promise;
          const { data, title, instanceId, text } = extractResultMetadata<T>(result);

          // Update state with success
          updateToolState<T>(toolName, {
            status: "success",
            data,
            result,
            error: null,
            isError: result.isError ?? false,
            text,
            title,
            instanceId,
          });

          return result;
        } catch (err) {
          // Update state with error
          updateToolState<T>(toolName, {
            status: "error",
            error: err,
            isError: true,
          });

          throw err;
        } finally {
          inflightToolCallsRef.current.delete(key);
        }
      };

      toolFunctionsRef.current.set(toolName, runFn as ToolCallFunction);
      return runFn;
    },
    [client, updateToolState, waitForReady]
  );

  /**
   * Factory function that returns a tuple of [runFn, state] for a tool.
   */
  const callTool = useCallback(
    <T = Record<string, unknown>>(toolName: string): ToolCallTuple<T> => {
      const runFn = getOrCreateToolFunction<T>(toolName);
      const currentState = (toolStates.get(toolName) ?? INITIAL_TOOL_STATE) as ToolCallState<T>;
      return [runFn, currentState];
    },
    [getOrCreateToolFunction, toolStates]
  );

  // ============================================================================
  // Logger
  // ============================================================================

  /**
   * Create a logger function with convenience methods.
   * The base function logs at "info" level by default.
   */
  const enqueueLog = useCallback(
    ({
      level,
      message,
      data,
    }: {
      level: LogLevel;
      message: string;
      data?: Record<string, unknown>;
    }) => {
      if (client.getState().isReady) {
        client.log(level, message, data);
        return;
      }

      const queue = pendingLogQueueRef.current;
      queue.push({ level, message, data });
      if (queue.length > MAX_PENDING_LOGS) {
        queue.splice(0, queue.length - MAX_PENDING_LOGS);
      }
    },
    [client]
  );

  /**
   * Flush queued logs once the host is ready.
   */
  const flushPendingLogs = useCallback(() => {
    if (!client.getState().isReady) return;
    const queue = pendingLogQueueRef.current;
    if (queue.length === 0) return;
    pendingLogQueueRef.current = [];
    queue.forEach((entry) => client.log(entry.level, entry.message, entry.data));
  }, [client]);

  /**
   * Create a logger function with convenience methods.
   * The base function logs at "info" level by default.
   */
  const log = useMemo(() => {
    /**
     * Default logger function that writes at "info" level.
     */
    const logFn = (message: string, data?: Record<string, unknown>) => {
      enqueueLog({ level: "info", message, data });
    };

    // Attach convenience methods for each log level
    logFn.debug = (message: string, data?: Record<string, unknown>) => {
      enqueueLog({ level: "debug", message, data });
    };
    logFn.info = (message: string, data?: Record<string, unknown>) => {
      enqueueLog({ level: "info", message, data });
    };
    logFn.notice = (message: string, data?: Record<string, unknown>) => {
      enqueueLog({ level: "notice", message, data });
    };
    logFn.warn = (message: string, data?: Record<string, unknown>) => {
      enqueueLog({ level: "warning", message, data });
    };
    logFn.error = (message: string, data?: Record<string, unknown>) => {
      enqueueLog({ level: "error", message, data });
    };

    return logFn as Logger;
  }, [enqueueLog]);

  // ============================================================================
  // Other Methods
  // ============================================================================

  const requestDisplayMode = useMemo(
    () => client.requestDisplayMode.bind(client),
    [client]
  );

  /**
   * Update model context - bound to client for stable reference.
   */
  const updateModelContext = useMemo(
    () => client.updateModelContext.bind(client),
    [client]
  );

  /**
   * Queue raw notifications until the host connection is ready.
   */
  const enqueueNotification = useCallback(
    ({
      method,
      params,
    }: {
      method: string;
      params: unknown;
    }) => {
      if (client.getState().isReady) {
        client.exp.sendNotification(method, params);
        return;
      }

      const queue = pendingNotificationQueueRef.current;
      queue.push({ method, params });
      if (queue.length > MAX_PENDING_NOTIFICATIONS) {
        queue.splice(0, queue.length - MAX_PENDING_NOTIFICATIONS);
      }
    },
    [client]
  );

  /**
   * Flush queued notifications once the host is ready.
   */
  const flushPendingNotifications = useCallback(() => {
    if (!client.getState().isReady) return;
    const queue = pendingNotificationQueueRef.current;
    if (queue.length === 0) return;
    pendingNotificationQueueRef.current = [];
    queue.forEach((entry) => client.exp.sendNotification(entry.method, entry.params));
  }, [client]);

  // ============================================================================
  // Widget State Tuple
  // ============================================================================

  const state = useSyncExternalStore(
    (onStoreChange) => client.subscribe(onStoreChange),
    () => client.getState(),
    () => client.getState()
  );

  /**
   * Track the last widgetState payload sent to the host.
   */
  const lastWidgetStateJsonRef = useRef<string | null>(null);

  /**
   * Queue the most recent widgetState when throttling is enabled.
   */
  const pendingWidgetStateRef = useRef<{
    state: WidgetState | null;
    stateJson: string | null;
  } | null>(null);

  /**
   * Track an active throttle timer for widgetState updates.
   */
  const widgetStateThrottleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Safely serialize widgetState for deduping.
   */
  const serializeWidgetState = useCallback(
    ({ state }: { state: WidgetState | null }): string | null => {
      if (state === null) return "null";
      try {
        return JSON.stringify(state);
      } catch {
        return null;
      }
    },
    []
  );

  /**
   * Send widgetState to the host when it has changed meaningfully.
   */
  const sendWidgetState = useCallback(
    ({
      state,
      stateJson,
    }: {
      state: WidgetState | null;
      stateJson: string | null;
    }) => {
      if (stateJson && stateJson === lastWidgetStateJsonRef.current) {
        return;
      }

      if (stateJson) {
        lastWidgetStateJsonRef.current = stateJson;
      }

      if (!client.getState().isReady) {
        pendingWidgetStateRef.current = { state, stateJson };
        return;
      }

      client.exp.setWidgetState(state);
    },
    [client]
  );

  /**
   * Stable setter for widget state.
   * Using useCallback to ensure stable identity across renders.
   */
  const setWidgetState = useCallback(
    <T extends WidgetState = WidgetState>(newState: T | null) => {
      const stateJson = serializeWidgetState({ state: newState });
      const throttleMs = config?.widgetStateThrottleMs;

      if (!throttleMs || throttleMs <= 0) {
        sendWidgetState({ state: newState, stateJson });
        return;
      }

      pendingWidgetStateRef.current = { state: newState, stateJson };

      if (widgetStateThrottleTimerRef.current) {
        return;
      }

      widgetStateThrottleTimerRef.current = setTimeout(() => {
        widgetStateThrottleTimerRef.current = null;
        const pending = pendingWidgetStateRef.current;
        pendingWidgetStateRef.current = null;
        if (pending) {
          sendWidgetState({ state: pending.state, stateJson: pending.stateJson });
        }
      }, throttleMs);
    },
    [config?.widgetStateThrottleMs, sendWidgetState, serializeWidgetState]
  );

  /**
   * Returns a useState-like tuple for widget state.
   * The setter is stable and deduplicates identical updates.
   */
  const exp_widgetState = useCallback(
    <T extends WidgetState = WidgetState>(): [T | null, (s: T | null) => void] => {
      const currentState = state.widgetState as T | null;
      return [currentState, setWidgetState as (s: T | null) => void];
    },
    [state.widgetState, setWidgetState]
  );

  /**
   * Wrap exp APIs for stable references.
   */
  const exp = useMemo(
    () => ({
      /**
       * Set widget state with readiness gating and deduping.
       */
      setWidgetState: (state: WidgetState | null) => {
        const stateJson = serializeWidgetState({ state });
        sendWidgetState({ state, stateJson });
      },
      setTitle: client.exp.setTitle.bind(client.exp),
      /**
       * Send a raw notification after the host is ready.
       */
      sendNotification: (method: string, params: unknown) => {
        enqueueNotification({ method, params });
      },
      getInstanceId: client.exp.getInstanceId.bind(client.exp),
      supportsMultiInstance: client.exp.supportsMultiInstance.bind(client.exp),
      getInitialToolResult: client.exp.getInitialToolResult.bind(client.exp),
      sendFollowUpMessage: client.exp.sendFollowUpMessage.bind(client.exp),
      requestModal: client.exp.requestModal.bind(client.exp),
      requestClose: client.exp.requestClose.bind(client.exp),
    }),
    [client, enqueueNotification, sendWidgetState, serializeWidgetState]
  );

  /**
   * Subscribe to tool results from external sources (e.g., agent calls).
   * Returns an unsubscribe function.
   */
  const onToolResult = useCallback(
    (callback: (result: ToolResult) => void): (() => void) => {
      return client.on("tool-result", callback);
    },
    [client]
  );

  // ============================================================================
  // Lifecycle & Event Handlers
  // ============================================================================

  /**
   * Store callbacks in refs to prevent reconnection loops.
   * Consumers often pass inline functions which would change identity on every render,
   * but we don't want that to trigger reconnection.
   */
  const callbacksRef = useRef({
    onToolInput: config?.onToolInput,
    onToolResult: config?.onToolResult,
    onThemeChange: config?.onThemeChange,
    onTeardown: config?.onTeardown,
    onWidgetStateChange: config?.onWidgetStateChange,
  });

  useEffect(() => {
    callbacksRef.current = {
      onToolInput: config?.onToolInput,
      onToolResult: config?.onToolResult,
      onThemeChange: config?.onThemeChange,
      onTeardown: config?.onTeardown,
      onWidgetStateChange: config?.onWidgetStateChange,
    };
  });

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    // Subscribe to events (works for both context and standalone mode)
    unsubs.push(
      client.on("tool-input", (args) => callbacksRef.current.onToolInput?.(args))
    );
    unsubs.push(
      client.on("tool-result", (result) => callbacksRef.current.onToolResult?.(result))
    );
    unsubs.push(
      client.on("theme-change", (theme) => callbacksRef.current.onThemeChange?.(theme))
    );
    unsubs.push(
      client.on("teardown", () => callbacksRef.current.onTeardown?.())
    );
    unsubs.push(
      client.on("widget-state-change", (widgetState) =>
        callbacksRef.current.onWidgetStateChange?.(widgetState)
      )
    );

    // Only manage connection in standalone mode (not when using HostProvider)
    if (!useContext) {
      client.connect();
    }

    return () => {
      unsubs.forEach((unsub) => unsub());
      if (!useContext) {
        client.disconnect();
      }
    };
  }, [client, useContext]);

  useEffect(() => {
    if (!state.isReady) return;
    flushPendingLogs();
    flushPendingNotifications();
    const pendingWidgetState = pendingWidgetStateRef.current;
    if (pendingWidgetState) {
      pendingWidgetStateRef.current = null;
      sendWidgetState({
        state: pendingWidgetState.state,
        stateJson: pendingWidgetState.stateJson,
      });
    }
  }, [flushPendingLogs, flushPendingNotifications, sendWidgetState, state.isReady]);

  // ============================================================================
  // Return
  // ============================================================================

  return {
    isReady: state.isReady,
    environment: state.environment,
    widgetState: state.widgetState,
    callTool,
    requestDisplayMode,
    log,
    updateModelContext,
    hostContext: client.getHostContext(),
    // Experimental APIs (non-spec extensions)
    exp,
    exp_widgetState,
    // Tool result subscription
    onToolResult,
  };
};
