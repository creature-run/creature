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
 * Color-coded badge for log severity levels.
 * Maps each level to a consistent color for quick visual scanning.
 */
const LevelBadge = memo(({ level }: { level: string }) => {
  const colorMap: Record<string, string> = {
    debug: "text-txt-tertiary bg-bg-secondary",
    info: "text-blue-400 bg-blue-400/10",
    notice: "text-blue-400 bg-blue-400/10",
    warning: "text-yellow-400 bg-yellow-400/10",
    error: "text-red-400 bg-red-400/10",
    critical: "text-red-400 bg-red-400/10",
  };

  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 uppercase ${colorMap[level] || "text-txt-secondary bg-bg-secondary"}`}>
      {level.slice(0, 5)}
    </span>
  );
});

/**
 * A single log entry row with expandable JSON content.
 * Tracks expanded state via the parent's expandedIds set so state
 * persists across data refreshes without resetting.
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
  const time = new Date(entry.timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const jsonContent = tryParseJSON(entry.message);

  return (
    <div className="border-b border-bdr-secondary">
      <div
        className="flex items-start gap-2 px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors cursor-pointer"
        onClick={jsonContent ? onToggle : undefined}
      >
        <span className="text-txt-tertiary font-mono shrink-0">{time}</span>
        <LevelBadge level={entry.level} />
        {entry.sourceName && (
          <span className="text-txt-secondary font-mono shrink-0 max-w-[80px] truncate">
            {entry.sourceName}
          </span>
        )}
        <span className="text-txt-primary break-all whitespace-pre-wrap min-w-0 flex-1">
          {jsonContent ? jsonContent.prefix || entry.message.slice(0, 80) : entry.message}
        </span>
        {jsonContent && (
          <span className="text-txt-tertiary shrink-0 text-[10px]">
            {isExpanded ? "▼" : "▶"}
          </span>
        )}
      </div>
      {isExpanded && jsonContent && (
        <pre className="px-3 py-2 text-[11px] font-mono text-txt-secondary bg-bg-secondary/50 whitespace-pre-wrap break-all overflow-x-hidden">
          {jsonContent.prefix && <span className="text-txt-tertiary">{jsonContent.prefix}</span>}
          {JSON.stringify(jsonContent.json, null, 2)}
          {jsonContent.suffix && <span className="text-txt-tertiary">{jsonContent.suffix}</span>}
        </pre>
      )}
    </div>
  );
});

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
      <Toolbar onRefresh={onRefresh} isLoading={isLoading}>
        <span>{data?.filter === "errors" ? "Errors only" : data?.filter === "current_mcp_app" && data?.mcpName ? `MCP: ${data.mcpName}` : "All logs"}</span>
      </Toolbar>
      <div ref={parentRef} className="flex-1 overflow-y-auto min-h-0">
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
 * Role badge color for conversation messages.
 */
const roleBadgeClass = (role: string): string => {
  switch (role) {
    case "user": return "text-blue-400 bg-blue-400/10";
    case "assistant": return "text-green-400 bg-green-400/10";
    case "system": return "text-yellow-400 bg-yellow-400/10";
    case "tool": return "text-purple-400 bg-purple-400/10";
    default: return "text-txt-secondary bg-bg-secondary";
  }
};

/**
 * A single conversation message row.
 * Expandable: collapsed shows role + preview, expanded shows full JSON.
 * Uses memo and stable onToggle to avoid unnecessary re-renders.
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
  const role = message.role || "unknown";
  const toolCount = countToolCalls(message);
  const preview = getMessagePreview(message);
  const msgId = message.id || `msg-${index}`;

  return (
    <div className="border-b border-bdr-secondary">
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-bg-secondary transition-colors cursor-pointer"
        onClick={onToggle}
      >
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 uppercase ${roleBadgeClass(role)}`}>
          {role}
        </span>
        {toolCount > 0 && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 text-purple-400 bg-purple-400/10">
            {toolCount} tool{toolCount > 1 ? "s" : ""}
          </span>
        )}
        <span className="text-[10px] text-txt-tertiary font-mono shrink-0">{msgId}</span>
        <span className="text-txt-secondary truncate min-w-0 flex-1">{preview}</span>
        <span className="text-txt-tertiary shrink-0 text-[10px]">
          {isExpanded ? "▼" : "▶"}
        </span>
      </div>
      {isExpanded && (
        <pre className="px-3 py-2 text-[11px] font-mono text-txt-secondary bg-bg-secondary/50 whitespace-pre-wrap break-all overflow-x-hidden max-h-[400px] overflow-y-auto">
          {JSON.stringify(message, null, 2)}
        </pre>
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
      <div ref={parentRef} className="flex-1 overflow-y-auto min-h-0">
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
   * Works for both agent-initiated and UI-initiated tool calls.
   */
  useEffect(() => {
    return onToolResult((result) => {
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
