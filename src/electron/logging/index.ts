/**
 * Logging Module
 *
 * Exports the LogAggregator and utilities for capturing logs from
 * Host, MCP servers, and UI Resources.
 */

export {
  logAggregator,
  installHostConsoleCapture,
  parseLogLevel,
  type LogEntry,
  type LogLevel,
  type LogSource,
  type LogParams,
} from "./aggregator";

export { CONSOLE_OVERRIDE_SCRIPT } from "./consoleOverride";

