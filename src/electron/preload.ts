import { contextBridge, ipcRenderer } from "electron";
import type { ResourceIcon, WidgetState } from "../shared/types";
import type { ProviderCredentials, ProviderType } from "../shared/credentials";
import type { SamplingEvent, SamplingResponse } from "./mcp/sampling";
import type { EmbeddingsCredentials, EmbeddingsProviderType } from "../shared/embeddings";

export type {
  ResourceIcon,
  WidgetState,
  ProviderCredentials,
  ProviderType,
  EmbeddingsCredentials,
  EmbeddingsProviderType,
};

export type LogLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";

/**
 * Log source type.
 */
export type LogSource = "host" | "mcp" | "ui";

/**
 * A log entry from the LogAggregator.
 */
export interface LogEntry {
  /** Unique ID for React keys */
  id: string;
  /** ISO timestamp */
  timestamp: string;
  /** Source category */
  source: LogSource;
  /** Specific source name (MCP server name or UI resource name) */
  sourceName?: string;
  /** Log severity level */
  level: LogLevel;
  /** The log message */
  message: string;
  /** Optional structured data */
  data?: unknown;
}

/**
 * Auth state for local-first mode.
 */
export interface AuthState {
  hasCredentials: boolean;
  providerType?: ProviderType;
  // Legacy compatibility
  hasApiKey: boolean;
}

export interface EmbeddingsState {
  hasCredentials: boolean;
  providerType?: EmbeddingsProviderType;
  model?: string;
}

export interface MCPServerConfigForRenderer {
  name: string;
  transport?: "stdio" | "streamable-http";
  url?: string;
  headers?: Record<string, string>;
  git?: { url: string; ref?: string; subdir?: string; setupCommand?: string; startCommand?: string; transport?: "stdio" | "streamable-http" };
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  scope?: "builtin" | "registry" | "custom" | "development";
  status?: "ok" | "error";
  lastError?: string;
}

/**
 * Project profile types.
 * Determines project behavior and customization.
 */
export type ProjectProfile = "playground" | "dev-general" | "dev-mcp";

/**
 * MCP configuration stored in a project.
 */
export interface ProjectMcpConfig {
  name: string;
  transport?: "stdio" | "streamable-http";
  url?: string;
  headers?: Record<string, string>;
  git?: { url: string; ref?: string; subdir?: string; setupCommand?: string; startCommand?: string; transport?: "stdio" | "streamable-http" };
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
}

/**
 * Local directory context.
 */
interface LocalDirectoryContext {
  path: string;
}

/**
 * Project context sources.
 */
export interface ProjectContext {
  local_directory?: LocalDirectoryContext;
  custom_instructions?: string;
}

export interface SamplingSettings {
  approvalMode: "per_request" | "allowlist" | "allow_all";
  allowlist: string[];
}

/**
 * Local project (no cloud fields).
 */
export interface Project {
  id: string;
  name: string;
  profile: ProjectProfile;
  context: ProjectContext;
  mcps: ProjectMcpConfig[];
  sampling?: SamplingSettings;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
}

/**
 * Project with local validation status.
 * Added client-side when loading projects.
 */
export interface ProjectWithValidation extends Project {
  _localValidation?: {
    valid: boolean;
    error?: string;
  };
  /** True if the project folder is managed by the app (in userData/projects) */
  _isAppManaged?: boolean;
}

/**
 * Pip Instance data sent from the Control Plane to the renderer.
 * Matches the new MCP Apps architecture.
 */
