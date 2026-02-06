import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  ReactNode,
} from "react";
import { toast } from "sonner";
import type { ResourceIcon } from "../shared/types";
import { widgetStateStore, makePipWidgetId } from "../lib/widgetStateStore";

export type { ResourceIcon };
export { toast };

/**
 * AppContext
 *
 * Centralized state management for the application.
 * Manages all business logic including:
 * - Panels: MCP panels (dynamic UIs from MCP servers)
 * - Session: Folder path, workspace context
 * - Auth: API key state
 * - UI: Modals and settings
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Pip type - currently only MCP pips are supported.
 */
export type PipType = "mcp";

/**
 * Pip interface for MCP pips.
 *
 * MCP Pips are dynamic UIs loaded from MCP servers via iframe.
 * - Have `htmlContent` with the cached HTML template
 * - Have `instanceId` for routing tool calls
 * - Have `resourceUri` to identify the UI Resource
 */
export interface Pip {
  /** Instance ID - the single identifier for this pip */
  instanceId: string;

  /** Type of pip - determines how it's rendered */
  pipType: PipType;

  /** Display title for the pip */
  title: string;

  /** URL for the pip content (unused for MCP pips, use htmlContent instead) */
  url: string;

  /** Timestamp when pip was created */
  createdAt: number;

  /**
   * UI Resource URI (e.g., "ui://my-server/dashboard").
   * Identifies which UI Resource template this pip renders.
   */
  resourceUri?: string;

  /**
   * HTML content for the pip (CSP already injected).
   * Loaded into iframe via srcdoc.
   */
  htmlContent?: string;

  /**
   * Custom icon from resource metadata (_meta.ui.icon).
   * Used for display in the sidebar tabs.
   */
  icon?: ResourceIcon;

  /**
   * Name of the MCP server that owns this pip.
   */
  mcpServer?: string;

  /**
   * Name of the tool that created this pip.
   * Used for icon selection in the sidebar.
   */
  toolName?: string;

  /**
   * Version counter for the pip content.
   * Incremented when MCP is restarted to force iframe reload.
   */
  refreshVersion?: number;

  /**
   * MCP-specific state for widget data.
   */
  state?: Record<string, unknown>;

  /**
   * Creature auth configuration from _meta.creature.auth.
   * When managed=true, host provides identity + token to the app.
   */
  creatureAuth?: {
    managed?: boolean;
  };

  /**
   * Whether pip was opened by a tool call (vs user action).
   * SDK uses this to determine initialization behavior.
   */
  triggeredByTool?: boolean;
  /**
   * Whether this pip should open in background when another pip is active.
   */
  openInBackground?: boolean;
}

interface PipsState {
  /** All registered pips */
  pips: Pip[];
  /** Ordered list of all pip IDs (determines tab order) */
  pipOrder: string[];
  /** ID of the currently active/visible pip in the tab view */
  activePipId: string | null;
  /** IDs of pips that have been popped out to separate windows */
  poppedOutPipIds: Set<string>;
}

/**
 * Local project structure.
 * Simplified from cloud version - no org_id, created_by, associated_package.
 */
interface ProjectWithValidation {
  id: string;
  name: string;
  profile: "playground" | "dev-general" | "dev-mcp";
  context: {
    local_directory?: { path: string };
    custom_instructions?: string;
  };
  mcps: Array<{
    name: string;
    transport?: "stdio" | "streamable-http";
    url?: string;
    headers?: Record<string, string>;
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    enabled: boolean;
  }>;
  sampling?: {
    approvalMode: "per_request" | "allowlist" | "allow_all";
    allowlist: string[];
  };
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  _localValidation?: {
    valid: boolean;
    error?: string;
  };
  /** Where the effective settings came from */
  _settingsSource?: "userData" | "local";
}

interface SessionState {
  /** Current session ID */
  sessionId: string;
  /** Current project (from local storage) */
  project: ProjectWithValidation | null;
  /** Selected folder path (derived from project.context.local_directory) */
  folderPath: string | null;
  /** Selected folder name (extracted from path) */
  folderName: string | null;
}

