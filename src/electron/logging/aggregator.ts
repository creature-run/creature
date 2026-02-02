/**
 * LogAggregator
 *
 * Collects logs from various sources and streams them to the logging window.
 * Implements a ring buffer to prevent unbounded memory growth.
 *
 * Sources:
 * 1. Host - Intercept console.* calls in main process
 * 2. MCP servers - Via MCP protocol notifications/message OR stderr capture
 * 3. UI Resources - Receive via IPC from renderer (forwarded via postMessage)
 *
 * The aggregator maintains a buffer of log entries and broadcasts new entries
 * to any subscribed BrowserWindows (the logs popout window).
 */

import { BrowserWindow } from "electron";

/**
 * Log severity levels matching MCP protocol LoggingLevel.
 * Ordered from least to most severe for filtering purposes.
 */
export type LogLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";

/**
 * Source type for log entries.
 * - host: Logs from the Electron main process
 * - mcp: Logs from MCP servers (via notifications/message or stderr)
 * - ui: Logs from UI Resources (MCP App iframes)
 */
export type LogSource = "host" | "mcp" | "ui";

/**
 * A single log entry in the aggregator.
 */
export interface LogEntry {
  /** Unique ID for React keys */
  id: string;

  /** ISO timestamp when the log was received */
  timestamp: string;

  /** Source category of the log */
  source: LogSource;

  /**
   * Name identifying the specific source.
   * - For host: undefined (there's only one host)
   * - For mcp: The MCP server name (e.g., "terminal")
   * - For ui: The MCP server name (e.g., "terminal")
   */
  sourceName?: string;

  /** Log severity level */
  level: LogLevel;

  /** The log message content */
  message: string;

  /** Optional structured data associated with the log */
  data?: unknown;
}

/**
 * Parameters for adding a log entry (without auto-generated fields).
 */
export interface LogParams {
  source: LogSource;
  sourceName?: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

/**
 * LogAggregator singleton class.
 *
 * Collects logs from multiple sources and maintains a ring buffer.
 * Broadcasts new entries to subscribed windows via IPC.
 */
class LogAggregator {
  /** Ring buffer of log entries */
  private entries: LogEntry[] = [];

  /** Maximum number of entries to retain */
  private maxEntries = 1000;

  /** Subscribed windows that receive log updates */
  private subscribers: Set<BrowserWindow> = new Set();

  /** Counter for generating unique IDs */
  private idCounter = 0;

  /**
   * Generate a unique log entry ID.
   */
  private generateId(): string {
    return `log_${Date.now()}_${this.idCounter++}`;
  }

  /**
   * Add a log entry and broadcast to subscribers.
   *
   * @param params - Log entry parameters (id and timestamp are auto-generated)
   */
  log(params: LogParams): void {
    const entry: LogEntry = {
      id: this.generateId(),
      timestamp: new Date().toISOString(),
      ...params,
    };

    // Add to ring buffer
    this.entries.push(entry);

    // Trim if exceeding max size
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    // Broadcast to all subscribers
    this.broadcast(entry);
  }

  /**
   * Broadcast a log entry to all subscribed windows.
   */
  private broadcast(entry: LogEntry): void {
    for (const window of this.subscribers) {
      if (!window.isDestroyed()) {
        window.webContents.send("logs:entry", entry);
      } else {
        // Clean up destroyed windows
        this.subscribers.delete(window);
      }
    }
  }

  /**
   * Subscribe a window to receive log updates.
   * The window will receive 'logs:entry' IPC events for new logs.
   *
   * @param window - BrowserWindow to subscribe
   */
  subscribe(window: BrowserWindow): void {
    this.subscribers.add(window);

    // Send existing entries to the new subscriber
    window.webContents.send("logs:initial", this.entries);

    // Auto-unsubscribe when window is closed
    window.on("closed", () => {
      this.subscribers.delete(window);
    });
  }

  /**
   * Unsubscribe a window from log updates.
   *
   * @param window - BrowserWindow to unsubscribe
   */
  unsubscribe(window: BrowserWindow): void {
    this.subscribers.delete(window);
  }

  /**
   * Get recent log entries.
   *
   * @param count - Optional limit on number of entries to return
   * @returns Array of recent log entries (newest last)
   */
  getRecent(count?: number): LogEntry[] {
    if (count === undefined || count >= this.entries.length) {
      return [...this.entries];
    }
    return this.entries.slice(-count);
  }

  /**
   * Clear all log entries.
   * Broadcasts a clear event to all subscribers.
   */
  clear(): void {
    this.entries = [];
    for (const window of this.subscribers) {
      if (!window.isDestroyed()) {
        window.webContents.send("logs:cleared");
      }
    }
  }

  /**
   * Get the current number of entries.
   */
  get size(): number {
    return this.entries.length;
  }
}

// Export singleton instance
export const logAggregator = new LogAggregator();

/**
 * Map console.log/warn/error levels to LogLevel.
 */
const CONSOLE_LEVEL_MAP: Record<string, LogLevel> = {
  log: "info",
  info: "info",
  debug: "debug",
  warn: "warning",
  error: "error",
};

/**
 * Serialize a value for logging, handling special cases that JSON.stringify misses.
 *
 * Standard JSON.stringify fails for:
 * - Error objects: message, stack, name are non-enumerable, so {} is returned
 * - Event objects: most properties are getters on prototype, only isTrusted is enumerable
 * - DOM nodes: circular references and non-enumerable properties
 *
 * This function extracts meaningful information from these special types.
 *
 * @param arg - The value to serialize
 * @returns A string representation suitable for logging
 */
const serializeForLogging = (arg: unknown): string => {
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  if (typeof arg !== "object") return String(arg);

  // Handle Error objects - extract non-enumerable properties
  if (arg instanceof Error) {
    const errorName = arg.name || "Error";
    const errorMessage = arg.message || "(no message)";
    const stack = arg.stack;
    if (stack) {
      return `${errorName}: ${errorMessage}\n${stack}`;
    }
    return `${errorName}: ${errorMessage}`;
  }

  // Regular objects - try JSON.stringify
  try {
    return JSON.stringify(arg);
  } catch {
    // Fallback for circular references or other issues
    return String(arg);
  }
};

/**
 * Install console overrides to capture host logs.
 * Should be called early in main process startup.
 *
 * Preserves original console behavior while also routing to LogAggregator.
 */
export const installHostConsoleCapture = (): void => {
  const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const createOverride = (method: keyof typeof originalConsole) => {
    return (...args: unknown[]) => {
      // Call original console method
      originalConsole[method](...args);

      // Route to aggregator with proper serialization for Error/Event objects
      logAggregator.log({
        source: "host",
        level: CONSOLE_LEVEL_MAP[method] || "info",
        message: args.map(serializeForLogging).join(" "),
      });
    };
  };

  console.log = createOverride("log");
  console.info = createOverride("info");
  console.debug = createOverride("debug");
  console.warn = createOverride("warn");
  console.error = createOverride("error");
};

/**
 * Parse log level from a log message string.
 * Looks for patterns like [INFO], [ERROR], [DEBUG], etc.
 *
 * @param message - The log message to parse
 * @returns The detected log level, or "info" as default
 */
export const parseLogLevel = (message: string): LogLevel => {
  const match = message.match(/\[(DEBUG|INFO|NOTICE|WARNING|WARN|ERROR|CRITICAL|ALERT|EMERGENCY)\]/i);
  if (match) {
    const level = match[1].toLowerCase();
    // Normalize WARN to WARNING
    if (level === "warn") return "warning";
    return level as LogLevel;
  }
  return "info";
};

