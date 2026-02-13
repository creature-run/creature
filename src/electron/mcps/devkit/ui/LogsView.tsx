/**
 * Logs View
 *
 * Real-time log viewer with virtualized scrolling, color-coded log levels,
 * MCP source colors, collapsible JSON with syntax highlighting, and copy support.
 */

import { useState, useRef, useCallback, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button, Text, Badge, Card, Menu } from "open-mcp-app-ui";
import { ChevronDown } from "lucide-react";
import { Toolbar, StatusBar, EmptyState } from "./shared.js";
import type { LogEntry, LogsData } from "./types.js";

// =============================================================================
// Constants & Helpers
// =============================================================================

/**
 * Map log levels to Badge semantic variants.
 * Groups levels by severity: debug/info are neutral, notice is informational,
 * warning is cautionary, error+ are danger states.
 */
const LOG_LEVEL_BADGE_VARIANTS: Record<string, "secondary" | "info" | "warning" | "danger"> = {
  debug: "secondary",
  info: "secondary",
  notice: "info",
  warning: "warning",
  error: "danger",
  critical: "danger",
  alert: "danger",
  emergency: "danger",
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
// JSON Components
// =============================================================================

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
        className="inline-flex items-center gap-1 cursor-pointer select-none rounded-sm px-1.5 transition-colors hover:bg-bg-secondary text-txt-tertiary border border-bdr-secondary text-[11px]"
      >
        <span
          className="inline-block transition-transform duration-150"
          style={{ transform: isExpanded ? "rotate(90deg)" : "none" }}
        >
          ▶
        </span>
        {getJSONPreview(json)}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        title="Copy JSON"
        className="!p-0.5 !text-[11px]"
        style={{
          width: 20,
          height: 20,
          marginLeft: 4,
          color: copied ? "var(--color-text-success)" : undefined,
        }}
      >
        {copied ? "✓" : "⎘"}
      </Button>
      {isExpanded && (
        <Card
          variant="default"
          padding="sm"
          className="mt-1 overflow-y-auto overflow-x-hidden"
          style={{
            width: "100%",
            flexBasis: "100%",
            maxHeight: 300,
          }}
        >
          <pre className="m-0 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words">
            <HighlightedJSON value={json} />
          </pre>
        </Card>
      )}
    </span>
  );
});

// =============================================================================
// Row Components
// =============================================================================

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

  return (
    <div
      className="flex items-start gap-1.5 py-0.5 px-3 transition-colors hover:bg-bg-secondary font-mono text-[12px]"
    >
      <Text variant="tertiary" as="span" className="shrink-0 whitespace-nowrap font-mono text-[12px]">
        {time}
      </Text>
      <Badge
        variant={LOG_LEVEL_BADGE_VARIANTS[entry.level] ?? "secondary"}
        className="shrink-0 uppercase font-mono !text-[10px] !py-0"
      >
        {entry.level}
      </Badge>
      <span
        className="shrink-0 whitespace-nowrap truncate"
        style={{ color: sourceColor, fontWeight: 600, fontSize: "11px", maxWidth: 120 }}
        title={sourceLabel}
      >
        {sourceLabel}
      </span>
      <Text variant="primary" as="span" className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px]">
        {jsonContent ? (
          <>
            {jsonContent.prefix && <span>{jsonContent.prefix}</span>}
            <CollapsibleJSON json={jsonContent.json} isExpanded={isExpanded} onToggle={onToggle} />
            {jsonContent.suffix && <span>{jsonContent.suffix}</span>}
          </>
        ) : (
          entry.message
        )}
      </Text>
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
 * Copy dropdown for logs, using the UI library's Menu component.
 * Provides "Last 50", "Last 100", and "All" copy options.
 */
const CopyLogsDropdown = ({ logs }: { logs: LogEntry[] }) => {
  /**
   * Copy the specified number of log entries to clipboard.
   * "all" copies every entry; a number copies the last N entries.
   */
  const handleCopy = useCallback(
    ({ lineCount }: { lineCount: "all" | number }) => {
      const entries = lineCount === "all" ? logs : logs.slice(-lineCount);
      const text = entries.map(formatLogForCopy).join("\n");
      navigator.clipboard.writeText(text);
    },
    [logs]
  );

  return (
    <Menu>
      <Menu.Trigger>
        <Button variant="ghost" size="sm" className="!text-xs !px-2 !py-0.5">
          Copy
          <ChevronDown size={10} />
        </Button>
      </Menu.Trigger>
      <Menu.Content align="end" minWidth={120}>
        <Menu.Item onSelect={() => handleCopy({ lineCount: 50 })}>Last 50</Menu.Item>
        <Menu.Item onSelect={() => handleCopy({ lineCount: 100 })}>Last 100</Menu.Item>
        <Menu.Item onSelect={() => handleCopy({ lineCount: "all" })}>All</Menu.Item>
      </Menu.Content>
    </Menu>
  );
};

// =============================================================================
// Main View
// =============================================================================

/**
 * Log viewer with virtualized scrolling.
 * Preserves scroll position and expanded state across data refreshes.
 */
export const LogsView = ({
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
    <div className="devkit-dark-panel flex flex-col flex-1 min-h-0">
      <Toolbar
        onRefresh={onRefresh}
        isLoading={isLoading}
        actions={logs.length > 0 ? <CopyLogsDropdown logs={logs} /> : undefined}
      >
        <Badge variant={data?.filter === "errors" ? "danger" : "secondary"}>
          {data?.filter === "errors" ? "Errors only" : data?.filter === "current_mcp_app" && data?.mcpName ? `MCP: ${data.mcpName}` : "All logs"}
        </Badge>
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
        <Text variant="tertiary" as="span" size="sm">{logs.length} entries</Text>
      </StatusBar>
    </div>
  );
};
