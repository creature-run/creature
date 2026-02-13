/**
 * MCP Devkit UI
 *
 * Tabbed developer toolkit with four views:
 * - Logs: Real-time log viewer from Creature's LogAggregator
 * - Conversation: Current conversation history inspector
 * - System Prompt: Current system prompt viewer
 * - UI Library: Live component demo and documentation
 *
 * Design principles:
 * - Read-only inspection tool (no mutations)
 * - Stable state across refreshes (no scroll reset, no expanded state reset)
 * - Virtualized lists for scalability with many rows
 * - Data fetched on-demand via callTool (pull model, not push)
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { HostProvider, useHost } from "open-mcp-app/react";
import { AppLayout, Text } from "open-mcp-app-ui";
import "open-mcp-app-ui/styles.css";
import "./styles.css";

import type { TabId, DevkitData, LogsData, ConversationData, PromptData } from "./types.js";
import { TabBar } from "./shared.js";
import { LogsView } from "./LogsView.js";
import { ConversationView } from "./ConversationView.js";
import { PromptView } from "./PromptView.js";
import { ComponentsView } from "./ComponentsView.js";

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
  const { callTool, onToolResult, isReady, hostContext } = useHost();
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
      <div className="flex items-center justify-center h-full">
        <Text variant="tertiary" size="sm">Connecting...</Text>
      </div>
    );
  }

  return (
    <AppLayout
      displayMode={hostContext?.displayMode}
      noPadding
      className="h-full bg-bg-primary text-txt-primary"
    >
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
        {activeTab === "components" && <ComponentsView />}
      </div>
    </AppLayout>
  );
};

/**
 * Root app component wrapped in HostProvider.
 */
const App = () => (
  <HostProvider name="devkit" version="0.1.0">
    <DevkitInner />
  </HostProvider>
);

export default App;
