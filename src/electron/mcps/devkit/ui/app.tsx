/**
 * MCP Devkit UI
 *
 * Tabbed developer toolkit with three views:
 * - Logs: Real-time log viewer from Creature's LogAggregator
 * - Conversation: Current conversation history inspector
 * - System Prompt: Current system prompt viewer
 *
 * Design principles:
 * - Read-only inspection tool (no mutations)
 * - Stable state across refreshes (no scroll reset, no expanded state reset)
 * - Virtualized lists for scalability with many rows
 * - Data fetched on-demand via callTool (pull model, not push)
 */

import { useEffect, useState, useRef, useCallback, memo } from "react";
import { HostProvider, useHost } from "open-mcp-app/react";
import { useVirtualizer } from "@tanstack/react-virtual";
// Tailwind 4 integration - imports SDK theme mapping for host-provided variables
import "open-mcp-app/styles/tailwind.css";
import "./styles.css";

// =============================================================================
// Types
// =============================================================================

type TabId = "logs" | "conversation" | "prompt";

/**
 * Log entry from Creature's LogAggregator.
 * Shape matches what handleDevkitToolCall returns.
 */
interface LogEntry {
  id: string;
  timestamp: string;
  source: "host" | "mcp" | "ui";
  sourceName?: string;
  level: string;
  message: string;
}

interface LogsData {
  type: "logs";
  logs: LogEntry[];
  filter: string;
  mcpName?: string;
  total: number;
}

interface ConversationData {
  type: "conversation";
  messages: ConversationMessage[];
}

/**
 * A single message in the conversation.
 * Shape is whatever the agent stores - we render it generically.
 */
interface ConversationMessage {
  id?: string;
  role?: string;
  content?: unknown;
  parts?: Array<{
    type: string;
    text?: string;
    toolInvocation?: { toolName: string };
    toolName?: string;
  }>;
  [key: string]: unknown;
}

interface PromptData {
  type: "system_prompt";
  prompt: string;
}

interface RefreshData {
  type: "refresh";
  success: boolean;
  mcpName: string;
  error?: string;
}

type DevkitData = LogsData | ConversationData | PromptData | RefreshData;

// =============================================================================
// Shared Components
// =============================================================================

/**
 * Tab bar for switching between views.
 * Renders a row of clickable tabs with an active indicator.
 */
