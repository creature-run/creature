import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { PipMcpContent } from "./PipMcp";
import { PipBrowser } from "./PipBrowser";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./DropdownMenu";
import { cn } from "../lib/utils";
import { useApp, Pip } from "../contexts/AppContext";
import { useTheme, ThemeColors } from "../contexts/ThemeContext";
import { validateIcon } from "../lib/iconUtils";
import { ArrowSquareOut, ArrowClockwise, X, DotsThreeVertical } from "@phosphor-icons/react";

// Re-export ThemeColors for use by pip components
export type { ThemeColors };

interface ViewPipsProps {
  /** Total width of the pips area */
  width: number;
  /** Callback when user resizes the pips area */
  onWidthChange: (width: number) => void;
  /**
   * Whether to render pip content (tabs and pips).
   * When false, only the container with left border is shown.
   * This prevents pips from receiving resize events during animation.
   */
  showContent: boolean;
  /**
   * Whether the pip area is visible.
   * When false, the container collapses to 0 width but stays mounted.
   * This preserves iframe state (WebSocket connections, webview references, etc.).
   */
  isVisible: boolean;
}

// ============================================================================
// PanelIcon Component
// ============================================================================

/**
 * PipIcon Component
 *
 * Renders a small icon for a pip in the tab.
 * Uses custom SVG icon if available, otherwise falls back to a generic square.
 */