interface AuthState {
  /** Whether credentials are configured */
  hasApiKey: boolean;
  /** Whether auth is being checked */
  authChecking: boolean;
  /** Current provider type */
  providerType?: "anthropic" | "bedrock" | "vertex";
}

interface UIState {
  /** Whether project settings page is open */
  projectSettingsOpen: boolean;
  /** Whether app settings page is open */
  appSettingsOpen: boolean;
}

interface LayoutState {
  /** Total width allocated to the pips area when any pips are open */
  pipsWidth: number;
  /** Whether the pip area is visible (user can toggle this) */
  isPipAreaVisible: boolean;
}

interface AppContextValue {
  // Pips
  pips: PipsState;
  setActivePipId: (instanceId: string | null) => void;
  deletePip: (instanceId: string) => void;
  closeAllPips: () => Promise<void>;
  popoutPip: (params: {
    type: PipType;
    instanceId: string;
    title: string;
    theme: "dark" | "light";
    htmlContent: string;
    mcpServer: string;
    resourceUri?: string;
    /** MCP Apps spec style variables */
    styles: Record<string, string>;
  }) => void;
  reorderPips: (newOrder: string[]) => void;

  // Session
  session: SessionState;
  setSessionId: (sessionId: string) => void;
  setProject: (project: ProjectWithValidation | null) => void;

  // Auth
  auth: AuthState;

  // UI
  ui: UIState;
  setProjectSettingsOpen: (open: boolean) => void;
  setAppSettingsOpen: (open: boolean) => void;

  // Layout
  layout: LayoutState;
  setPipsWidth: (width: number) => void;
  togglePipArea: () => void;

  // Computed
  activePipCount: number;
}

// ============================================================================
// Context
// ============================================================================

const AppContext = createContext<AppContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface AppProviderProps {
  children: ReactNode;
}

/**
 * AppProvider Component
 *
 * Provides centralized state management for the application.
 * Manages panels, session, auth, and UI state with organized actions.
 */