const TabBar = ({
  activeTab,
  onTabChange,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}) => {
  const tabs: { id: TabId; label: string }[] = [
    { id: "logs", label: "Logs" },
    { id: "conversation", label: "Conversation" },
    { id: "prompt", label: "System Prompt" },
  ];

  return (
    <div className="flex border-b border-bdr-secondary shrink-0">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
            activeTab === tab.id
              ? "text-txt-primary border-b-2 border-txt-primary"
              : "text-txt-tertiary hover:text-txt-secondary"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
};

/**
 * Toolbar with a refresh button and optional children on the left side.
 * Accepts an `actions` prop for buttons rendered to the left of the refresh button.
 * Shared across all tab views for consistent layout.
 */
const Toolbar = ({
  onRefresh,
  isLoading,
  children,
  actions,
}: {
  onRefresh: () => void;
  isLoading: boolean;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) => (
  <div className="flex items-center justify-between px-3 py-1.5 border-b border-bdr-secondary shrink-0">
    <div className="flex items-center gap-2 text-xs text-txt-secondary">
      {children}
    </div>
    <div className="flex items-center gap-2">
      {actions}
      <button
        onClick={onRefresh}
        disabled={isLoading}
        className="text-[11px] text-txt-tertiary hover:text-txt-primary transition-colors cursor-pointer disabled:opacity-40"
      >
        {isLoading ? "Loading..." : "Refresh"}
      </button>
    </div>
  </div>
);

/**
 * Status bar at the bottom of each tab view.
 * Shows entry count and optional extra info.
 */
const StatusBar = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center justify-between px-3 py-1 border-t border-bdr-secondary text-[10px] text-txt-tertiary shrink-0">
    {children}
  </div>
);

// =============================================================================
// Logs View
// =============================================================================

/**
 * Log level color map matching the DevConsole's CSS variables.
 * Uses inline styles for exact color parity across dark/light mode.
 */
const LOG_LEVEL_COLORS: Record<string, string> = {
  debug: "#666666",
  info: "#ABABAB",
  notice: "#58A6FF",
  warning: "#D29922",
  error: "#F85149",
  critical: "#F85149",
  alert: "#F85149",
  emergency: "#F85149",
};

/**
 * Color palette for MCP server source labels.
 * Each MCP gets a unique color assigned in order as they first appear.
 * #7EE787 is reserved for Host logs and excluded from this palette.
 */
const MCP_COLOR_PALETTE = [
  "#58A6FF", "#FFB347", "#F778BA", "#A5D6FF", "#FFA657",
  "#D2A8FF", "#79C0FF", "#FDDF68", "#FF7B72", "#9ECBFF",
  "#FFAB70", "#E0A458", "#F692CE", "#B392F0", "#FFCB6B",
  "#89DDFF", "#C792EA", "#82AAFF", "#F07178", "#56D364",
];

const mcpColorCache = new Map<string, string>();
let nextMcpColorIndex = 0;

/**
 * Assign a consistent color to an MCP server name.
 * Colors are assigned in order from the palette and cached so
 * the same server always gets the same color within a session.
 */
const getMcpColor = (mcpName: string): string => {
  if (!mcpColorCache.has(mcpName)) {
    mcpColorCache.set(mcpName, MCP_COLOR_PALETTE[nextMcpColorIndex % MCP_COLOR_PALETTE.length]);
    nextMcpColorIndex++;
  }
  return mcpColorCache.get(mcpName)!;
};

/**
 * Format a source label for display, matching DevConsole conventions.
 * Host -> "Host", MCP -> "name [server]", UI -> "name [ui]"
 */
const getSourceDisplay = (entry: LogEntry): string => {
  if (entry.source === "host") return "Host";
  if (entry.sourceName) {
    if (entry.source === "mcp") return `${entry.sourceName} [server]`;
    if (entry.source === "ui") return `${entry.sourceName} [ui]`;
    return entry.sourceName;
  }
  return entry.source;
};

/**
 * Get the display color for a log entry's source label.
 * Host logs get green (#7EE787), MCP/UI logs get a palette color.
 */
const getSourceColor = (entry: LogEntry): string | undefined => {
  if (entry.source === "host") return "#7EE787";
  if ((entry.source === "mcp" || entry.source === "ui") && entry.sourceName) {
    return getMcpColor(entry.sourceName);
  }
  return undefined;
};

/**
 * Format timestamp with milliseconds (HH:MM:SS.mmm).
 * Matches the DevConsole's timestamp format for consistency.
 */
const formatTimestamp = (isoString: string): string => {
  const d = new Date(isoString);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
};

/**
 * Generate a short preview for a JSON object.
 * Arrays show "Array(N)", objects show first 2 keys with ellipsis.
 */
const getJSONPreview = (obj: unknown): string => {
  if (Array.isArray(obj)) return `Array(${obj.length})`;
  if (typeof obj === "object" && obj !== null) {
    const keys = Object.keys(obj);
    if (keys.length <= 2) return `{ ${keys.join(", ")} }`;
    return `{ ${keys.slice(0, 2).join(", ")}, ... }`;
  }
  return String(obj);
};

/**
 * Recursively build syntax-highlighted JSX for a JSON value.
 * Uses the same color scheme as the DevConsole:
 *   keys: #79C0FF, strings: #A5D6FF, numbers: #FFA657,
 *   booleans: #FF7B72, null: #8B949E
 */
const HighlightedJSON = memo(({ value, indent = 0 }: { value: unknown; indent?: number }) => {
  const spaces = "  ".repeat(indent);
  const innerSpaces = "  ".repeat(indent + 1);

  if (value === null) return <span style={{ color: "#8B949E" }}>null</span>;
  if (typeof value === "boolean") return <span style={{ color: "#FF7B72" }}>{String(value)}</span>;
  if (typeof value === "number") return <span style={{ color: "#FFA657" }}>{String(value)}</span>;
  if (typeof value === "string") return <span style={{ color: "#A5D6FF" }}>"{value}"</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <>{"[]"}</>;
    return (
      <>
        {"[\n"}
        {value.map((item, i) => (
          <span key={i}>
            {innerSpaces}
            <HighlightedJSON value={item} indent={indent + 1} />
            {i < value.length - 1 ? ",\n" : "\n"}
          </span>
        ))}
        {spaces}{"]"}
      </>
    );
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return <>{"{}"}  </>;
    return (
      <>
        {"{\n"}
        {keys.map((key, i) => (
          <span key={key}>
            {innerSpaces}
            <span style={{ color: "#79C0FF" }}>"{key}"</span>
            {": "}
            <HighlightedJSON value={(value as Record<string, unknown>)[key]} indent={indent + 1} />
            {i < keys.length - 1 ? ",\n" : "\n"}
          </span>
        ))}
        {spaces}{"}"}
      </>
    );
  }

  return <>{String(value)}</>;
});

