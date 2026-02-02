import { useCallback } from "react";
import { X, Circle } from "@phosphor-icons/react";

/**
 * Open file tab information.
 */
interface TabInfo {
  path: string;
  name: string;
  isModified: boolean;
  hasPendingDiff?: boolean;
}

interface TabBarProps {
  tabs: TabInfo[];
  activeTab: string | null;
  onTabSelect: (path: string) => void;
  onTabClose: (path: string) => void;
}

/**
 * TabBar Component
 *
 * Displays open file tabs above the editor.
 * Shows file name and modified indicator.
 * Allows switching between and closing tabs.
 */
export const TabBar = ({ tabs, activeTab, onTabSelect, onTabClose }: TabBarProps) => {
  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <Tab
          key={tab.path}
          tab={tab}
          isActive={tab.path === activeTab}
          onSelect={onTabSelect}
          onClose={onTabClose}
        />
      ))}
    </div>
  );
};

interface TabProps {
  tab: TabInfo;
  isActive: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

/**
 * Tab Component
 *
 * Individual tab with file name, modified indicator, and close button.
 */
const Tab = ({ tab, isActive, onSelect, onClose }: TabProps) => {
  const handleClick = useCallback(() => {
    onSelect(tab.path);
  }, [tab.path, onSelect]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose(tab.path);
    },
    [tab.path, onClose]
  );

  return (
    <div className={`tab ${isActive ? "active" : ""} ${tab.hasPendingDiff ? "has-diff" : ""}`} onClick={handleClick}>
      <span className="tab-name">
        {tab.hasPendingDiff ? (
          <span className="diff-indicator" title="Pending changes">
            ●
          </span>
        ) : tab.isModified ? (
          <span className="modified-indicator">
            <Circle size={8} weight="fill" />
          </span>
        ) : null}
        {tab.name}
      </span>
      <button className="tab-close" onClick={handleClose} title="Close">
        <X size={12} weight="bold" />
      </button>
    </div>
  );
};

export type { TabInfo };
