/**
 * Shared UI primitives used across multiple devkit views.
 *
 * TabBar, Toolbar, StatusBar, and EmptyState are generic layout
 * shells — each view fills them with its own content.
 */

import type { ReactNode } from "react";
import { Button, Text, Tabs } from "open-mcp-app-ui";
import type { TabId } from "./types.js";

// =============================================================================
// TabBar
// =============================================================================

/**
 * Tab bar for switching between views.
 * Uses the reusable Tabs component from the UI library.
 */
export const TabBar = ({
  activeTab,
  onTabChange,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}) => (
  <Tabs value={activeTab} onChange={(v) => onTabChange(v as TabId)} borderVariant="secondary">
    <Tabs.Tab value="logs">Logs</Tabs.Tab>
    <Tabs.Tab value="conversation">Conversation</Tabs.Tab>
    <Tabs.Tab value="prompt">System Prompt</Tabs.Tab>
    <Tabs.Tab value="components">UI Library</Tabs.Tab>
  </Tabs>
);

// =============================================================================
// Toolbar
// =============================================================================

/**
 * Toolbar with a refresh button and optional children on the left side.
 * Accepts an `actions` prop for buttons rendered to the left of the refresh button.
 * Shared across all tab views for consistent layout.
 */
export const Toolbar = ({
  onRefresh,
  isLoading,
  children,
  actions,
}: {
  onRefresh: () => void;
  isLoading: boolean;
  children?: ReactNode;
  actions?: ReactNode;
}) => (
  <div className="flex items-center justify-between px-3 py-1.5 shrink-0 border-b border-bdr-secondary">
    <div className="flex items-center gap-2 text-xs text-txt-secondary">
      {children}
    </div>
    <div className="flex items-center gap-2">
      {actions}
      <Button
        variant="ghost"
        size="sm"
        onClick={onRefresh}
        loading={isLoading}
        className="!text-xs !px-2 !py-0.5"
      >
        Refresh
      </Button>
    </div>
  </div>
);

// =============================================================================
// StatusBar
// =============================================================================

/**
 * Status bar at the bottom of each tab view.
 * Shows entry count and optional extra info.
 */
export const StatusBar = ({ children }: { children: ReactNode }) => (
  <div className="flex items-center justify-between px-3 py-1 text-[10px] text-txt-tertiary shrink-0 border-t border-bdr-secondary">
    {children}
  </div>
);

// =============================================================================
// EmptyState
// =============================================================================

/**
 * Empty state placeholder shown when a tab has no data.
 */
export const EmptyState = ({ message }: { message: string }) => (
  <div className="flex items-center justify-center h-full">
    <Text variant="tertiary" size="sm">{message}</Text>
  </div>
);