/**
 * Collapsible JSON viewer with preview toggle, copy button, and
 * syntax-highlighted expanded content. Matches the DevConsole's
 * collapsible JSON behavior and styling.
 */
const CollapsibleJSON = memo(({
  json,
  isExpanded,
  onToggle,
}: {
  json: unknown;
  isExpanded: boolean;
  onToggle: () => void;
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(JSON.stringify(json, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [json]);

  return (
    <span className="inline-flex flex-wrap items-center gap-0.5" style={{ maxWidth: "100%" }}>
      <span
        onClick={onToggle}
        className="inline-flex items-center gap-1 cursor-pointer select-none rounded-sm px-1.5 transition-colors hover:bg-bg-secondary"
        style={{ color: "var(--txt-tertiary)", border: "1px solid var(--bdr-secondary)", fontSize: "11px" }}
      >
        <span
          className="inline-block transition-transform duration-150"
          style={{ transform: isExpanded ? "rotate(90deg)" : "none" }}
        >
          ▶
        </span>
        {getJSONPreview(json)}
      </span>
      <span
        onClick={handleCopy}
        className="inline-flex items-center justify-center cursor-pointer rounded-sm transition-colors hover:bg-bg-secondary"
        style={{
          width: 20,
          height: 20,
          marginLeft: 4,
          border: `1px solid ${copied ? "#7EE787" : "var(--bdr-secondary)"}`,
          color: copied ? "#7EE787" : "var(--txt-tertiary)",
          fontSize: 12,
        }}
        title="Copy JSON"
      >
        {copied ? (
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 256 256" fill="currentColor">
            <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 256 256" fill="currentColor">
            <path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z" />
          </svg>
        )}
      </span>
      {isExpanded && (
        <pre
          className="mt-1 p-2 rounded-sm overflow-y-auto overflow-x-hidden"
          style={{
            width: "100%",
            flexBasis: "100%",
            border: "1px solid var(--bdr-secondary)",
            fontFamily: "'SF Mono', Monaco, Inconsolata, 'Fira Mono', monospace",
            fontSize: "11px",
            lineHeight: 1.4,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 300,
            margin: 0,
          }}
        >
          <HighlightedJSON value={json} />
        </pre>
      )}
    </span>
  );
});

/**
 * A single log entry row matching the DevConsole's look and feel.
 * Features colored log levels, MCP source colors, collapsible JSON
 * with preview/syntax-highlighting, and copy support.
 */
const LogRow = memo(({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: LogEntry;
  isExpanded: boolean;
  onToggle: () => void;
}) => {
  const time = formatTimestamp(entry.timestamp);
  const jsonContent = tryParseJSON(entry.message);
  const sourceLabel = getSourceDisplay(entry);
  const sourceColor = getSourceColor(entry);
  const levelColor = LOG_LEVEL_COLORS[entry.level] || "#ABABAB";

  return (
    <div
      className="flex items-start gap-1.5 py-0.5 px-3 transition-colors hover:bg-bg-secondary"
      style={{ fontFamily: "'SF Mono', Monaco, Inconsolata, 'Fira Mono', monospace", fontSize: "12px" }}
    >
      <span className="shrink-0 whitespace-nowrap" style={{ color: "var(--txt-tertiary)" }}>
        {time}
      </span>
      <span
        className="shrink-0 whitespace-nowrap uppercase"
        style={{ color: levelColor, fontWeight: 600, fontSize: "11px" }}
      >
        {entry.level}
      </span>
      <span
        className="shrink-0 whitespace-nowrap truncate"
        style={{ color: sourceColor, fontWeight: 600, fontSize: "11px", maxWidth: 120 }}
        title={sourceLabel}
      >
        {sourceLabel}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words" style={{ color: "var(--txt-primary)" }}>
        {jsonContent ? (
          <>
            {jsonContent.prefix && <span style={{ color: "var(--txt-primary)" }}>{jsonContent.prefix}</span>}
            <CollapsibleJSON json={jsonContent.json} isExpanded={isExpanded} onToggle={onToggle} />
            {jsonContent.suffix && <span style={{ color: "var(--txt-primary)" }}>{jsonContent.suffix}</span>}
          </>
        ) : (
          entry.message
        )}
      </span>
    </div>
  );
});

/**
 * Format a log entry as a single plain-text line for clipboard copy.
 * Matches the DevConsole's copy format: [time] [source] [level] message
 */
const formatLogForCopy = (entry: LogEntry): string => {
  const time = formatTimestamp(entry.timestamp);
  const source = getSourceDisplay(entry);
  return `[${time}] [${source}] [${entry.level}] ${entry.message}`;
};

/**
 * Copy dropdown for logs, matching the DevConsole's options.
 * Provides "Last 50", "Last 100", and "All" copy options.
 * Dropdown closes on selection or when clicking outside.
 */
const CopyLogsDropdown = ({ logs }: { logs: LogEntry[] }) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  /**
   * Close the dropdown when clicking outside of it.
   */
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [isOpen]);

  /**
   * Copy the specified number of log entries to clipboard.
   * "all" copies every entry; a number copies the last N entries.
   */
  const handleCopy = useCallback(
    ({ lineCount }: { lineCount: "all" | number }) => {
      const entries = lineCount === "all" ? logs : logs.slice(-lineCount);
      const text = entries.map(formatLogForCopy).join("\n");
      navigator.clipboard.writeText(text);
      setIsOpen(false);
    },
    [logs]
  );

  const options: { label: string; value: "all" | number }[] = [
    { label: "Last 50", value: 50 },
    { label: "Last 100", value: 100 },
    { label: "All", value: "all" },
  ];

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen); }}
        className="inline-flex items-center gap-0.5 text-[11px] text-txt-tertiary hover:text-txt-primary transition-colors cursor-pointer"
      >
        <span>Copy</span>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>
      {isOpen && (
        <div
          className="absolute right-0 top-full mt-1 py-0.5 rounded-sm border border-bdr-secondary bg-bg-primary z-10"
          style={{ minWidth: 80 }}
        >
          {options.map((opt) => (
            <button
              key={opt.label}
              onClick={(e) => { e.stopPropagation(); handleCopy({ lineCount: opt.value }); }}
              className="block w-full text-left px-2.5 py-1 text-[11px] text-txt-secondary hover:bg-bg-secondary hover:text-txt-primary cursor-pointer transition-colors"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Log viewer with virtualized scrolling.
 * Preserves scroll position and expanded state across data refreshes.
 */
const LogsView = ({
  data,
  isLoading,
  onRefresh,
}: {
  data: LogsData | null;
  isLoading: boolean;
  onRefresh: () => void;
}) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const logs = data?.logs ?? [];

  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    overscan: 10,
  });

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <Toolbar
        onRefresh={onRefresh}
        isLoading={isLoading}
        actions={logs.length > 0 ? <CopyLogsDropdown logs={logs} /> : undefined}
      >
        <span>{data?.filter === "errors" ? "Errors only" : data?.filter === "current_mcp_app" && data?.mcpName ? `MCP: ${data.mcpName}` : "All logs"}</span>
      </Toolbar>
      <div ref={parentRef} className="flex-1 overflow-y-auto min-h-0 py-1">
        {logs.length === 0 ? (
          <EmptyState message="No logs yet" />
        ) : (
          <div
            style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const entry = logs[virtualRow.index];
              return (
                <div
                  key={entry.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <LogRow
                    entry={entry}
                    isExpanded={expandedIds.has(entry.id)}
                    onToggle={() => toggleExpanded(entry.id)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <StatusBar>
        <span>{logs.length} entries</span>
        <span />
      </StatusBar>
    </div>
  );
};

// =============================================================================
// Conversation View
// =============================================================================

/**
 * Role color map for conversation message labels.
 * Uses the same inline-style approach as log level colors for consistency.
 */
const ROLE_COLORS: Record<string, string> = {
  user: "#58A6FF",
  assistant: "#7EE787",
  system: "#D29922",
  tool: "#D2A8FF",
};

/**
 * Count tool calls in a conversation message.
 * Handles both AI SDK v5 (tool-invocation) and v6 (dynamic-tool) formats.
 */
const countToolCalls = (msg: ConversationMessage): number => {
  if (!msg.parts || !Array.isArray(msg.parts)) return 0;
  let count = 0;
  for (const part of msg.parts) {
    if (part.type === "tool-invocation") count++;
    if (part.type === "dynamic-tool") count++;
    if (part.type && part.type.startsWith("tool-") && part.type !== "tool-invocation") count++;
  }
  return count;
};

/**
 * Generate a short preview string for a conversation message.
 * Shows tool call info when present, otherwise truncated text content.
 */
const getMessagePreview = (msg: ConversationMessage): string => {
  if (msg.parts && Array.isArray(msg.parts)) {
    const previews: string[] = [];
    let textPreview: string | null = null;
    let toolCount = 0;
    const toolNames: string[] = [];

    for (const part of msg.parts) {
      if (part.type === "text" && part.text && !textPreview) {
        const preview = part.text.substring(0, 60);
        textPreview = preview.length < part.text.length ? preview + "..." : preview;
      }
      if (part.type === "tool-invocation" && part.toolInvocation) {
        toolCount++;
        toolNames.push(part.toolInvocation.toolName);
      }
      if (part.type === "dynamic-tool" || (part.type && part.type.startsWith("tool-") && part.type !== "tool-invocation")) {
        toolCount++;
        const name = part.type === "dynamic-tool" ? part.toolName : part.type.substring(5);
        if (name) toolNames.push(name);
      }
    }

    if (toolCount > 0) {
      const toolInfo = toolNames.length <= 2
        ? toolNames.join(", ")
        : `${toolNames.slice(0, 2).join(", ")} +${toolCount - 2} more`;
      previews.push(`[${toolCount} tool${toolCount > 1 ? "s" : ""}: ${toolInfo}]`);
    }
    if (textPreview) previews.push(textPreview);
    if (previews.length > 0) return previews.join(" ");
    return `[${msg.parts.length} parts]`;
  }

  if (msg.content && typeof msg.content === "string") {
    const preview = msg.content.substring(0, 80);
    return preview.length < (msg.content as string).length ? preview + "..." : preview;
  }
  return "[No content]";
};

/**
 * Recursively render a JSON value as an interactive tree with expand/collapse
 * on objects and arrays. Primitive values are syntax-highlighted inline.
 * Matches the DevConsole's JSON color scheme:
 *   keys: #79C0FF, strings: #A5D6FF, numbers: #FFA657,
 *   booleans: #FF7B72, null: #8B949E
 */
const JSONTreeNode = ({
  value,
  indent = 0,
  defaultExpanded = false,
}: {
  value: unknown;
  indent?: number;
  defaultExpanded?: boolean;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const innerSpaces = "  ".repeat(indent + 1);
  const closingSpaces = "  ".repeat(indent);

  if (value === null) return <span style={{ color: "#8B949E" }}>null</span>;
  if (typeof value === "boolean") return <span style={{ color: "#FF7B72" }}>{String(value)}</span>;
  if (typeof value === "number") return <span style={{ color: "#FFA657" }}>{String(value)}</span>;

  if (typeof value === "string") {
    // Long strings get a truncated preview when in a tree context
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return <span style={{ color: "#A5D6FF" }}>"{escaped}"</span>;
  }

  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const openBrace = isArray ? "[" : "{";
  const closeBrace = isArray ? "]" : "}";

  if (entries.length === 0) return <>{openBrace}{closeBrace}</>;

  // Preview: Array(N) or { key1, key2, ... }
  const preview = isArray
    ? `Array(${entries.length})`
    : entries.length <= 2
      ? `{ ${entries.map(([k]) => k).join(", ")} }`
      : `{ ${entries.slice(0, 2).map(([k]) => k).join(", ")}, … }`;

  if (!expanded) {
    return (
      <span
        onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
        className="cursor-pointer select-none"
      >
        <span style={{ color: "var(--txt-tertiary)" }}>▶ </span>
        <span style={{ color: "var(--txt-tertiary)" }}>{preview}</span>
      </span>
    );
  }

  return (
    <>
      <span
        onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
        className="cursor-pointer select-none"
        style={{ color: "var(--txt-tertiary)" }}
      >
        ▼{" "}
      </span>
      {openBrace + "\n"}
      {entries.map(([key, val], i) => (
        <span key={key + i}>
          {innerSpaces}
          {!isArray && (
            <>
              <span style={{ color: "#79C0FF" }}>"{key}"</span>
              {": "}
            </>
          )}
          <JSONTreeNode value={val} indent={indent + 1} />
          {i < entries.length - 1 ? ",\n" : "\n"}
        </span>
      ))}
      {closingSpaces}{closeBrace}
    </>
  );
};

/**
 * A single conversation message row matching the log viewer's look and feel.
 * Collapsed: shows role label, tool count, message ID, and preview.
 * Expanded: shows syntax-highlighted, interactive JSON tree with
 * collapsible nested objects/arrays and a copy button.
 */
const MessageRow = memo(({
  message,
  index,
  isExpanded,
  onToggle,
}: {
  message: ConversationMessage;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
}) => {
  const [copied, setCopied] = useState(false);
  const role = message.role || "unknown";
  const toolCount = countToolCalls(message);
  const preview = getMessagePreview(message);
  const msgId = message.id || `msg-${index}`;
  const roleColor = ROLE_COLORS[role] || "#ABABAB";

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(JSON.stringify(message, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [message]);

  return (
    <div>
      <div
        className="flex items-center gap-1.5 px-3 py-0.5 hover:bg-bg-secondary transition-colors cursor-pointer"
        style={{ fontFamily: "'SF Mono', Monaco, Inconsolata, 'Fira Mono', monospace", fontSize: "12px" }}
        onClick={onToggle}
      >
        <span
          className="shrink-0 whitespace-nowrap uppercase"
          style={{ color: roleColor, fontWeight: 600, fontSize: "11px" }}
        >
          {role}
        </span>
        {toolCount > 0 && (
          <span
            className="shrink-0 whitespace-nowrap"
            style={{ color: "#D2A8FF", fontWeight: 600, fontSize: "11px" }}
          >
            {toolCount} tool{toolCount > 1 ? "s" : ""}
          </span>
        )}
        <span className="shrink-0 whitespace-nowrap" style={{ color: "var(--txt-tertiary)", fontSize: "11px" }}>
          {msgId}
        </span>
        <span className="truncate min-w-0 flex-1" style={{ color: "var(--txt-secondary)" }}>
          {preview}
        </span>
        <span className="shrink-0" style={{ color: "var(--txt-tertiary)", fontSize: "10px" }}>
          {isExpanded ? "▼" : "▶"}
        </span>
      </div>
      {isExpanded && (
        <div className="mx-3 my-1">
          <div className="flex items-center gap-1 mb-1">
            <span
              onClick={handleCopy}
              className="inline-flex items-center justify-center cursor-pointer rounded-sm transition-colors hover:bg-bg-secondary"
              style={{
                width: 20,
                height: 20,
                border: `1px solid ${copied ? "#7EE787" : "var(--bdr-secondary)"}`,
                color: copied ? "#7EE787" : "var(--txt-tertiary)",
                fontSize: 12,
              }}
              title="Copy message JSON"
            >
              {copied ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 256 256" fill="currentColor">
                  <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 256 256" fill="currentColor">
                  <path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z" />
                </svg>
              )}
            </span>
          </div>
          <pre
            className="p-2 rounded-sm overflow-y-auto overflow-x-hidden"
            style={{
              border: "1px solid var(--bdr-secondary)",
              fontFamily: "'SF Mono', Monaco, Inconsolata, 'Fira Mono', monospace",
              fontSize: "11px",
              lineHeight: 1.4,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 400,
              margin: 0,
            }}
          >
            <JSONTreeNode value={message} defaultExpanded />
          </pre>
        </div>
      )}
    </div>
  );
});

/**
 * Conversation history viewer with virtualized scrolling.
 * Preserves scroll position and expanded state across data refreshes.
 */
const ConversationView = ({
  data,
  isLoading,
  onRefresh,
}: {
  data: ConversationData | null;
  isLoading: boolean;
  onRefresh: () => void;
}) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const messages = data?.messages ?? [];

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 10,
  });

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCopy = useCallback(() => {
    if (messages.length > 0) {
      navigator.clipboard.writeText(JSON.stringify(messages, null, 2));
    }
  }, [messages]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <Toolbar
        onRefresh={onRefresh}
        isLoading={isLoading}
        actions={messages.length > 0 ? (
          <button
            onClick={handleCopy}
            className="text-[11px] text-txt-tertiary hover:text-txt-primary transition-colors cursor-pointer"
          >
            Copy
          </button>
        ) : undefined}
      />
      <div ref={parentRef} className="flex-1 overflow-y-auto min-h-0 py-1">
        {messages.length === 0 ? (
          <EmptyState message="No conversation history" />
        ) : (
          <div
            style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const msg = messages[virtualRow.index];
              const msgId = msg.id || `msg-${virtualRow.index}`;
              return (
                <div
                  key={msgId}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <MessageRow
                    message={msg}
                    index={virtualRow.index}
                    isExpanded={expandedIds.has(msgId)}
                    onToggle={() => toggleExpanded(msgId)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <StatusBar>
        <span>{messages.length} messages</span>
        <span />
      </StatusBar>
    </div>
  );
};

// =============================================================================
// System Prompt View
// =============================================================================

/**
 * System prompt viewer.
 * Read-only text display with character count and copy button.
 * No virtualization needed since this is a single text block.
 */
const PromptView = ({
  data,
  isLoading,
  onRefresh,
}: {
  data: PromptData | null;
  isLoading: boolean;
  onRefresh: () => void;
}) => {
  const prompt = data?.prompt ?? "";
  const hasPrompt = prompt && !prompt.startsWith("(No active session");

  const handleCopy = useCallback(() => {
    if (hasPrompt) navigator.clipboard.writeText(prompt);
  }, [prompt, hasPrompt]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <Toolbar
        onRefresh={onRefresh}
        isLoading={isLoading}
        actions={hasPrompt ? (
          <button
            onClick={handleCopy}
            className="text-[11px] text-txt-tertiary hover:text-txt-primary transition-colors cursor-pointer"
          >
            Copy
          </button>
        ) : undefined}
      />
      <div className="flex-1 overflow-y-auto min-h-0">
        {!hasPrompt ? (
          <EmptyState message="No system prompt available" />
        ) : (
          <pre className="px-3 py-2 text-xs font-mono text-txt-secondary whitespace-pre-wrap break-words">
            {prompt}
          </pre>
        )}
      </div>
      <StatusBar>
        <span>{hasPrompt ? `${prompt.length} characters` : ""}</span>
        <span />
      </StatusBar>
    </div>
  );
};

// =============================================================================
// Shared
// =============================================================================

/**
 * Empty state placeholder shown when a tab has no data.
 */
const EmptyState = ({ message }: { message: string }) => (
  <div className="flex items-center justify-center h-full text-txt-tertiary text-sm">
    {message}
  </div>
);

/**
 * Try to extract a JSON object from a log message string.
 * Returns the parsed JSON and surrounding text, or null if no JSON found.
 */
const tryParseJSON = (message: string): { prefix: string; json: unknown; suffix: string } | null => {
  try {
    const parsed = JSON.parse(message);
    if (typeof parsed === "object" && parsed !== null) {
      return { prefix: "", json: parsed, suffix: "" };
    }
  } catch { /* not pure JSON */ }

  const jsonStart = message.indexOf("{");
  if (jsonStart === -1) return null;

  let depth = 0;
  let jsonEnd = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = jsonStart; i < message.length; i++) {
    const char = message[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (char === "\\" && inString) { escapeNext = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) { jsonEnd = i; break; }
    }
  }

  if (jsonEnd === -1) return null;

  const jsonStr = message.substring(jsonStart, jsonEnd + 1);
  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed === "object" && parsed !== null) {
      return {
        prefix: message.substring(0, jsonStart),
        json: parsed,
        suffix: message.substring(jsonEnd + 1),
      };
    }
  } catch { /* partial JSON, ignore */ }

  return null;
};

// =============================================================================
// Main App
// =============================================================================

/**
 * Devkit inner component.
 *
 * Manages tab state, data fetching, and routes tool results to the
 * appropriate tab's state. Data is fetched on-demand when tabs are
 * selected and via manual refresh.
 *
 * Tool results from both UI-initiated calls (callTool) and agent-initiated
 * calls flow through onToolResult, which updates the correct tab's data.
 */
const DevkitInner = () => {
  const { callTool, onToolResult, isReady } = useHost();
  const [activeTab, setActiveTab] = useState<TabId>("logs");

  // Data state per tab - persists across tab switches and refreshes
  const [logsData, setLogsData] = useState<LogsData | null>(null);
  const [conversationData, setConversationData] = useState<ConversationData | null>(null);
  const [promptData, setPromptData] = useState<PromptData | null>(null);
  const [loadingTabs, setLoadingTabs] = useState<Set<TabId>>(() => new Set());

  // Tool call functions from the SDK
  const [getLogs] = callTool("devkit_get_logs");
  const [getConversation] = callTool("devkit_get_conversation");
  const [getSystemPrompt] = callTool("devkit_get_system_prompt");

  // Track which tabs have been fetched at least once
  const fetchedTabsRef = useRef<Set<TabId>>(new Set());

  /**
   * Route incoming tool results to the correct tab's state.
   * Only processes UI-initiated results -- agent tool calls are ignored
   * so the agent cannot overwrite or disrupt the developer's view.
   */
  useEffect(() => {
    return onToolResult((result) => {
      if (result.source === "agent") return;
      const data = result.structuredContent as unknown as DevkitData;
      if (!data || typeof data !== "object" || !("type" in data)) return;

      switch (data.type) {
        case "logs":
          setLogsData(data as LogsData);
          setLoadingTabs((prev) => { const next = new Set(prev); next.delete("logs"); return next; });
          break;
        case "conversation":
          setConversationData(data as ConversationData);
          setLoadingTabs((prev) => { const next = new Set(prev); next.delete("conversation"); return next; });
          break;
        case "system_prompt":
          setPromptData(data as PromptData);
          setLoadingTabs((prev) => { const next = new Set(prev); next.delete("prompt"); return next; });
          break;
        case "refresh":
          // Refresh results go to logs tab as a status indicator
          setLoadingTabs((prev) => { const next = new Set(prev); next.delete("logs"); return next; });
          break;
      }
    });
  }, [onToolResult]);

  /**
   * Fetch data for a specific tab.
   * Sets loading state and calls the appropriate tool.
   */
  const fetchTab = useCallback((tab: TabId) => {
    setLoadingTabs((prev) => new Set(prev).add(tab));
    switch (tab) {
      case "logs": getLogs({}); break;
      case "conversation": getConversation({}); break;
      case "prompt": getSystemPrompt({}); break;
    }
  }, [getLogs, getConversation, getSystemPrompt]);

  /**
   * Fetch data when a tab is selected for the first time,
   * or when the SDK connection becomes ready.
   */
  useEffect(() => {
    if (!isReady) return;
    if (!fetchedTabsRef.current.has(activeTab)) {
      fetchedTabsRef.current.add(activeTab);
      fetchTab(activeTab);
    }
  }, [activeTab, isReady, fetchTab]);

  /**
   * Handle tab change.
   * Switches the active tab and fetches data if not yet loaded.
   */
  const handleTabChange = useCallback((tab: TabId) => {
    setActiveTab(tab);
  }, []);

  if (!isReady) {
    return (
      <div className="flex items-center justify-center h-full text-txt-tertiary text-sm">
        Connecting...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <TabBar activeTab={activeTab} onTabChange={handleTabChange} />
      <div className="flex-1 min-h-0 flex flex-col">
        {activeTab === "logs" && (
          <LogsView
            data={logsData}
            isLoading={loadingTabs.has("logs")}
            onRefresh={() => fetchTab("logs")}
          />
        )}
        {activeTab === "conversation" && (
          <ConversationView
            data={conversationData}
            isLoading={loadingTabs.has("conversation")}
            onRefresh={() => fetchTab("conversation")}
          />
        )}
        {activeTab === "prompt" && (
          <PromptView
            data={promptData}
            isLoading={loadingTabs.has("prompt")}
            onRefresh={() => fetchTab("prompt")}
          />
        )}
      </div>
    </div>
  );
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
