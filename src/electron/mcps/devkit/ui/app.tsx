/**
 * MCP Devkit UI
 *
 * Single-view log viewer and status display for the developer toolkit.
 * Shows the result of the most recent tool call: logs, refresh status, etc.
 * Uses Tailwind 4 with SDK theme mapping for host-provided variables.
 */

import { useEffect, useState, useRef } from "react";
import { HostProvider, useHost } from "open-mcp-app/react";
// Tailwind 4 integration - imports SDK theme mapping for host-provided variables
import "open-mcp-app/styles/tailwind.css";
import "./styles.css";

// =============================================================================
// Types
// =============================================================================

/**
 * A log entry from Creature's LogAggregator.
 * Matches the shape returned by handleDevkitToolCall in the control plane.
 */
interface LogEntry {
  id: string;
  timestamp: string;
  source: "host" | "mcp" | "ui";
  sourceName?: string;
  level: string;
  message: string;
}

/**
 * The structured content returned by devkit_get_logs.
 */
interface LogsData {
  type: "logs";
  logs: LogEntry[];
  filter: string;
  mcpName?: string;
  total: number;
}

/**
 * The structured content returned by devkit_refresh_mcp_app.
 */
interface RefreshData {
  type: "refresh";
  success: boolean;
  mcpName: string;
  error?: string;
}

type DevkitData = LogsData | RefreshData;

// =============================================================================
// Log Level Badge
// =============================================================================

/**
 * Color-coded badge for log severity levels.
 * Maps each level to a consistent color for quick visual scanning.
 */
const LevelBadge = ({ level }: { level: string }) => {
  const colorMap: Record<string, string> = {
    debug: "text-txt-tertiary bg-bg-secondary",
    info: "text-blue-400 bg-blue-400/10",
    notice: "text-blue-400 bg-blue-400/10",
    warning: "text-yellow-400 bg-yellow-400/10",
    error: "text-red-400 bg-red-400/10",
    critical: "text-red-400 bg-red-400/10",
    alert: "text-red-400 bg-red-400/10",
    emergency: "text-red-400 bg-red-400/10",
  };

  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 uppercase ${colorMap[level] || "text-txt-secondary bg-bg-secondary"}`}>
      {level.slice(0, 5)}
    </span>
  );
};

// =============================================================================
// Log Entry Row
// =============================================================================

/**
 * A single log entry displayed as a compact row.
 * Shows timestamp, level badge, source, and message.
 */
const LogRow = ({ entry }: { entry: LogEntry }) => {
  const time = new Date(entry.timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div className="flex items-start gap-2 px-3 py-1.5 text-xs border-b border-bdr-secondary hover:bg-bg-secondary transition-colors">
      <span className="text-txt-tertiary font-mono shrink-0">{time}</span>
      <LevelBadge level={entry.level} />
      {entry.sourceName && (
        <span className="text-txt-secondary font-mono shrink-0 max-w-[80px] truncate">
          {entry.sourceName}
        </span>
      )}
      <span className="text-txt-primary break-all whitespace-pre-wrap min-w-0">
        {entry.message}
      </span>
    </div>
  );
};

// =============================================================================
// Views
// =============================================================================

/**
 * Log viewer displaying a list of log entries.
 * Auto-scrolls to the bottom when new logs arrive.
 */
const LogsView = ({ data }: { data: LogsData }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data.logs]);

  const filterLabel = data.filter === "current_mcp_app" && data.mcpName
    ? `MCP App: ${data.mcpName}`
    : data.filter === "errors"
      ? "Errors only"
      : "All logs";

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-bdr-secondary">
        <span className="text-xs text-txt-secondary">{filterLabel}</span>
        <span className="text-xs text-txt-tertiary">{data.total} entries</span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
        {data.logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-txt-tertiary text-sm">
            No logs found
          </div>
        ) : (
          data.logs.map((entry) => <LogRow key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  );
};

/**
 * Status display for MCP App refresh results.
 * Shows success or error state with the MCP App name.
 */
const RefreshView = ({ data }: { data: RefreshData }) => (
  <div className="flex items-center justify-center h-full px-4">
    <div className="text-center">
      <div className={`text-sm font-medium ${data.success ? "text-green-400" : "text-red-400"}`}>
        {data.success ? "MCP App restarted" : "Restart failed"}
      </div>
      <div className="text-xs text-txt-secondary mt-1">{data.mcpName}</div>
      {data.error && (
        <div className="text-xs text-red-400 mt-2">{data.error}</div>
      )}
    </div>
  </div>
);

/**
 * Empty state shown when no tool has been called yet.
 */
const EmptyView = () => (
  <div className="flex items-center justify-center h-full text-txt-tertiary text-sm">
    Waiting for devkit tool call...
  </div>
);

// =============================================================================
// Main App
// =============================================================================

/**
 * Devkit inner component.
 *
 * Listens for tool results and renders the appropriate view based on
 * the structured content type (logs, refresh status, etc.).
 */
const DevkitInner = () => {
  const { onToolResult, isReady } = useHost();
  const [currentData, setCurrentData] = useState<DevkitData | null>(null);

  useEffect(() => {
    return onToolResult((result) => {
      const data = result.structuredContent as unknown as DevkitData;
      if (data && typeof data === "object" && "type" in data) {
        setCurrentData(data);
      }
    });
  }, [onToolResult]);

  if (!isReady) {
    return (
      <div className="flex items-center justify-center h-full text-txt-tertiary text-sm">
        Connecting...
      </div>
    );
  }

  if (!currentData) return <EmptyView />;

  switch (currentData.type) {
    case "logs":
      return <LogsView data={currentData} />;
    case "refresh":
      return <RefreshView data={currentData} />;
    default:
      return <EmptyView />;
  }
};

/**
 * Root app component wrapped in HostProvider.
 */
const App = () => (
  <HostProvider name="devkit" version="0.1.0">
    <div className="h-full flex flex-col bg-bg-primary text-txt-primary">
      <DevkitInner />
    </div>
  </HostProvider>
);

export default App;