const PipIcon = ({ pip, className }: { pip: Pip; className?: string }) => {
  const validatedIcon = useMemo(() => {
    return validateIcon(pip.icon);
  }, [pip.icon]);

  if (validatedIcon && validatedIcon.type === "svg") {
    return (
      <span
        className={cn("flex items-center justify-center [&>svg]:w-full [&>svg]:h-full", className)}
        role="img"
        aria-label={validatedIcon.alt || "Pip icon"}
        dangerouslySetInnerHTML={{ __html: validatedIcon.svg }}
      />
    );
  }

  // Default square icon
  return (
    <span className={cn("flex items-center justify-center", className)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-full h-full">
        <rect x="3" y="3" width="18" height="18" rx="2" />
      </svg>
    </span>
  );
};

// ============================================================================
// TabItem Component
// ============================================================================

interface TabItemProps {
  pip: Pip;
  isActive: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  onSelect: () => void;
  onClose: () => void;
  onPopout: () => void;
  onRefresh: () => void;
  canRefresh: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}

/**
 * TabItem Component
 *
 * Individual tab in the tab bar. Features:
 * - Icon on the left (small)
 * - Title (truncated if needed)
 * - Three-dot menu on the right with dropdown options
 * - Draggable for reordering
 */
const TabItem = ({
  pip,
  isActive,
  isDragging,
  isDragOver,
  onSelect,
  onClose,
  onPopout,
  onRefresh,
  canRefresh,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: TabItemProps) => {
  return (
    <div
      className={cn(
        "group flex items-center gap-2 pl-2 pr-0.5 cursor-pointer select-none flex-1",
        "transition-colors duration-150 min-w-[28px]",
        "border-r border-border-secondary",
        isActive
          ? "bg-background-primary text-text-primary -mb-px border-b-1 border-b-border-secondary"
          : "text-text-secondary hover:bg-background-secondary hover:text-text-primary",
        isDragging && "opacity-50",
        isDragOver && "bg-background-inverse/20 border-ring-primary"
      )}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onSelect}
    >
      {/* Pip icon - small, always visible */}
      <PipIcon pip={pip} className="w-2.5 h-2.5 shrink-0" />

      {/* Title - truncates and hides when space is tight, pushes dots to right */}
      <span className="text-[10px] truncate min-w-0 flex-1">{pip.title}</span>

      {/* Three-dot dropdown menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "w-3.5 h-3.5 flex items-center justify-center rounded transition-colors shrink-0",
              "text-text-secondary hover:text-text-primary hover:bg-background-secondary/50",
              "opacity-0 group-hover:opacity-100 focus:opacity-100",
              isActive && "opacity-100"
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <DotsThreeVertical size={14} weight="bold" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="bottom" className="text-xs min-w-[140px]">
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onPopout(); }} className="text-xs py-1">
            <ArrowSquareOut size={11} />
            <span>Open in New Window</span>
          </DropdownMenuItem>
          {canRefresh && (
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onRefresh(); }} className="text-xs py-1">
              <ArrowClockwise size={10} />
              <span>Refresh</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onClose(); }} className="text-xs py-1">
            <X size={11} />
            <span>Close</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

// ============================================================================
// ViewPips Component
// ============================================================================

/**
 * ViewPips Component
 *
 * Container that displays pips in a tabbed interface on the right side of the app.
 * Features:
 * - Tab bar at the top with browser-style tabs
 * - Only one pip visible at a time (the active tab)
 * - Drag-to-reorder tabs
 * - Pop out any pip to a separate window via dropdown menu
 * - Resize handle on left edge
 * - Pips stay mounted when hidden to preserve state (e.g., terminal sessions)
 */
export function ViewPips({ width, onWidthChange, showContent, isVisible }: ViewPipsProps) {
  const { pips, popoutPip, deletePip, reorderPips, setActivePipId } = useApp();

  // -------------------------------------------------------------------------
  // Build pip lists
  // -------------------------------------------------------------------------

  /**
   * All pips that should be shown in the tab bar (not popped out).
   * Ordered by pipOrder for correct tab display.
   */
  const tabbedPips: Pip[] = useMemo(() => {
    return pips.pipOrder
      .map((id) => pips.pips.find((p) => p.instanceId === id))
      .filter((p): p is Pip => !!p && !pips.poppedOutPipIds.has(p.instanceId));
  }, [pips.pips, pips.pipOrder, pips.poppedOutPipIds]);

  /**
   * All mounted pips (for keeping iframes alive).
   * Sorted by instanceId for stable DOM order.
   */
  const mountedPips: Pip[] = useMemo(() => {
    return pips.pips
      .filter((p) => !pips.poppedOutPipIds.has(p.instanceId))
      .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  }, [pips.pips, pips.poppedOutPipIds]);

  // -------------------------------------------------------------------------
  // Resize state for main area
  // -------------------------------------------------------------------------

  const [isResizing, setIsResizing] = useState(false);
  const [localWidth, setLocalWidth] = useState(width);
  const initialMouseX = useRef(0);
  const initialWidth = useRef(0);
  const currentWidthRef = useRef(width);

  // -------------------------------------------------------------------------
  // Drag-to-reorder state
  // -------------------------------------------------------------------------

  const [draggedPipId, setDraggedPipId] = useState<string | null>(null);
  const [dragOverPipId, setDragOverPipId] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Sync local width with prop
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (isResizing) return;
    setLocalWidth(width);
    currentWidthRef.current = width;
  }, [isResizing, width]);

  // -------------------------------------------------------------------------
  // Main area resize handlers
  // -------------------------------------------------------------------------

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      initialMouseX.current = e.clientX;
      initialWidth.current = localWidth;
      setIsResizing(true);
    },
    [localWidth]
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = initialMouseX.current - e.clientX;
      const newPanelWidth = initialWidth.current + delta;
      const clampedPanelWidth = Math.max(200, Math.min(newPanelWidth, window.innerWidth - 300));
      currentWidthRef.current = clampedPanelWidth;
      setLocalWidth(clampedPanelWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      onWidthChange(currentWidthRef.current);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, onWidthChange]);

  // -------------------------------------------------------------------------
  // Drag-to-reorder handlers
  // -------------------------------------------------------------------------

  /**
   * Initiates tab drag operation.
   */
  const handleDragStart = useCallback((e: React.DragEvent, pipId: string) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", pipId);
    setDraggedPipId(pipId);
  }, []);

  /**
   * Cleans up drag state when drag ends.
   */
  const handleDragEnd = useCallback(() => {
    setDraggedPipId(null);
    setDragOverPipId(null);
  }, []);

  /**
   * Tracks which tab the drag is hovering over.
   */
  const handleDragOver = useCallback((e: React.DragEvent, pipId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverPipId(pipId);
  }, []);

  /**
   * Clears hover state when drag leaves a tab.
   */
  const handleDragLeave = useCallback(() => {
    setDragOverPipId(null);
  }, []);

  /**
   * Handles tab drop to complete reordering.
   */
  const handleDrop = useCallback(
    (e: React.DragEvent, targetPipId: string) => {
      e.preventDefault();
      const sourcePipId = e.dataTransfer.getData("text/plain");

      if (sourcePipId && sourcePipId !== targetPipId) {
        const newOrder = [...pips.pipOrder];
        const sourceIndex = newOrder.indexOf(sourcePipId);
        const targetIndex = newOrder.indexOf(targetPipId);

        if (sourceIndex !== -1 && targetIndex !== -1) {
          newOrder.splice(sourceIndex, 1);
          newOrder.splice(targetIndex, 0, sourcePipId);
          reorderPips(newOrder);
        }
      }

      setDraggedPipId(null);
      setDragOverPipId(null);
    },
    [pips.pipOrder, reorderPips]
  );

  // -------------------------------------------------------------------------
  // Pip action handlers
  // -------------------------------------------------------------------------

  /**
   * Closes a pip permanently.
   */
  const handleClosePip = useCallback(
    (pip: Pip) => {
      deletePip(pip.instanceId);
    },
    [deletePip]
  );

  // Get current theme, colors, and spec style variables for pips and popouts
  const { isDarkMode, colors, specStyleVariables } = useTheme();
  const currentTheme = isDarkMode ? "dark" : "light";

  /**
   * Pops out a pip to a separate window.
   * Uses specStyleVariables from ThemeContext (popout window doesn't have globals.css loaded).
   */
  const handlePopoutPip = useCallback(
    (pip: Pip) => {
      if (!pip.htmlContent || !pip.instanceId || !pip.mcpServer) return;

      popoutPip({
        type: pip.pipType,
        instanceId: pip.instanceId,
        title: pip.title,
        theme: currentTheme,
        htmlContent: pip.htmlContent,
        mcpServer: pip.mcpServer,
        resourceUri: pip.resourceUri,
        styles: specStyleVariables as Record<string, string>,
      });
    },
    [popoutPip, currentTheme, specStyleVariables]
  );

  /**
   * Refreshes a pip's content.
   */
  const handleRefreshPip = useCallback((pip: Pip) => {
    if (pip.instanceId) {
      window.electronAPI.controlPlane.refreshSinglePip({ instanceId: pip.instanceId });
    }
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /**
   * Renders the content inside the pip container.
   * Only called when showContent is true to prevent pips from
   * receiving resize events during the slide animation.
   */
  const renderContent = () => {
    // If no tabbed pips exist, show empty state
    if (tabbedPips.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-text-secondary text-sm">No active apps</p>
        </div>
      );
    }

    return (
      <>
        {/* Tab bar */}
        <div className="flex items-stretch h-8 bg-background-primary border-b border-border-secondary shrink-0 overflow-hidden">
          {tabbedPips.map((pip) => (
            <TabItem
              key={pip.instanceId}
              pip={pip}
              isActive={pips.activePipId === pip.instanceId}
              isDragging={draggedPipId === pip.instanceId}
              isDragOver={dragOverPipId === pip.instanceId}
              onSelect={() => setActivePipId(pip.instanceId)}
              onClose={() => handleClosePip(pip)}
              onPopout={() => handlePopoutPip(pip)}
              onRefresh={() => handleRefreshPip(pip)}
              canRefresh={pip.pipType === "mcp" && !!pip.instanceId}
              onDragStart={(e) => handleDragStart(e, pip.instanceId)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, pip.instanceId)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, pip.instanceId)}
            />
          ))}
        </div>

        {/* Pip content area - render all mounted pips, hide non-active ones */}
        <div className="flex-1 min-h-0 overflow-hidden relative">
          {mountedPips.map((pip) => {
            const isVisible = pip.instanceId === pips.activePipId;

            return (
              <div
                key={pip.instanceId}
                className={cn(
                  "absolute inset-0",
                  isVisible ? "visible" : "invisible pointer-events-none"
                )}
              >
                {pip.pipType === "mcp" && (
                  /**
                   * DEVIATION FROM MCP APPS SPEC:
                   * Browser pips use PipBrowser which renders a native webview
                   * alongside the MCP App iframe. This is a Host-specific optimization
                   * for rendering quality. Only the "browser" MCP gets this treatment.
                   * All other MCPs use standard PipMcpContent (iframe only).
                   */
                  pip.mcpServer === "browser" ? (
                    <PipBrowser pip={pip} colors={colors} />
                  ) : (
                    <PipMcpContent pip={pip} colors={colors} />
                  )
                )}
              </div>
            );
          })}
        </div>
      </>
    );
  };

  return (
    <div
      className={cn(
        "relative flex flex-col h-full bg-background-primary overflow-hidden",
        "border-l border-border-secondary",
        isResizing && "select-none [&_iframe]:pointer-events-none [&_webview]:pointer-events-none",
        // Hide content when not visible but keep mounted
        !isVisible && "pointer-events-none"
      )}
      style={{ width: localWidth }}
    >
      {/* Resize handle - only interactive when content is shown and visible */}
      {showContent && isVisible && (
        <div
          className={cn(
            "absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize z-10 transition-colors",
            "hover:bg-background-inverse/50",
            isResizing && "bg-background-inverse"
          )}
          onMouseDown={handleMouseDown}
        />
      )}

      {/* Content is only rendered after animation completes */}
      {showContent && renderContent()}
    </div>
  );
}
