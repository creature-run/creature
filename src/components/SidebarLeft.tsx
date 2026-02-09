import * as React from "react";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./DropdownMenu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "./AlertDialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./Tooltip";
import { cn } from "../lib/utils";
import { useTheme } from "../contexts/ThemeContext";
import { useApp, type ResourceIcon } from "../contexts/AppContext";
import { Briefcase, Gear, SquaresFour } from "@phosphor-icons/react";
import { CreatureIcon } from "./CreatureIcon";
import { validateIcon } from "../lib/iconUtils";

/**
 * UI Resource info for sidebar display.
 */
interface UIResourceInfo {
  serverName: string;
  uri: string;
  name: string;
  icon?: ResourceIcon;
  /** Whether this resource belongs to a dev MCP (the app being developed) */
  _isDev?: boolean;
}

/**
 * SidebarButton Component
 *
 * Reusable button for the sidebar with consistent styling.
 * Uses forwardRef so it can be used as a Radix Dropdown trigger.
 * Spreads all props to support Radix UI's asChild pattern.
 */
const SidebarButton = React.forwardRef<HTMLButtonElement, {
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ active = false, disabled = false, title, onClick, children, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "p-2.5 flex items-center justify-center rounded-lg transition-all cursor-pointer bg-transparent",
          "[&_svg]:w-[22px] [&_svg]:h-[22px]",
          !active && "text-text-secondary opacity-50 hover:opacity-100 hover:text-text-primary",
          active && "text-text-primary opacity-100",
          disabled && "opacity-30 cursor-not-allowed"
        )}
        title={title}
        onClick={onClick}
        disabled={disabled}
        {...rest}
      >
        {children}
      </button>
    );
  }
);
SidebarButton.displayName = "SidebarButton";

/**
 * UIResourceIcon Component
 *
 * Renders a small icon for a UI resource in the sidebar.
 * Uses custom SVG icon if available, otherwise falls back to a Phosphor icon.
 */
const UIResourceIcon = ({ resource, className }: { resource: UIResourceInfo; className?: string }) => {
  const validatedIcon = useMemo(() => {
    return validateIcon(resource.icon);
  }, [resource.icon]);

  if (validatedIcon && validatedIcon.type === "svg") {
    return (
      <span
        className={cn("flex items-center justify-center [&>svg]:w-full [&>svg]:h-full", className)}
        role="img"
        aria-label={validatedIcon.alt || resource.name}
        dangerouslySetInnerHTML={{ __html: validatedIcon.svg }}
      />
    );
  }

  // Fallback to Phosphor SquaresFour icon
  return <SquaresFour className={className} weight="regular" />;
};

/**
 * SidebarLeft Component
 *
 * Displays a sidebar on the left with:
 * - Creature icon with dropdown menu (Projects, Theme toggle, Dev Console, Log Out)
 * - Chat button - shown when project is open
 * - Pip area toggle button - shown when project is open
 * - Project Settings button (gear icon) - shown when project is open
 * - MCP App icons - shown when project is open, below settings
 *
 * Pip-specific icons are now displayed in the tab bar, not here.
 */