export interface McpPip {
  /** Instance ID - the single identifier for this pip */
  instanceId: string;
  resourceUri: string;
  htmlContent: string;
  /** Custom icon from resource metadata (_meta.ui.icon) */
  icon?: ResourceIcon;
  toolName: string;
  mcpServer: string;
  title: string;
  createdAt: number;
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

/**
 * Event emitted when a pip is destroyed (closed by user).
 * Used by ViewChat to inject a message into conversation history so the
 * agent knows the pip is no longer valid.
 */
export interface PipDestroyedEvent {
  /** Instance ID of the pip that was destroyed */
  instanceId: string;
  /** The resource URI of the pip */
  resourceUri: string;
  /** The MCP server (app) name that provided this tool */
  serverName: string;
  /** The tool that created the pip */
  toolName: string;
  /** Timestamp of destruction */
  timestamp: number;
}

/**
 * Event emitted when a new Pip Instance is created.
 * Used by ViewChat to inject into conversation history so the agent knows
 * about new pips and their instanceId.
 */
export interface PipCreatedEvent {
  /** Instance ID - the single identifier for this pip */
  instanceId: string;
  /** The resource URI of the pip */
  resourceUri: string;
  /** The MCP server (app) name that provides this tool */
  serverName: string;
  /** The tool that triggered pip creation */
  toolName: string;
  /** Timestamp of creation */
  timestamp: number;
}

/**
 * Style variables passed to the MCP App (MCP Apps spec CSS variable format).
 * Contains all 68+ spec-compliant CSS variables read from the main renderer's DOM.
 */
export type PopoutStyles = Record<string, string>;

/**
 * PopoutParams defines the pip information passed to popout windows.
 */
export interface PopoutParams {
  type: "mcp";
  instanceId: string;
  title: string;
  /** Current theme - "dark" or "light" */
  theme: "dark" | "light";
  /** HTML content for MCP pips - injected via srcDoc */
  htmlContent: string;
  /** MCP server name for tool calls */
  mcpServer: string;
  /** Resource URI for the pip (used for widget state metadata) */
  resourceUri?: string;
  /** MCP Apps spec style variables for theming */
  styles: PopoutStyles;
}

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld("electronAPI", {
  // App info
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  getPlatform: () => ipcRenderer.invoke("app:getPlatform"),

  // Shell utilities
  shell: {
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke("shell:openExternal", url),
  },

  // Folder selection
  selectFolder: () => ipcRenderer.invoke("dialog:selectFolder"),

  // File selection (restricted to project folder)
  selectFiles: (baseFolderPath: string) =>
    ipcRenderer.invoke("dialog:selectFiles", baseFolderPath),

  // Resolve file path relative to project folder
  resolveFilePath: (absolutePath: string, baseFolderPath: string) =>
    ipcRenderer.invoke("file:resolvePath", absolutePath, baseFolderPath),

  // Search files and folders in project folder (for @-mention autocomplete)
  searchFiles: (query: string, baseFolderPath: string) =>
    ipcRenderer.invoke("file:search", query, baseFolderPath) as Promise<{
      results: Array<{ path: string; type: "file" | "folder" }>;
      error?: string;
    }>,

  // Get current folder path (from active project)
  folder: {
    getCurrent: (): Promise<string | null> =>
      ipcRenderer.invoke("folder:getCurrent"),
  },

  // Chat server lifecycle (started when folder is opened)
  chat: {
    start: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("chat:start"),
    isRunning: (): Promise<{ running: boolean }> =>
      ipcRenderer.invoke("chat:isRunning"),
  },

  // Image upload for chat messages
  image: {
    upload: (filePathOrBuffer: string | { buffer: Uint8Array; filename: string }, projectId: string): Promise<{
      success: boolean;
      image?: {
        url: string;
        filename: string;
        size: number;
        contentType: string;
        localPath: string;
      };
      error?: string;
    }> => {
      if (typeof filePathOrBuffer === 'string') {
        return ipcRenderer.invoke("image:upload", { filePath: filePathOrBuffer, projectId });
      } else {
        return ipcRenderer.invoke("image:upload", {
          buffer: filePathOrBuffer.buffer,
          filename: filePathOrBuffer.filename,
          projectId
        });
      }
    },
  },

  // Auth (multi-provider credentials)
  auth: {
    getState: (): Promise<AuthState> => ipcRenderer.invoke("auth:getState"),
    saveCredentials: (credentials: ProviderCredentials): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("auth:saveCredentials", { credentials }),
    clearCredentials: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("auth:clearCredentials"),
    // Legacy compatibility
    saveApiKey: (apiKey: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("auth:saveApiKey", { apiKey }),
    clearApiKey: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("auth:clearApiKey"),
  },

  embeddings: {
    getState: (): Promise<EmbeddingsState> => ipcRenderer.invoke("embeddings:getState"),
    saveCredentials: (credentials: EmbeddingsCredentials): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("embeddings:saveCredentials", { credentials }),
    clearCredentials: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("embeddings:clearCredentials"),
  },

  // MCP server configuration
  mcp: {
    getConfigs: (): Promise<MCPServerConfigForRenderer[]> => ipcRenderer.invoke("mcp:getConfigs"),
    createFromTemplate: (
      targetPath: string,
      name: string
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("mcp:createFromTemplate", { targetPath, name }),
    restart: (name: string, config?: {
      name: string;
      transport?: "stdio" | "streamable-http";
      url?: string;
      headers?: Record<string, string>;
      command?: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      enabled: boolean;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("mcp:restart", { name, config }),
    disable: (name: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("mcp:disable", { name }),
    closeAll: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("mcp:closeAll"),
    onRestarted: (callback: (data: { name: string }) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { name: string }) => callback(data);
      ipcRenderer.on("mcp:restarted", handler);
      return () => ipcRenderer.removeListener("mcp:restarted", handler);
    },
    onDisabled: (callback: (data: { name: string }) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { name: string }) => callback(data);
      ipcRenderer.on("mcp:disabled", handler);
      return () => ipcRenderer.removeListener("mcp:disabled", handler);
    },
    onStatus: (callback: (data: { name: string; status: "ok" | "error"; error?: string }) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { name: string; status: "ok" | "error"; error?: string }) =>
        callback(data);
      ipcRenderer.on("mcp:status", handler);
      return () => ipcRenderer.removeListener("mcp:status", handler);
    },
    /**
     * Get all UI resources from connected MCP servers.
     * Returns resources with ui:// URI scheme for sidebar display.
     */
    getUIResources: (): Promise<Array<{ serverName: string; uri: string; name: string; icon?: ResourceIcon }>> =>
      ipcRenderer.invoke("mcp:getUIResources"),
    /**
     * Launch a pip for a UI resource directly (without a tool call).
     * If a pip exists, returns its instanceId to focus it.
     */
    launchResourcePip: (serverName: string, resourceUri: string): Promise<{
      success: boolean;
      instanceId?: string;
      isExisting?: boolean;
      error?: string;
    }> => ipcRenderer.invoke("mcp:launchResourcePip", { serverName, resourceUri }),
  },

  sampling: {
    onEvent: (callback: (event: SamplingEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: SamplingEvent) => callback(data);
      ipcRenderer.on("sampling:event", handler);
      return () => ipcRenderer.removeListener("sampling:event", handler);
    },
    respond: (response: SamplingResponse): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("sampling:respond", response),
  },

  // Projects API
  project: {
    /**
     * List all projects.
     */
    list: (): Promise<{
      success: boolean;
      projects?: ProjectWithValidation[];
      error?: string;
    }> => ipcRenderer.invoke("project:list"),

    /**
     * Get a single project by ID.
     */
    get: (params: { projectId: string }): Promise<{
      success: boolean;
      project?: ProjectWithValidation;
      error?: string;
    }> => ipcRenderer.invoke("project:get", params),

    /**
     * Create a new project.
     */
    create: (params: {
      name: string;
      profile: ProjectProfile;
      context?: ProjectContext;
      mcps?: ProjectMcpConfig[];
      sampling?: SamplingSettings;
    }): Promise<{
      success: boolean;
      project?: Project;
      error?: string;
    }> => ipcRenderer.invoke("project:create", params),

    /**
     * Update a project.
     */
    update: (params: {
      projectId: string;
      name?: string;
      profile?: ProjectProfile;
      context?: ProjectContext;
      mcps?: ProjectMcpConfig[];
      sampling?: SamplingSettings;
    }): Promise<{
      success: boolean;
      project?: ProjectWithValidation;
      error?: string;
    }> => ipcRenderer.invoke("project:update", params),

    /**
     * Delete a project.
     */
    delete: (params: { projectId: string }): Promise<{
      success: boolean;
      error?: string;
    }> => ipcRenderer.invoke("project:delete", params),

    /**
     * Open a project.
     * Marks as accessed, starts chat server, and initializes MCPs.
     */
    open: (params: { projectId: string }): Promise<{
      success: boolean;
      project?: ProjectWithValidation;
      error?: string;
    }> => ipcRenderer.invoke("project:open", params),

    /**
     * Create MCP App project.
     * Supports both existing MCP folders and creating new ones from the example template.
     */
    createMcpApp: (params: {
      mcpFolderPath?: string; // Path to existing MCP folder
      targetPath?: string; // Parent path for new MCP
      name?: string; // Subfolder name for new MCP
      projectName: string;
      projectRootMode?: "parent" | "app"; // Where to create .creature (default: "parent")
    }): Promise<{
      success: boolean;
      project?: ProjectWithValidation;
      error?: string;
    }> => ipcRenderer.invoke("project:createMcpApp", params),
  },

  // Control Plane (MCP pip management)
  controlPlane: {
    closePip: (instanceId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("pip:close", instanceId),

    // Notify main process that pip has completed ui/initialize
    pipReady: (instanceId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("pip:ready", instanceId),

    // Notify main process that pip teardown is complete (iframe responded to ui/resource-teardown)
    pipTeardownComplete: (instanceId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("pip:teardown-complete", instanceId),

    refreshSinglePip: (params: { instanceId: string }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("pip:refresh-content", params.instanceId),

    /**
     * Update a pip's title.
     * Used by browser pips to sync the webpage title to the pip tab.
     */
    updatePipTitle: (params: { instanceId: string; title: string }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("pip:updateTitle", { instanceId: params.instanceId, title: params.title }),

    /**
     * Update a pip's widget state.
     * Called when Guest UI sends widget-state-changed notification.
     * The modelContent is included in the system prompt for AI continuity.
     */
    updateWidgetState: (params: {
      instanceId: string;
      widgetState: {
        modelContent?: string | Record<string, unknown> | null;
        privateContent?: Record<string, unknown> | null;
        imageIds?: string[];
      } | null;
    }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("pip:updateWidgetState", { instanceId: params.instanceId, widgetState: params.widgetState }),

    // Call a tool on an MCP server (for UI-initiated tool calls per MCP Apps spec)
    callTool: (params: {
      serverName: string;
      toolName: string;
      args: Record<string, unknown>;
      instanceId?: string;
    }): Promise<unknown> => ipcRenderer.invoke("cp:call-tool", params),

    /**
     * Fetch HTML content for a UI resource.
     * Used by InlineWidget to load resource HTML without including it in
     * conversation history (which would bloat API token usage).
     */
    getResourceHtml: (params: {
      serverName: string;
      resourceUri: string;
      noCache?: boolean;
    }): Promise<{ success: boolean; html?: string; error?: string }> =>
      ipcRenderer.invoke("cp:get-resource-html", params),

    /**
     * Read a resource from an MCP server.
     * Per MCP Apps spec (SEP-1865), Guest UIs can request resources via the Host.
     */
    readResource: (params: {
      serverName: string;
      uri: string;
    }): Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }> =>
      ipcRenderer.invoke("cp:read-resource", params),

    // Pip lifecycle events
    onPipCreated: (callback: (pip: McpPip) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, pip: McpPip) => callback(pip);
      ipcRenderer.on("pip:created", handler);
      return () => ipcRenderer.removeListener("pip:created", handler);
    },
    onPipClosed: (callback: (instanceId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, instanceId: string) => callback(instanceId);
      ipcRenderer.on("pip:closed", handler);
      return () => ipcRenderer.removeListener("pip:closed", handler);
    },
    /**
     * Listen for pip teardown requests from control plane.
     * The renderer should send ui/resource-teardown to the iframe and call
     * pipTeardownComplete when the iframe responds.
     */
    onPipTeardown: (callback: (data: { instanceId: string; reason: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { instanceId: string; reason: string }) => callback(data);
      ipcRenderer.on("pip:teardown", handler);
      return () => ipcRenderer.removeListener("pip:teardown", handler);
    },
    onPipRefresh: (callback: (data: { instanceId: string; htmlContent: string; icon?: ResourceIcon }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { instanceId: string; htmlContent: string; icon?: ResourceIcon }
      ) => callback(data);
      ipcRenderer.on("pip:refresh", handler);
      return () => ipcRenderer.removeListener("pip:refresh", handler);
    },

    /**
     * Listen for pip title changes.
     * MCPs can return a `title` field in structuredContent to update the pip title.
     * This provides a generic interface for all MCPs to control their pip's display.
     */
    onPipTitleChanged: (callback: (data: { instanceId: string; title: string }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { instanceId: string; title: string }
      ) => callback(data);
      ipcRenderer.on("pip:title-changed", handler);
      return () => ipcRenderer.removeListener("pip:title-changed", handler);
    },

    // MCP Apps protocol notifications (renderer forwards via AppBridge)
    onToolInput: (callback: (data: { instanceId: string; toolName: string; arguments: Record<string, unknown> }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { instanceId: string; toolName: string; arguments: Record<string, unknown> }) => callback(data);
      ipcRenderer.on("pip:tool-input", handler);
      return () => ipcRenderer.removeListener("pip:tool-input", handler);
    },
    onToolResult: (callback: (data: { instanceId: string; toolName: string; result: unknown; isError: boolean; source?: "agent" | "ui" }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { instanceId: string; toolName: string; result: unknown; isError: boolean; source?: "agent" | "ui" }) => callback(data);
      ipcRenderer.on("pip:tool-result", handler);
      return () => ipcRenderer.removeListener("pip:tool-result", handler);
    },

    /**
     * Listen for pip destroyed events.
     * Used by ViewChat to inject a message into conversation history so the
     * agent knows the pip is no longer valid.
     */
    onPipDestroyed: (callback: (event: PipDestroyedEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: PipDestroyedEvent) => callback(data);
      ipcRenderer.on("pip:destroyed", handler);
      return () => ipcRenderer.removeListener("pip:destroyed", handler);
    },

    /**
     * Listen for pip created events (for conversation history injection).
     * Used by ViewChat to inject into conversation history so the agent knows
     * about new pips and their instanceId.
     */
    onPipCreatedForHistory: (callback: (event: PipCreatedEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: PipCreatedEvent) => callback(data);
      ipcRenderer.on("pip:created-history", handler);
      return () => ipcRenderer.removeListener("pip:created-history", handler);
    },

    /**
     * Listen for browser commands from main process.
     * Used by PipBrowser to execute commands on the native webview.
     * This is a Host-specific feature for mcp-browser only.
     */
    onBrowserCommand: (callback: (data: {
      browserSessionId: string;
      instanceId: string;
      command: { action: string; url?: string; x?: number; y?: number; selector?: string; text?: string };
    }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          browserSessionId: string;
          instanceId: string;
          command: { action: string; url?: string; x?: number; y?: number; selector?: string; text?: string };
        }
      ) => callback(data);
      ipcRenderer.on("browser:command", handler);
      return () => ipcRenderer.removeListener("browser:command", handler);
    },
  },

  // Window management
  window: {
    popout: (params: PopoutParams): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("window:popout", params),
    focusPopout: (instanceId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("window:focusPopout", instanceId),
    onPopoutClosed: (callback: (data: { instanceId: string; widgetState: Record<string, unknown> | null }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { instanceId: string; widgetState: Record<string, unknown> | null }) => callback(data);
      ipcRenderer.on("window:popoutClosed", handler);
      return () => ipcRenderer.removeListener("window:popoutClosed", handler);
    },
    onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, isFullscreen: boolean) => callback(isFullscreen);
      ipcRenderer.on("window:fullscreen-changed", handler);
      return () => ipcRenderer.removeListener("window:fullscreen-changed", handler);
    },
    /** Broadcast theme change to all popout windows */
    broadcastTheme: (params: { theme: "dark" | "light"; styles: PopoutStyles }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("window:broadcastTheme", params),
    /** Listen for theme changes (used by popout windows) */
    onThemeChanged: (callback: (data: { theme: "dark" | "light"; styles: PopoutStyles }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { theme: "dark" | "light"; styles: PopoutStyles }) => callback(data);
      ipcRenderer.on("popout:theme-changed", handler);
      return () => ipcRenderer.removeListener("popout:theme-changed", handler);
    },
  },

  // System notifications
  notification: {
    show: (options: { title: string; body?: string }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("notification:show", options),
  },

  // Auto-updater events
  updater: {
    /** Listen for update available events */
    onUpdateAvailable: (handler: (_: unknown, info: { version: string }) => void) => {
      ipcRenderer.on("updater:available", handler);
      return () => ipcRenderer.removeListener("updater:available", handler);
    },
    /** Listen for update downloaded events */
    onUpdateDownloaded: (handler: (_: unknown, info: { version: string }) => void) => {
      ipcRenderer.on("updater:downloaded", handler);
      return () => ipcRenderer.removeListener("updater:downloaded", handler);
    },
    /** Get pending update info (for checking on mount) */
    getPendingInfo: (): Promise<{ pending: boolean; version: string | null }> =>
      ipcRenderer.invoke("updater:getPendingInfo"),
    /** Trigger quit and install */
    quitAndInstall: (): Promise<void> => ipcRenderer.invoke("updater:quitAndInstall"),
  },

  // Settings (enterprise customization and branding)
  settings: {
    /**
     * Get resolved settings (all layers merged).
     */
    get: (): Promise<{
      branding: {
        appName: string;
        logo: {
          svg?: string;
          lightSvg?: string;
          url?: string;
          lightUrl?: string;
        } | null;
      };
      theme: {
        dark: Record<string, unknown>;
        light: Record<string, unknown>;
      };
    }> => ipcRenderer.invoke("settings:get"),

    /**
     * Update user settings.
     */
    update: (params: {
      branding?: {
        appName?: string;
        logo?: {
          svg?: string;
          lightSvg?: string;
          url?: string;
          lightUrl?: string;
        } | null;
      };
      theme?: {
        dark?: Record<string, unknown>;
        light?: Record<string, unknown>;
      };
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("settings:update", params),

    /**
     * Import enterprise settings from a file.
     * Opens file dialog if no path provided.
     */
    import: (params?: { filePath?: string }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("settings:import", params),

    /**
     * Export current settings to a file.
     */
    export: (): Promise<{ success: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke("settings:export"),

    /**
     * Reset user settings to defaults.
     */
    reset: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("settings:reset"),

    /**
     * Get CSS variable overrides for a theme mode.
     */
    getCssVariables: (params: { mode: "dark" | "light" }): Promise<Record<string, string>> =>
      ipcRenderer.invoke("settings:getCssVariables", params),

    /**
     * Listen for settings changes.
     */
    onChanged: (callback: (settings: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, settings: unknown) => callback(settings);
      ipcRenderer.on("settings:changed", handler);
      return () => ipcRenderer.removeListener("settings:changed", handler);
    },
  },

  // Dev Console (debugging tools)
  devConsole: {
    /**
     * Open the Dev Console window.
     */
    openWindow: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("devconsole:openWindow"),

    /**
     * Get the current conversation history.
     */
    getConversation: (): Promise<unknown[]> =>
      ipcRenderer.invoke("devconsole:getConversation"),

    /**
     * Get the current system prompt.
     */
    getSystemPrompt: (): Promise<string> =>
      ipcRenderer.invoke("devconsole:getSystemPrompt"),

    /**
     * Update the stored conversation history.
     * Called by the renderer when conversation changes.
     */
    updateConversation: (messages: unknown[]): void => {
      ipcRenderer.send("devconsole:updateConversation", messages);
    },
  },

  // Logging (used by Dev Console Logs tab)
  logs: {
    /**
     * Get recent log entries.
     */
    getRecent: (count?: number): Promise<LogEntry[]> =>
      ipcRenderer.invoke("logs:getRecent", count),

    /**
     * Clear all log entries.
     */
    clear: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("logs:clear"),

    /**
     * Forward a UI Resource log to the main process.
     * Called by PipMcp when it receives ui/log messages from iframes.
     */
    fromUI: (data: {
      instanceId: string;
      mcpServer: string;
      level: string;
      message: string;
      timestamp: string;
    }): void => {
      ipcRenderer.send("logs:fromUI", data);
    },

    /**
     * Listen for new log entries.
     * Used by the logs window to receive streaming updates.
     */
    onEntry: (callback: (entry: LogEntry) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, entry: LogEntry) => callback(entry);
      ipcRenderer.on("logs:entry", handler);
      return () => ipcRenderer.removeListener("logs:entry", handler);
    },

    /**
     * Listen for initial log entries.
     * Sent when a window subscribes to the log aggregator.
     */
    onInitial: (callback: (entries: LogEntry[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, entries: LogEntry[]) => callback(entries);
      ipcRenderer.on("logs:initial", handler);
      return () => ipcRenderer.removeListener("logs:initial", handler);
    },

    /**
     * Listen for log clear events.
     */
    onCleared: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on("logs:cleared", handler);
      return () => ipcRenderer.removeListener("logs:cleared", handler);
    },
  },
});

// Type declaration for the exposed API
declare global {
  interface Window {
    electronAPI: {
      getVersion: () => Promise<string>;
      getPlatform: () => Promise<string>;
      shell: {
        openExternal: (url: string) => Promise<void>;
      };
      selectFolder: () => Promise<string | null>;
      selectFiles: (baseFolderPath: string) => Promise<{ paths: string[]; error?: string } | null>;
      resolveFilePath: (
        absolutePath: string,
        baseFolderPath: string
      ) => Promise<{ relativePath: string | null; error?: string }>;
      searchFiles: (
        query: string,
        baseFolderPath: string
      ) => Promise<{ results: Array<{ path: string; type: "file" | "folder" }>; error?: string }>;
      folder: {
        getCurrent: () => Promise<string | null>;
      };
      chat: {
        start: () => Promise<{ success: boolean; error?: string }>;
        isRunning: () => Promise<{ running: boolean }>;
      };
      auth: {
        getState: () => Promise<AuthState>;
        saveCredentials: (credentials: ProviderCredentials) => Promise<{ success: boolean; error?: string }>;
        clearCredentials: () => Promise<{ success: boolean }>;
        // Legacy compatibility
        saveApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>;
        clearApiKey: () => Promise<{ success: boolean }>;
      };
      embeddings: {
        getState: () => Promise<EmbeddingsState>;
        saveCredentials: (credentials: EmbeddingsCredentials) => Promise<{ success: boolean; error?: string }>;
        clearCredentials: () => Promise<{ success: boolean; error?: string }>;
      };
      mcp: {
        getConfigs: () => Promise<MCPServerConfigForRenderer[]>;
        createFromTemplate: (targetPath: string, name: string) => Promise<{ success: boolean; error?: string }>;
        restart: (name: string, config?: {
          name: string;
          transport?: "stdio" | "streamable-http";
          url?: string;
          headers?: Record<string, string>;
          git?: { url: string; ref?: string; subdir?: string; setupCommand?: string; startCommand?: string; transport?: "stdio" | "streamable-http" };
          command?: string;
          args?: string[];
          cwd?: string;
          env?: Record<string, string>;
          enabled: boolean;
        }) => Promise<{ success: boolean; error?: string }>;
        disable: (name: string) => Promise<{ success: boolean; error?: string }>;
        closeAll: () => Promise<{ success: boolean; error?: string }>;
        onRestarted: (callback: (data: { name: string }) => void) => () => void;
        onDisabled: (callback: (data: { name: string }) => void) => () => void;
        onStatus: (callback: (data: { name: string; status: "ok" | "error"; error?: string }) => void) => () => void;
        getUIResources: () => Promise<Array<{ serverName: string; uri: string; name: string; icon?: ResourceIcon }>>;
        launchResourcePip: (serverName: string, resourceUri: string) => Promise<{
          success: boolean;
          instanceId?: string;
          isExisting?: boolean;
          error?: string;
        }>;
      };
      sampling: {
        onEvent: (callback: (event: SamplingEvent) => void) => () => void;
        respond: (response: SamplingResponse) => Promise<{ success: boolean; error?: string }>;
      };
      project: {
        list: () => Promise<{
          success: boolean;
          projects?: ProjectWithValidation[];
          error?: string;
        }>;
        get: (params: { projectId: string }) => Promise<{
          success: boolean;
          project?: ProjectWithValidation;
          error?: string;
        }>;
        create: (params: {
          name: string;
          profile: ProjectProfile;
          context?: ProjectContext;
          mcps?: ProjectMcpConfig[];
          sampling?: SamplingSettings;
        }) => Promise<{
          success: boolean;
          project?: Project;
          error?: string;
        }>;
        update: (params: {
          projectId: string;
          name?: string;
          profile?: ProjectProfile;
          context?: ProjectContext;
          mcps?: ProjectMcpConfig[];
          sampling?: SamplingSettings;
        }) => Promise<{
          success: boolean;
          project?: ProjectWithValidation;
          error?: string;
        }>;
        delete: (params: { projectId: string }) => Promise<{
          success: boolean;
          error?: string;
        }>;
        open: (params: { projectId: string }) => Promise<{
          success: boolean;
          project?: ProjectWithValidation;
          error?: string;
        }>;
        createMcpApp: (params: {
          mcpFolderPath?: string;
          targetPath?: string;
          name?: string;
          template?: string;
          projectName: string;
          projectRootMode?: "parent" | "app";
        }) => Promise<{
          success: boolean;
          project?: ProjectWithValidation;
          error?: string;
        }>;
      };
      controlPlane: {
        closePip: (instanceId: string) => Promise<{ success: boolean }>;
        pipReady: (instanceId: string) => Promise<{ success: boolean }>;
        pipTeardownComplete: (instanceId: string) => Promise<{ success: boolean }>;
        refreshSinglePip: (params: { instanceId: string }) => Promise<{ success: boolean; error?: string }>;
        updatePipTitle: (params: { instanceId: string; title: string }) => Promise<{ success: boolean }>;
        updateWidgetState: (params: {
          instanceId: string;
          widgetState: {
            modelContent?: string | Record<string, unknown> | null;
            privateContent?: Record<string, unknown> | null;
            imageIds?: string[];
          } | null;
        }) => Promise<{ success: boolean }>;
        callTool: (params: {
          serverName: string;
          toolName: string;
          args: Record<string, unknown>;
          instanceId?: string;
        }) => Promise<unknown>;
        getResourceHtml: (params: {
          serverName: string;
          resourceUri: string;
          noCache?: boolean;
        }) => Promise<{ success: boolean; html?: string; error?: string }>;
        readResource: (params: {
          serverName: string;
          uri: string;
        }) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }>;
        onPipCreated: (callback: (pip: McpPip) => void) => () => void;
        onPipClosed: (callback: (instanceId: string) => void) => () => void;
        onPipTeardown: (callback: (data: { instanceId: string; reason: string }) => void) => () => void;
        onPipRefresh: (callback: (data: { instanceId: string; htmlContent: string; icon?: ResourceIcon }) => void) => () => void;
        onPipTitleChanged: (callback: (data: { instanceId: string; title: string }) => void) => () => void;
        onToolInput: (callback: (data: { instanceId: string; toolName: string; arguments: Record<string, unknown> }) => void) => () => void;
        onToolResult: (callback: (data: { instanceId: string; toolName: string; result: unknown; isError: boolean }) => void) => () => void;
        onPipDestroyed: (callback: (event: PipDestroyedEvent) => void) => () => void;
        onPipCreatedForHistory: (callback: (event: PipCreatedEvent) => void) => () => void;
        onBrowserCommand: (callback: (data: {
          browserSessionId: string;
          instanceId: string;
          command: { action: string; url?: string; x?: number; y?: number; selector?: string; text?: string };
        }) => void) => () => void;
      };
      window: {
        popout: (params: PopoutParams) => Promise<{ success: boolean }>;
        focusPopout: (instanceId: string) => Promise<{ success: boolean }>;
        onPopoutClosed: (callback: (data: { instanceId: string; widgetState: Record<string, unknown> | null }) => void) => () => void;
        onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => () => void;
        broadcastTheme: (params: { theme: "dark" | "light"; styles: PopoutStyles }) => Promise<{ success: boolean }>;
        onThemeChanged: (callback: (data: { theme: "dark" | "light"; styles: PopoutStyles }) => void) => () => void;
      };
      notification: {
        show: (options: { title: string; body?: string }) => Promise<{ success: boolean; error?: string }>;
      };
      updater: {
        onUpdateAvailable: (handler: (_: unknown, info: { version: string }) => void) => () => void;
        onUpdateDownloaded: (handler: (_: unknown, info: { version: string }) => void) => () => void;
        getPendingInfo: () => Promise<{ pending: boolean; version: string | null }>;
        quitAndInstall: () => Promise<void>;
      };
      settings: {
        get: () => Promise<{
          branding: {
            appName: string;
            logo: {
              svg?: string;
              lightSvg?: string;
              url?: string;
              lightUrl?: string;
            } | null;
          };
          theme: {
            dark: Record<string, unknown>;
            light: Record<string, unknown>;
          };
        }>;
        update: (params: {
          branding?: {
            appName?: string;
            logo?: {
              svg?: string;
              lightSvg?: string;
              url?: string;
              lightUrl?: string;
            } | null;
          };
          theme?: {
            dark?: Record<string, unknown>;
            light?: Record<string, unknown>;
          };
        }) => Promise<{ success: boolean; error?: string }>;
        import: (params?: { filePath?: string }) => Promise<{ success: boolean; error?: string }>;
        export: () => Promise<{ success: boolean; filePath?: string; error?: string }>;
        reset: () => Promise<{ success: boolean }>;
        getCssVariables: (params: { mode: "dark" | "light" }) => Promise<Record<string, string>>;
        onChanged: (callback: (settings: unknown) => void) => () => void;
      };
      devConsole: {
        openWindow: () => Promise<{ success: boolean }>;
        getConversation: () => Promise<unknown[]>;
        getSystemPrompt: () => Promise<string>;
        updateConversation: (messages: unknown[]) => void;
      };
      logs: {
        getRecent: (count?: number) => Promise<LogEntry[]>;
        clear: () => Promise<{ success: boolean }>;
        fromUI: (data: {
          instanceId: string;
          mcpServer: string;
          level: string;
          message: string;
          timestamp: string;
        }) => void;
        onEntry: (callback: (entry: LogEntry) => void) => () => void;
        onInitial: (callback: (entries: LogEntry[]) => void) => () => void;
        onCleared: (callback: () => void) => () => void;
      };
      image: {
        upload: (filePathOrBuffer: string | { buffer: Uint8Array; filename: string }, projectId: string) => Promise<{
          success: boolean;
          image?: {
            url: string;
            filename: string;
            size: number;
            contentType: string;
            localPath: string;
          };
          error?: string;
        }>;
      };
    };
  }
}