export function AppProvider({ children }: AppProviderProps) {
  // -------------------------------------------------------------------------
  // Panels State
  // -------------------------------------------------------------------------

  const [pipsList, setPipsList] = useState<Pip[]>([]);
  const [pipOrder, setPipOrder] = useState<string[]>([]);
  const [activePipId, setActivePipIdState] = useState<string | null>(null);
  const [poppedOutPipIds, setPoppedOutPipIds] = useState<Set<string>>(
    new Set()
  );

  // -------------------------------------------------------------------------
  // Layout State
  // -------------------------------------------------------------------------

  const [pipsWidth, setPipsWidthState] = useState(400);
  const [isPipAreaVisible, setIsPipAreaVisible] = useState(false);

  // -------------------------------------------------------------------------
  // Session State
  // -------------------------------------------------------------------------

  const [sessionId, setSessionIdState] = useState("main-chat");
  const [project, setProjectState] = useState<ProjectWithValidation | null>(null);
  const [folderPath, setFolderPathState] = useState<string | null>(null);
  const [folderName, setFolderNameState] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Auth State
  // -------------------------------------------------------------------------

  const [hasApiKey, setHasApiKey] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [providerType, setProviderType] = useState<"anthropic" | "bedrock" | "vertex" | undefined>(undefined);

  // -------------------------------------------------------------------------
  // UI State
  // -------------------------------------------------------------------------

  const [projectSettingsOpen, setProjectSettingsOpenState] = useState(false);
  const [appSettingsOpen, setAppSettingsOpenState] = useState(false);

  // -------------------------------------------------------------------------
  // Pip Actions
  // -------------------------------------------------------------------------

  /**
   * Sets the active pip ID (the pip shown in the tab view).
   * If the pip is popped out, focuses that window instead.
   */
  const setActivePipId = useCallback(
    (instanceId: string | null) => {
      if (instanceId && poppedOutPipIds.has(instanceId)) {
        window.electronAPI.window.focusPopout(instanceId);
      } else {
        setActivePipIdState(instanceId);
      }
    },
    [poppedOutPipIds]
  );

  /**
   * Deletes a pip by notifying the Control Plane.
   *
   * State cleanup is handled by the `onPipClosed` listener when the
   * Control Plane confirms the pip is closed. This ensures the main
   * process is the single source of truth for pip lifecycle, preventing
   * race conditions from duplicate state updates.
   */
  const deletePip = useCallback(
    (instanceId: string) => {
      const pip = pipsList.find((p) => p.instanceId === instanceId);
      if (!pip) return;

      if (pip.pipType === "mcp") {
        window.electronAPI.controlPlane.closePip(instanceId).catch(console.error);
      }

      // State cleanup is handled by onPipClosed listener
      // This prevents duplicate state updates and race conditions
    },
    [pipsList]
  );

  /**
   * Closes all MCP pips for the current chat session context.
   * Used when switching between saved chat sessions.
   */
  const closeAllPips = useCallback(async () => {
    const mcpPips = pipsList.filter((p) => p.pipType === "mcp");
    if (mcpPips.length === 0) return;

    await Promise.all(
      mcpPips.map(async (pip) => {
        try {
          await window.electronAPI.controlPlane.closePip(pip.instanceId);
        } catch (error) {
          console.error("[AppContext] Failed to close pip:", pip.instanceId, error);
        }
      })
    );
  }, [pipsList]);

  /**
   * Pops out a pip to a separate window.
   * HTML content is injected via srcDoc per MCP Apps spec.
   * Pip metadata is passed to enable MCP Apps protocol in the popout.
   * If the popped pip was active, selects the next available pip.
   */
  const popoutPip = useCallback(
    ({
      type,
      instanceId,
      title,
      theme,
      htmlContent,
      mcpServer,
      resourceUri,
      styles,
    }: {
      type: PipType;
      instanceId: string;
      title: string;
      theme: "dark" | "light";
      htmlContent: string;
      mcpServer: string;
      resourceUri?: string;
      /** MCP Apps spec style variables */
      styles: Record<string, string>;
    }) => {
      window.electronAPI.window.popout({
        type,
        instanceId,
        title,
        theme,
        htmlContent,
        mcpServer,
        resourceUri,
        styles,
      });
      setPoppedOutPipIds((prev) => new Set([...prev, instanceId]));

      // If the popped pip was active, select the next available pip
      setActivePipIdState((currentActive) => {
        if (currentActive === instanceId) {
          // Find the next available pip that isn't popped out
          const availablePips = pipOrder.filter(
            (id) => id !== instanceId && !poppedOutPipIds.has(id)
          );
          return availablePips.length > 0 ? availablePips[0] : null;
        }
        return currentActive;
      });
    },
    [pipOrder, poppedOutPipIds]
  );

  /**
   * Reorders pips based on drag-and-drop.
   */
  const reorderPips = useCallback((newOrder: string[]) => {
    setPipOrder(newOrder);
  }, []);

  /**
   * Updates the active chat session ID.
   */
  const setSessionId = useCallback((nextSessionId: string) => {
    if (!nextSessionId) return;
    setSessionIdState(nextSessionId);
  }, []);

  // -------------------------------------------------------------------------
  // Session Actions
  // -------------------------------------------------------------------------

  /**
   * Sets the current project and updates folder state accordingly.
   * Called when a project is opened from the project picker.
   * When newProject is null (navigating to project list), closes all MCP connections.
   * Always resets project settings overlay to closed state when switching projects.
   */
  const setProject = useCallback(
    async (newProject: ProjectWithValidation | null) => {
      const previousProjectId = project?.id || null;
      const nextProjectId = newProject?.id || null;
      const projectChanged = previousProjectId !== nextProjectId;

      // Close MCP connections FIRST when leaving project (going to project list)
      // This must happen before deleting pips, otherwise pip cleanup tool calls
      // (like terminal_close) will trigger MCP re-initialization via getConnection()
      if (!newProject) {
        await window.electronAPI.mcp.closeAll();
      }

      if (projectChanged) {
        await closeAllPips();
        setSessionIdState("main-chat");
      }

      // Always close project settings when switching projects
      // New projects should start with the chat view visible
      setProjectSettingsOpenState(false);

      setProjectState(newProject);

      // Update folder path from project context
      const localPath = newProject?.context.local_directory?.path || null;
      const isValid = newProject?._localValidation?.valid !== false;
      const effectivePath = localPath && isValid ? localPath : null;

      setFolderPathState(effectivePath);
      const name = effectivePath
        ? effectivePath.split("/").pop() || null
        : null;
      setFolderNameState(name);
    },
    [closeAllPips, project?.id]
  );

  // -------------------------------------------------------------------------
  // UI Actions
  // -------------------------------------------------------------------------

  /**
   * Sets the project settings page open state.
   */
  const setProjectSettingsOpen = useCallback((open: boolean) => {
    setProjectSettingsOpenState(open);
  }, []);

  /**
   * Sets the app settings page open state.
   */
  const setAppSettingsOpen = useCallback((open: boolean) => {
    setAppSettingsOpenState(open);
  }, []);

  // -------------------------------------------------------------------------
  // Layout Actions
  // -------------------------------------------------------------------------

  /**
   * Sets the total width of the pips area.
   */
  const setPipsWidth = useCallback((width: number) => {
    setPipsWidthState(width);
  }, []);

  /**
   * Toggles the visibility of the pip area.
   * Allows users to show/hide the pip section even when no pips are open.
   */
  const togglePipArea = useCallback(() => {
    setIsPipAreaVisible((prev) => !prev);
  }, []);

  // -------------------------------------------------------------------------
  // Auth Effects
  // -------------------------------------------------------------------------

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const state = await window.electronAPI.auth.getState();
        setHasApiKey(state.hasApiKey);
        setProviderType(state.providerType);
      } catch (error) {
        console.error("Failed to check auth:", error);
        setHasApiKey(false);
        setProviderType(undefined);
      } finally {
        setAuthChecking(false);
      }
    };

    checkAuth();
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI.window.onPopoutClosed(({ instanceId, widgetState }) => {
      // Sync widget state from popout to local store BEFORE updating React state.
      // This ensures PipBrowser/PipMcp have the correct state when they re-render.
      if (widgetState) {
        const widgetId = makePipWidgetId({ conversationId: sessionId, instanceId });
        widgetStateStore.set(widgetId, widgetState, {
          mcpServerName: "",
          resourceUri: "",
          instanceId,
          conversationId: sessionId,
        });
      }

      setPoppedOutPipIds((prev) => {
        const next = new Set(prev);
        next.delete(instanceId);
        return next;
      });
      // When a popout is closed, make it the active pip if no pip is active
      setActivePipIdState((currentActive) => {
        if (!currentActive) {
          return instanceId;
        }
        return currentActive;
      });
    });

    return unsubscribe;
  }, [sessionId]);

  useEffect(() => {
    // Listen for pip creation from Control Plane
    const unsubCreated = window.electronAPI.controlPlane.onPipCreated((cpPip) => {
      console.log("[AppContext] Pip created:", cpPip.instanceId);

      const pip: Pip = {
        instanceId: cpPip.instanceId,
        pipType: "mcp",
        title: cpPip.title,
        url: "",
        createdAt: cpPip.createdAt,
        resourceUri: cpPip.resourceUri,
        htmlContent: cpPip.htmlContent,
        icon: cpPip.icon,
        mcpServer: cpPip.mcpServer,
        toolName: cpPip.toolName,
        creatureAuth: cpPip.creatureAuth,
        triggeredByTool: cpPip.triggeredByTool,
        openInBackground: cpPip.openInBackground,
      };

      setPipsList((prev) => [...prev, pip]);
      setPipOrder((prev) => [...prev, pip.instanceId]);
      setActivePipIdState((currentActive) => {
        if (cpPip.triggeredByTool === true && cpPip.openInBackground === true && currentActive) {
          return currentActive;
        }
        return pip.instanceId;
      });
      // Auto-show pip area when a pip is created
      // Width is dynamically calculated in App.tsx based on window size
      setIsPipAreaVisible(true);
    });

    // Listen for pip closure from Control Plane
    const unsubClosed = window.electronAPI.controlPlane.onPipClosed((instanceId) => {
      console.log("[AppContext] Pip closed:", instanceId);

      // Clean up widget state for the closed pip
      const widgetId = makePipWidgetId({ conversationId: sessionId, instanceId });
      widgetStateStore.delete(widgetId);

      setPipsList((prev) => {
        const newList = prev.filter((p) => p.instanceId !== instanceId);
        // Hide pip area immediately when last pip is closed
        if (newList.length === 0) {
          setIsPipAreaVisible(false);
        }
        return newList;
      });
      setPoppedOutPipIds((prev) => {
        const next = new Set(prev);
        next.delete(instanceId);
        return next;
      });
      setPipOrder((prev) => {
        const newOrder = prev.filter((id) => id !== instanceId);
        // If the closed pip was active, select the next available pip
        setActivePipIdState((currentActive) => {
          if (currentActive === instanceId) {
            // Find the first pip that isn't popped out
            const availablePip = newOrder.find((id) => !poppedOutPipIds.has(id));
            return availablePip || null;
          }
          return currentActive;
        });
        return newOrder;
      });
    });

    const unsubRefresh = window.electronAPI.controlPlane.onPipRefresh(({ instanceId, htmlContent, icon }) => {
      console.log("[AppContext] Pip refresh received:", instanceId, "html length:", htmlContent?.length || 0);

      setPipsList((prev) =>
        prev.map((p) =>
          p.instanceId === instanceId
            ? { ...p, htmlContent, icon, refreshVersion: (p.refreshVersion ?? 0) + 1 }
            : p
        )
      );
    });

    // Listen for pip title changes from Control Plane.
    // MCPs can return a `title` field in structuredContent to update the pip title.
    const unsubTitleChanged = window.electronAPI.controlPlane.onPipTitleChanged(({ instanceId, title }) => {
      console.log("[AppContext] Pip title changed:", instanceId, "->", title);

      setPipsList((prev) =>
        prev.map((p) =>
          p.instanceId === instanceId
            ? { ...p, title }
            : p
        )
      );
    });

    return () => {
      unsubCreated();
      unsubClosed();
      unsubRefresh();
      unsubTitleChanged();
    };
  }, [sessionId, poppedOutPipIds]);

  // -------------------------------------------------------------------------
  // Computed Values
  // -------------------------------------------------------------------------

  /**
   * Count of pips available in the tab bar (not popped out).
   * Used by App.tsx to determine if pip area should be shown.
   */
  const activePipCount = useMemo(() => {
    return pipsList.filter((p) => !poppedOutPipIds.has(p.instanceId)).length;
  }, [pipsList, poppedOutPipIds]);

  // -------------------------------------------------------------------------
  // Context Value
  // -------------------------------------------------------------------------

  const value: AppContextValue = {
    // Pips
    pips: {
      pips: pipsList,
      pipOrder,
      activePipId,
      poppedOutPipIds,
    },
    setActivePipId,
    deletePip,
    closeAllPips,
    popoutPip,
    reorderPips,

    // Session
    session: {
      sessionId,
      project,
      folderPath,
      folderName,
    },
    setSessionId,
    setProject,

    // Auth
    auth: {
      hasApiKey,
      authChecking,
      providerType,
    },

    // UI
    ui: {
      projectSettingsOpen,
      appSettingsOpen,
    },
    setProjectSettingsOpen,
    setAppSettingsOpen,

    // Layout
    layout: {
      pipsWidth,
      isPipAreaVisible,
    },
    setPipsWidth,
    togglePipArea,

    // Computed
    activePipCount,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook to access the app context.
 * Must be used within an AppProvider.
 */
export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return context;
}