export function SidebarLeft() {
  const { isDarkMode, toggleTheme } = useTheme();
  const { session, setProject, setProjectSettingsOpen, setAppSettingsOpen, layout, togglePipArea, ui, pips, setActivePipId } = useApp();
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [uiResources, setUIResources] = useState<UIResourceInfo[]>([]);

  // Only show action icons after a project is opened
  const hasProjectOpen = !!session.project;

  /**
   * Fetch UI resources when project opens or MCP restarts.
   */
  useEffect(() => {
    if (!hasProjectOpen) {
      setUIResources([]);
      return;
    }

    const fetchResources = async () => {
      try {
        const resources = await window.electronAPI.mcp.getUIResources();
        setUIResources(resources);
      } catch (error) {
        console.error("[Sidebar] Failed to fetch UI resources:", error);
      }
    };

    fetchResources();

    // Re-fetch when MCP restarts or is disabled
    const cleanupRestarted = window.electronAPI.mcp.onRestarted(() => {
      fetchResources();
    });
    const cleanupDisabled = window.electronAPI.mcp.onDisabled(() => {
      fetchResources();
    });

    return () => {
      cleanupRestarted();
      cleanupDisabled();
    };
  }, [hasProjectOpen]);

  /**
   * Tracks which project ID has had its dev MCP PIP auto-launched.
   * Prevents duplicate launches on resource refreshes or re-renders.
   */
  const devMcpAutoLaunchedRef = useRef<string | null>(null);

  /**
   * Reset auto-launch tracking when leaving a project,
   * so the PIP will auto-open again if the same project is re-opened.
   */
  useEffect(() => {
    if (!hasProjectOpen) {
      devMcpAutoLaunchedRef.current = null;
    }
  }, [hasProjectOpen]);

  /**
   * Auto-launch the dev MCP's PIP when a dev-mcp project opens.
   * Triggers once per project after a short delay to let the UI settle.
   *
   * Guard: only fires when exactly one dev MCP resource exists. Built-in
   * MCPs (ide, terminal, devkit) are excluded via the `_isDev` flag.
   * If the project has multiple dev MCP resources, we skip entirely
   * since we can't know which one the user wants foregrounded.
   */
  useEffect(() => {
    if (session.project?.profile !== "dev-mcp") return;
    if (devMcpAutoLaunchedRef.current === session.project.id) return;

    const devResources = uiResources.filter((r) => r._isDev);
    if (devResources.length !== 1) return;

    devMcpAutoLaunchedRef.current = session.project.id;

    const devResource = devResources[0];

    const timer = setTimeout(() => {
      if (!layout.isPipAreaVisible) {
        togglePipArea();
      }

      window.electronAPI.mcp.launchResourcePip(devResource.serverName, devResource.uri)
        .then((result) => {
          if (result.success && result.instanceId) {
            setActivePipId(result.instanceId);
          }
        })
        .catch((error) => {
          console.error("[Sidebar] Failed to auto-launch dev MCP pip:", error);
        });
    }, 2000);

    return () => clearTimeout(timer);
  }, [session.project?.profile, session.project?.id, uiResources, layout.isPipAreaVisible, togglePipArea, setActivePipId]);

  /**
   * Handle clicking a UI resource icon.
   * If a pip exists for this resource, focus it.
   * Otherwise, launch a new pip.
   * Always ensures the pip area is visible.
   */
  const handleResourceClick = useCallback(async (resource: UIResourceInfo) => {
    // Always ensure pip area is visible when clicking an app icon
    if (!layout.isPipAreaVisible) {
      togglePipArea();
    }

    // First check if we have an existing pip for this resource
    const existingPip = pips.pips.find(
      (p) => p.resourceUri === resource.uri && p.mcpServer === resource.serverName
    );

    if (existingPip) {
      // Focus the existing pip
      setActivePipId(existingPip.instanceId);
      return;
    }

    // No existing pip - launch a new one
    try {
      const result = await window.electronAPI.mcp.launchResourcePip(resource.serverName, resource.uri);
      if (result.success && result.instanceId) {
        // Set the new pip as active
        setActivePipId(result.instanceId);
      }
    } catch (error) {
      console.error("[Sidebar] Failed to launch resource pip:", error);
    }
  }, [pips.pips, setActivePipId, layout.isPipAreaVisible, togglePipArea]);

  /**
   * Handles clicking the Projects menu item.
   * Shows confirmation dialog if user is in an active project (ChatView),
   * otherwise navigates directly to projects list.
   */
  const handleProjectsClick = () => {
    if (hasProjectOpen) {
      setShowLeaveConfirm(true);
    } else {
      setProject(null);
    }
  };

  /**
   * Confirms leaving the current project.
   * Clears project state and navigates to projects list.
   */
  const handleConfirmLeave = () => {
    setProject(null);
    setShowLeaveConfirm(false);
  };

  /**
   * Opens the app settings view.
   */
  const handleOpenAppSettings = () => {
    setAppSettingsOpen(true);
  };

  return (
    <aside className="flex flex-col items-center w-[50px] shrink-0 pt-3 py-3 bg-background-primary border-r border-border-secondary">
      {/* Creature icon with dropdown menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="w-8 h-8 my-2 flex items-center justify-center cursor-pointer focus:outline-none"
            title="Menu"
          >
            <CreatureIcon isDarkMode={isDarkMode} showEyes={false} width={32} height={32} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem onClick={handleProjectsClick}>
            <Briefcase size={9} weight="regular" />
            <span>Projects</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={toggleTheme}>
            {isDarkMode ? (
              <>
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
                <span>Light Mode</span>
              </>
            ) : (
              <>
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
                <span>Dark Mode</span>
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => window.electronAPI.devConsole.openWindow()}>
            <svg
              width="9"
              height="9"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2 12h4l3-9 4 18 3-9h6" />
            </svg>
            <span>Dev Console</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleOpenAppSettings}>
            <Gear size={9} weight="regular" />
            <span>Org Settings</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Action icons only shown after a project is opened */}
      {hasProjectOpen && (
        <>
          {/* Divider between logo and action icons */}
          <div className="w-6 h-px bg-border-secondary my-3" />

          {/* MCP App icons */}
          {uiResources.length > 0 && (
            <TooltipProvider delayDuration={300}>
              {uiResources.map((resource) => (
                <Tooltip key={resource.uri}>
                  <TooltipTrigger asChild>
                    <SidebarButton
                      onClick={() => handleResourceClick(resource)}
                      active={false}
                    >
                      <UIResourceIcon resource={resource} className="w-[22px] h-[22px]" />
                    </SidebarButton>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {resource.serverName}
                  </TooltipContent>
                </Tooltip>
              ))}
            </TooltipProvider>
          )}

          {/* Project Settings button - always at the bottom */}
          <SidebarButton
            title="Project Settings"
            onClick={() => { setProjectSettingsOpen(!ui.projectSettingsOpen); }}
            active={ui.projectSettingsOpen}
          >
            <Gear weight="regular" />
          </SidebarButton>
        </>
      )}

      {/* Confirmation dialog when leaving an active project */}
      <AlertDialog open={showLeaveConfirm} onOpenChange={setShowLeaveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave current session?</AlertDialogTitle>
            <AlertDialogDescription>
              Your chat is saved automatically. Open tabs will be closed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmLeave}>Leave</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
