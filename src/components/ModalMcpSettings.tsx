import { useState, useEffect, useCallback } from "react";
import { ArrowClockwise, ArrowLeft, PencilSimple, Trash, X, CloudArrowUp, Cube, Plus, FilePlus, Globe, Terminal, Rocket } from "@phosphor-icons/react";
import { Button } from "./Button";
import { cn } from "../lib/utils";
import { RegistryBrowser } from "./RegistryBrowser";
import { RegistryPublish } from "./RegistryPublish";
import { Hosting } from "./Hosting";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./DropdownMenu";
import { useApp } from "../contexts/AppContext";
import type { MCPServerConfigForRenderer } from "../electron/preload";
import { validateNodeBasedLaunch } from "../shared/mcpCommandPolicy";

type MCPTransportType = "stdio" | "streamable-http";

interface MCPServerConfig extends MCPServerConfigForRenderer {
  builtin?: boolean;
  registry?: string;
}

interface EnvVar {
  key: string;
  value: string;
}

interface HeaderVar {
  key: string;
  value: string;
}

interface ModalMcpSettingsProps {
  onClose: () => void;
}

const argsInputToArray = (value: string): string[] => {
  return value
    .trim()
    .split(/\s+/)
    .filter((a) => a);
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

/**
 * View mode for the modal.
 * - list: Show the list of MCP servers
 * - edit: Show the edit/add form for a server
 * - create: Show the create new MCP form
 * - registry: Browse and install MCPs from the registry
 * - publish: Publish an MCP to the registry
 */
type ViewMode = "list" | "edit" | "create" | "registry" | "publish" | "deployment";

/**
 * ModalMcpSettings Component
 *
 * Modal dialog for managing MCP (Model Context Protocol) server configurations.
 * Features:
 * - List all configured MCP servers
 * - Add new servers with command, args, cwd, and env vars
 * - Edit existing server configurations
 * - Delete non-builtin servers
 * - Create new MCP from template
 */
export function ModalMcpSettings({ onClose }: ModalMcpSettingsProps) {
  const { session, setProject } = useApp();
  const [servers, setServers] = useState<MCPServerConfig[]>([]);
  const [initialServers, setInitialServers] = useState<MCPServerConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingServer, setEditingServer] = useState<MCPServerConfig | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [restartingServer, setRestartingServer] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load MCP server configs on mount
  useEffect(() => {
    window.electronAPI.mcp.getConfigs()
      .then((configs) => {
        setServers(configs);
        setInitialServers(configs);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  /**
   * Checks if there are unsaved changes to project MCPs.
   */
  const hasChanges = useCallback(() => {
    const isProjectScope = (scope?: string) => scope !== "builtin";
    const currentProjectMcps = servers.filter((s) => isProjectScope(s.scope));
    const initialProjectMcps = initialServers.filter((s) => isProjectScope(s.scope));

    if (currentProjectMcps.length !== initialProjectMcps.length) {
      return true;
    }

    // Compare each MCP (deep comparison)
    return currentProjectMcps.some((current) => {
      const initial = initialProjectMcps.find((i) => i.name === current.name);
      if (!initial) return true;

      return (
        current.transport !== initial.transport ||
        current.url !== initial.url ||
        JSON.stringify(current.headers) !== JSON.stringify(initial.headers) ||
        current.command !== initial.command ||
        JSON.stringify(current.args) !== JSON.stringify(initial.args) ||
        current.cwd !== initial.cwd ||
        JSON.stringify(current.env) !== JSON.stringify(initial.env) ||
        current.enabled !== initial.enabled ||
        current.registry !== initial.registry
      );
    });
  }, [servers, initialServers]);

  /**
   * Saves MCP changes to the project and closes the modal.
   * Updates the project's MCP configuration via the API, then re-opens the project
   * to trigger MCP initialization with the new configuration.
   * If no changes were made, simply closes the modal.
   */
  const handleSave = useCallback(async () => {
    // If no changes, just close
    if (!hasChanges()) {
      onClose();
      return;
    }

    setSaving(true);
    setError(null);

    try {
      // Filter to only project-scoped MCPs (exclude built-in)
      const projectMcps = servers
        .filter((s) => s.scope !== "builtin")
        .map((s) => ({
          name: s.name,
          transport: s.transport,
          url: s.url,
          headers: s.headers,
          registry: s.registry,
          command: s.command,
          args: s.args,
          cwd: s.cwd,
          env: s.env,
          enabled: s.enabled ?? true,
        }));

      // Update the project via API
      const updateResult = await window.electronAPI.project.update({
        projectId: session.project.id,
        mcps: projectMcps,
      });

      if (!updateResult.success) {
        setError(updateResult.error || "Failed to save MCP configuration");
        setSaving(false);
        return;
      }

      // Re-open the project to initialize MCPs with the new configuration
      const openResult = await window.electronAPI.project.open({
        projectId: session.project.id,
      });

      if (!openResult.success) {
        setError(openResult.error || "Failed to reinitialize MCPs");
        setSaving(false);
        return;
      }

      // Update the project in context
      if (openResult.project) {
        setProject(openResult.project);
      }

      onClose();
    } catch (err) {
      console.error("[ModalMcpSettings] Failed to save:", err);
      setError(err instanceof Error ? err.message : "Failed to save changes");
      setSaving(false);
    }
  }, [session.project, servers, onClose, setProject, hasChanges]);

  /**
   * Removes a server from the list by name.
   * Changes are persisted when the modal is closed.
   */
  const handleDelete = useCallback((name: string) => {
    setServers((prev) => prev.filter((s) => s.name !== name));
  }, []);

  /**
   * Restarts an MCP server by disconnecting and reconnecting.
   * Useful after changing settings like dev mode.
   */
  const handleRestart = useCallback(async (name: string) => {
    setRestartingServer(name);
    setError(null);
    try {
      const result = await window.electronAPI.mcp.restart(name);
      if (!result.success) {
        setError(result.error || `Failed to restart ${name}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to restart ${name}`);
    } finally {
      setRestartingServer(null);
    }
  }, []);

  /**
   * Opens the add server form.
   */
  const handleAddNew = useCallback(() => {
    setEditingServer({
      name: "",
      transport: "stdio",
      url: "",
      headers: {},
      command: "",
      args: [],
      cwd: "",
      env: {},
      builtin: false,
      enabled: true,
      scope: "custom",
    });
    setIsAddingNew(true);
  }, []);

  /**
   * Saves the edited/new server configuration to local state.
   * Changes are persisted to the project when the modal is closed.
   */
  const handleEditSave = useCallback(
    (updated: MCPServerConfig) => {
      if (isAddingNew) {
        setServers((prev) => [...prev, updated]);
      } else {
        setServers((prev) => prev.map((s) => (s.name === editingServer?.name ? updated : s)));
      }
      setEditingServer(null);
      setIsAddingNew(false);
    },
    [isAddingNew, editingServer]
  );

  /**
   * Cancels the edit/add operation.
   */
  const handleEditCancel = useCallback(() => {
    setEditingServer(null);
    setIsAddingNew(false);
    setViewMode("list");
  }, []);

  /**
   * Called when MCP creation from template completes successfully.
   * Refreshes the server list and returns to list view.
   */
  const handleCreateComplete = useCallback(async () => {
    setViewMode("list");
    // Refresh server list
    try {
      const configs = await window.electronAPI.mcp.getConfigs();
      setServers(configs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh");
    }
  }, []);

  /**
   * Opens the create new MCP form.
   */
  const handleShowCreate = useCallback(() => {
    setViewMode("create");
  }, []);

  /**
   * Opens the registry browser.
   */
  const handleShowRegistry = useCallback(() => {
    setViewMode("registry");
  }, []);

  /**
   * Opens the publish form.
   */
  const handleShowPublish = useCallback(() => {
    setViewMode("publish");
  }, []);

  /**
   * Opens the deployment view.
   */
  const handleShowDeployment = useCallback(() => {
    setViewMode("deployment");
  }, []);

  /**
   * Handles installing an MCP from the registry.
   * Adds the MCP config to local state; changes are persisted when the modal is closed.
   */
  const handleInstallFromRegistry = useCallback(
    (mcpConfig: { name: string; command: string; args: string[]; cwd?: string; registry?: string }) => {
      // Check if already exists
      if (servers.some((s) => s.name === mcpConfig.name)) {
        setError(`MCP "${mcpConfig.name}" is already configured`);
        return;
      }

      // Add to servers with custom scope
      const newServer: MCPServerConfig = {
        ...mcpConfig,
        builtin: false,
        enabled: true,
        scope: "custom",
      };

      setServers((prev) => [...prev, newServer]);
      setViewMode("list");
    },
    [servers]
  );

  /**
   * Returns to list view from registry or publish.
   */
  const handleBackToList = useCallback(() => {
    setViewMode("list");
    setError(null);
  }, []);


  // Loading state
  if (loading) {
    return (
      <div
        className="fixed inset-0 bg-background-primary/95 flex items-center justify-center z-50"
        onClick={handleSave}
      >
        <div
          className="bg-background-primary border border-border-primary rounded-xl w-[90%] max-w-[600px] max-h-[80vh] flex flex-col shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-primary">
            <h2 className="text-base font-medium text-text-primary">MCP Servers</h2>
            <button
              className="text-lg text-text-secondary hover:text-text-primary transition-colors cursor-pointer p-0 bg-transparent border-none leading-none"
              onClick={handleSave}
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <div className="text-center py-4 text-text-secondary text-base">Loading...</div>
          </div>
        </div>
      </div>
    );
  }

  // Create new MCP view
  if (viewMode === "create") {
    return (
      <CreateMcpForm
        existingNames={servers.map((s) => s.name)}
        onComplete={handleCreateComplete}
        onCancel={handleEditCancel}
      />
    );
  }

  // Registry browser view
  if (viewMode === "registry") {
    return (
      <div
        className="fixed inset-0 bg-background-primary/95 flex items-center justify-center z-50"
        onClick={handleSave}
      >
        <div
          className="bg-background-primary border border-border-primary rounded-xl w-[90%] max-w-[600px] h-[80vh] flex flex-col shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-primary">
            <div className="flex items-center gap-2">
              <button
                className="p-1 rounded text-text-secondary hover:text-text-primary transition-colors"
                onClick={handleBackToList}
                disabled={saving}
              >
                <ArrowLeft size={12} />
              </button>
              <h2 className="text-base font-medium text-text-primary">MCP Registry</h2>
            </div>
            <button
              className="text-lg text-text-secondary hover:text-text-primary transition-colors cursor-pointer p-0 bg-transparent border-none leading-none"
              onClick={handleSave}
              disabled={saving}
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-hidden p-4">
            <RegistryBrowser
              onInstall={handleInstallFromRegistry}
              onBack={handleBackToList}
              installedMcpNames={servers.map((s) => s.name)}
            />
          </div>
        </div>
      </div>
    );
  }

  // Publish view
  if (viewMode === "publish") {
    return (
      <div
        className="fixed inset-0 bg-background-primary/95 flex items-center justify-center z-50"
        onClick={handleSave}
      >
        <div
          className="bg-background-primary border border-border-primary rounded-xl w-[90%] max-w-[600px] h-[80vh] flex flex-col shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-primary">
            <div className="flex items-center gap-2">
              <button
                className="p-1 rounded text-text-secondary hover:text-text-primary transition-colors"
                onClick={handleBackToList}
                disabled={saving}
              >
                <ArrowLeft size={12} />
              </button>
              <h2 className="text-base font-medium text-text-primary">Publish to Registry</h2>
            </div>
            <button
              className="text-lg text-text-secondary hover:text-text-primary transition-colors cursor-pointer p-0 bg-transparent border-none leading-none"
              onClick={handleSave}
              disabled={saving}
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <RegistryPublish
              onBack={handleBackToList}
              onComplete={handleBackToList}
              projectProfile={session.project?.profile}
            />
          </div>
        </div>
      </div>
    );
  }

  if (viewMode === "deployment") {
    return (
      <div
        className="fixed inset-0 bg-background-primary/95 flex items-center justify-center z-50"
        onClick={handleSave}
      >
        <div
          className="bg-background-primary border border-border-primary rounded-xl w-[90%] max-w-[600px] h-[80vh] flex flex-col shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-primary">
            <div className="flex items-center gap-2">
              <button
                className="p-1 rounded text-text-secondary hover:text-text-primary transition-colors"
                onClick={handleBackToList}
                disabled={saving}
              >
                <ArrowLeft size={12} />
              </button>
              <h2 className="text-base font-medium text-text-primary">Deploy MCP</h2>
            </div>
            <button
              className="text-lg text-text-secondary hover:text-text-primary transition-colors cursor-pointer p-0 bg-transparent border-none leading-none"
              onClick={handleSave}
              disabled={saving}
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <Hosting onBack={handleBackToList} projectId={session.project?.id} />
          </div>
        </div>
      </div>
    );
  }

  // Edit/Add form view
  if (editingServer) {
    return (
        <ServerEditForm
          server={editingServer}
          isNew={isAddingNew}
          existingNames={servers.map((s) => s.name).filter((n) => n !== editingServer.name)}
          onSave={handleEditSave}
          onCancel={handleEditCancel}
        />
    );
  }

  // Main list view
  return (
    <div
      className="fixed inset-0 bg-background-primary/95 flex items-center justify-center z-50"
      onClick={handleSave}
    >
      <div
        className="bg-background-primary border border-border-primary rounded-xl w-[90%] max-w-[600px] max-h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-primary">
          <h2 className="text-xs font-medium text-text-primary">MCP Servers</h2>
          <button
            className="text-lg text-text-secondary hover:text-text-primary transition-colors cursor-pointer p-0 bg-transparent border-none leading-none"
            onClick={handleSave}
            disabled={saving}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <div className="bg-background-danger/10 border border-border-danger text-text-danger px-2.5 py-2 rounded-md mb-3 text-sm">
              {error}
            </div>
          )}

          {/* Server list */}
          <div className="flex flex-col gap-1.5 mb-3">
            {servers.length === 0 ? (
              <div className="text-center py-4 text-text-secondary text-base">
                No MCP servers configured
              </div>
            ) : (
              servers.map((server) => (
                <div
                  key={server.name}
                  className="flex items-center justify-between px-2.5 py-1.5 bg-background-tertiary border border-border-primary rounded-md"
                >
                  <span className="text-sm font-medium text-text-primary truncate min-w-0">
                    {server.name}
                  </span>
                  <div className="flex items-center gap-1.5 ml-2 flex-shrink-0">
                    {/* Scope tag */}
                    <span className="text-[9px] px-1 py-0.5 bg-background-primary border border-border-primary rounded text-text-secondary">
                      {server.scope === "builtin" ? "built-in" : server.scope === "development" ? "dev" : "project"}
                    </span>
                    {/* Action buttons */}
                    <button
                      className={cn(
                        "p-1 rounded text-text-secondary hover:text-text-primary transition-colors cursor-pointer",
                        restartingServer === server.name && "animate-spin"
                      )}
                      onClick={() => handleRestart(server.name)}
                      disabled={restartingServer === server.name}
                      title="Restart MCP server"
                    >
                      <ArrowClockwise size={11} />
                    </button>
                    {/* Edit, delete, and publish buttons - only for editable MCPs */}
                    {server.scope !== "builtin" && server.scope !== "development" && (
                      <>
                        <button
                          className="p-1 rounded text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
                          onClick={() => setEditingServer(server)}
                          title="Edit server"
                        >
                          <PencilSimple size={11} />
                        </button>
                        <button
                          className="p-1 rounded text-text-secondary hover:text-text-danger transition-colors cursor-pointer"
                          onClick={() => handleDelete(server.name)}
                          title="Delete server"
                        >
                          <Trash size={11} />
                        </button>
                        <button
                          className="p-1 rounded text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
                          onClick={handleShowPublish}
                          title="Publish to registry"
                        >
                          <CloudArrowUp size={11} />
                        </button>
                        <button
                          className="p-1 rounded text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
                          onClick={handleShowDeployment}
                          title="Deploy latest version"
                        >
                          <Rocket size={11} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="flex justify-between items-center px-4 py-2.5 border-t border-border-primary">
          {/* Left side buttons */}
          <div className="flex gap-2">
            {/* Add dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline-muted" className="text-sm" disabled={saving}>
                  <Plus size={10} className="mr-1" />
                  Add MCPs
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="min-w-[140px]">
                <DropdownMenuItem onClick={handleShowRegistry} className="text-sm py-1.5">
                  <Cube size={12} />
                  From Registry
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleAddNew} className="text-sm py-1.5">
                  <Plus size={12} />
                  Add Manually
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleShowCreate} className="text-sm py-1.5">
                  <FilePlus size={12} />
                  Create New
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Close/Save - right aligned */}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={saving} className="text-sm">
              {saving ? "Saving..." : hasChanges() ? "Save" : "Close"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ServerEditFormProps {
  server: MCPServerConfig;
  isNew: boolean;
  existingNames: string[];
  onSave: (server: MCPServerConfig) => void;
  onCancel: () => void;
}

/**
 * ServerEditForm Component
 *
 * Form for adding or editing MCP server configurations.
 * Supports both stdio (local subprocess) and streamable-http (remote) transports.
 */
function ServerEditForm({ server, isNew, existingNames, onSave, onCancel }: ServerEditFormProps) {
  const [name, setName] = useState(server.name);
  const [transport, setTransport] = useState<MCPTransportType>(server.transport || "stdio");
  
  // Streamable HTTP fields
  const [url, setUrl] = useState(server.url || "");
  const [headerVars, setHeaderVars] = useState<HeaderVar[]>(() => {
    const headers = server.headers || {};
    return Object.entries(headers).map(([key, value]) => ({ key, value }));
  });
  
  // Stdio fields
  const [command, setCommand] = useState(server.command || "");
  const [args, setArgs] = useState(server.args?.join(" ") || "");
  const [cwd, setCwd] = useState(server.cwd || "");
  const [envVars, setEnvVars] = useState<EnvVar[]>(() => {
    const env = server.env || {};
    return Object.entries(env).map(([key, value]) => ({ key, value }));
  });
  
  const [error, setError] = useState<string | null>(null);

  /**
   * Validates and submits the form.
   */
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (!name.trim()) {
        setError("Name is required");
        return;
      }
      if (existingNames.includes(name.trim())) {
        setError("A server with this name already exists");
        return;
      }

      if (transport === "streamable-http") {
        // Validate streamable-http fields
        if (!url.trim()) {
          setError("URL is required for remote servers");
          return;
        }
        try {
          new URL(url.trim());
        } catch {
          setError("Invalid URL format");
          return;
        }

        const headersObj: Record<string, string> = {};
        for (const { key, value } of headerVars) {
          if (key.trim()) {
            headersObj[key.trim()] = value;
          }
        }

        onSave({
          name: name.trim(),
          transport: "streamable-http",
          url: url.trim(),
          headers: Object.keys(headersObj).length > 0 ? headersObj : undefined,
          builtin: false,
          scope: "custom",
        });
      } else {
        // Validate stdio fields
        if (!command.trim()) {
          setError("Command is required");
          return;
        }

        const parsedArgs = argsInputToArray(args);
        try {
          validateNodeBasedLaunch({
            command: command.trim(),
            args: parsedArgs,
            context: "Local MCP command",
          });
        } catch (validationError) {
          setError(getErrorMessage(validationError));
          return;
        }

        const envObj: Record<string, string> = {};
        for (const { key, value } of envVars) {
          if (key.trim()) {
            envObj[key.trim()] = value;
          }
        }

        onSave({
          name: name.trim(),
          transport: "stdio",
          command: command.trim(),
          args: parsedArgs,
          cwd: cwd.trim() || undefined,
          env: Object.keys(envObj).length > 0 ? envObj : undefined,
          builtin: false,
          scope: "custom",
        });
      }
    },
    [name, transport, url, headerVars, command, args, cwd, envVars, existingNames, onSave]
  );

  // Environment variable helpers (stdio)
  const addEnvVar = useCallback(() => {
    setEnvVars((prev) => [...prev, { key: "", value: "" }]);
  }, []);

  const updateEnvVar = useCallback((index: number, field: "key" | "value", val: string) => {
    setEnvVars((prev) => prev.map((env, i) => (i === index ? { ...env, [field]: val } : env)));
  }, []);

  const removeEnvVar = useCallback((index: number) => {
    setEnvVars((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Header variable helpers (streamable-http)
  const addHeaderVar = useCallback(() => {
    setHeaderVars((prev) => [...prev, { key: "", value: "" }]);
  }, []);

  const updateHeaderVar = useCallback((index: number, field: "key" | "value", val: string) => {
    setHeaderVars((prev) => prev.map((h, i) => (i === index ? { ...h, [field]: val } : h)));
  }, []);

  const removeHeaderVar = useCallback((index: number) => {
    setHeaderVars((prev) => prev.filter((_, i) => i !== index));
  }, []);

  return (
    <div
      className="fixed inset-0 bg-background-primary/95 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="bg-background-primary border border-border-primary rounded-xl w-[90%] max-w-[500px] max-h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-primary">
          <h2 className="text-base font-semibold text-text-primary">
            {isNew ? "Add MCP Server" : "Edit MCP Server"}
          </h2>
          <button
            className="text-2xl text-text-secondary hover:text-text-primary transition-colors cursor-pointer p-0 bg-transparent border-none leading-none"
            onClick={onCancel}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5">
            {error && (
              <div className="bg-background-danger/10 border border-border-danger text-text-danger px-3 py-2.5 rounded-md mb-4 text-sm">
                {error}
              </div>
            )}

            {/* Name field */}
            <div className="mb-4">
              <label
                htmlFor="mcp-name"
                className="block mb-1.5 text-sm font-medium text-text-secondary"
              >
                Name
              </label>
              <input
                id="mcp-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., filesystem"
                disabled={!isNew}
                className={cn(
                  "w-full px-3 py-2.5 bg-background-tertiary border border-border-primary rounded-md text-text-primary text-sm",
                  "focus:outline-none focus:border-ring-primary",
                  "disabled:opacity-60 disabled:cursor-not-allowed",
                  "placeholder:text-text-secondary"
                )}
              />
            </div>

            {/* Transport Type Selector */}
            <div className="mb-4">
              <label className="block mb-1.5 text-sm font-medium text-text-secondary">
                Transport Type
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setTransport("stdio")}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2.5 rounded-md border text-sm transition-colors",
                    transport === "stdio"
                      ? "border-ring-primary bg-background-inverse/10 text-text-primary"
                      : "border-border-primary bg-background-tertiary text-text-secondary hover:border-ring-primary/50"
                  )}
                >
                  <Terminal size={16} />
                  <div className="text-left">
                    <div className="font-medium">Local (stdio)</div>
                    <div className="text-xs opacity-70">Run a local process</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setTransport("streamable-http")}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2.5 rounded-md border text-sm transition-colors",
                    transport === "streamable-http"
                      ? "border-ring-primary bg-background-inverse/10 text-text-primary"
                      : "border-border-primary bg-background-tertiary text-text-secondary hover:border-ring-primary/50"
                  )}
                >
                  <Globe size={16} />
                  <div className="text-left">
                    <div className="font-medium">Remote (HTTP)</div>
                    <div className="text-xs opacity-70">Connect via URL</div>
                  </div>
                </button>
              </div>
            </div>

            {/* Streamable HTTP Fields */}
            {transport === "streamable-http" && (
              <>
                {/* URL field */}
                <div className="mb-4">
                  <label
                    htmlFor="mcp-url"
                    className="block mb-1.5 text-sm font-medium text-text-secondary"
                  >
                    Server URL
                  </label>
                  <input
                    id="mcp-url"
                    type="text"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com/mcp"
                    className="w-full px-3 py-2.5 bg-background-tertiary border border-border-primary rounded-md text-text-primary text-sm focus:outline-none focus:border-ring-primary placeholder:text-text-secondary"
                  />
                  <p className="text-xs text-text-secondary mt-1">
                    The MCP endpoint URL (e.g., https://api.example.com/mcp)
                  </p>
                </div>

                {/* HTTP Headers */}
                <div className="mb-4">
                  <label className="block mb-1.5 text-sm font-medium text-text-secondary">
                    HTTP Headers
                  </label>
                  <div className="flex flex-col gap-2">
                    {headerVars.map((header, index) => (
                      <div key={index} className="flex gap-2 items-center">
                        <input
                          type="text"
                          value={header.key}
                          onChange={(e) => updateHeaderVar(index, "key", e.target.value)}
                          placeholder="Header-Name"
                          className="flex-1 px-3 py-2.5 bg-background-tertiary border border-border-primary rounded-md text-text-primary text-sm focus:outline-none focus:border-ring-primary placeholder:text-text-secondary"
                        />
                        <input
                          type="text"
                          value={header.value}
                          onChange={(e) => updateHeaderVar(index, "value", e.target.value)}
                          placeholder="value"
                          className="flex-[2] px-3 py-2.5 bg-background-tertiary border border-border-primary rounded-md text-text-primary text-sm focus:outline-none focus:border-ring-primary placeholder:text-text-secondary"
                        />
                        <button
                          type="button"
                          className="p-2.5 rounded-md text-text-secondary hover:text-text-danger hover:bg-background-danger/10 transition-colors cursor-pointer"
                          onClick={() => removeHeaderVar(index)}
                          title="Remove header"
                        >
                          <X size={14} weight="bold" />
                        </button>
                      </div>
                    ))}
                    <Button type="button" variant="outline-muted" onClick={addHeaderVar}>
                      + Add Header
                    </Button>
                  </div>
                  <p className="text-xs text-text-secondary mt-1">
                    Add authentication headers (e.g., Authorization: Bearer token)
                  </p>
                </div>
              </>
            )}

            {/* Stdio Fields */}
            {transport === "stdio" && (
              <>
                {/* Command field */}
                <div className="mb-4">
                  <label
                    htmlFor="mcp-command"
                    className="block mb-1.5 text-sm font-medium text-text-secondary"
                  >
                    Command
                  </label>
                  <input
                    id="mcp-command"
                    type="text"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="e.g., npx"
                    className="w-full px-3 py-2.5 bg-background-tertiary border border-border-primary rounded-md text-text-primary text-sm focus:outline-none focus:border-ring-primary placeholder:text-text-secondary"
                  />
                </div>

                {/* Arguments field */}
                <div className="mb-4">
                  <label
                    htmlFor="mcp-args"
                    className="block mb-1.5 text-sm font-medium text-text-secondary"
                  >
                    Arguments (space-separated)
                  </label>
                  <input
                    id="mcp-args"
                    type="text"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder="e.g., @modelcontextprotocol/server-filesystem /path"
                    className="w-full px-3 py-2.5 bg-background-tertiary border border-border-primary rounded-md text-text-primary text-sm focus:outline-none focus:border-ring-primary placeholder:text-text-secondary"
                  />
                </div>

                {/* Working Directory field */}
                <div className="mb-4">
                  <label
                    htmlFor="mcp-cwd"
                    className="block mb-1.5 text-sm font-medium text-text-secondary"
                  >
                    Working Directory
                  </label>
                  <input
                    id="mcp-cwd"
                    type="text"
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                    placeholder="e.g., /path/to/server"
                    className="w-full px-3 py-2.5 bg-background-tertiary border border-border-primary rounded-md text-text-primary text-sm focus:outline-none focus:border-ring-primary placeholder:text-text-secondary"
                  />
                </div>

                {/* Environment Variables */}
                <div className="mb-4">
                  <label className="block mb-1.5 text-sm font-medium text-text-secondary">
                    Environment Variables
                  </label>
                  <div className="flex flex-col gap-2">
                    {envVars.map((env, index) => (
                      <div key={index} className="flex gap-2 items-center">
                        <input
                          type="text"
                          value={env.key}
                          onChange={(e) => updateEnvVar(index, "key", e.target.value)}
                          placeholder="KEY"
                          className="flex-1 px-3 py-2.5 bg-background-tertiary border border-border-primary rounded-md text-text-primary text-sm focus:outline-none focus:border-ring-primary placeholder:text-text-secondary"
                        />
                        <input
                          type="text"
                          value={env.value}
                          onChange={(e) => updateEnvVar(index, "value", e.target.value)}
                          placeholder="value"
                          className="flex-[2] px-3 py-2.5 bg-background-tertiary border border-border-primary rounded-md text-text-primary text-sm focus:outline-none focus:border-ring-primary placeholder:text-text-secondary"
                        />
                        <button
                          type="button"
                          className="p-2.5 rounded-md text-text-secondary hover:text-text-danger hover:bg-background-danger/10 transition-colors cursor-pointer"
                          onClick={() => removeEnvVar(index)}
                          title="Remove variable"
                        >
                          <X size={14} weight="bold" />
                        </button>
                      </div>
                    ))}
                    <Button type="button" variant="outline-muted" onClick={addEnvVar}>
                      + Add Environment Variable
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-3 px-5 py-4 border-t border-border-primary">
            <Button type="button" variant="outline-muted" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">
              {isNew ? "Add Server" : "Save Changes"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface CreateMcpFormProps {
  existingNames: string[];
  onComplete: () => void;
  onCancel: () => void;
}

/**
 * CreateMcpForm Component
 *
 * Form for creating a new MCP from the template.
 * Allows the user to select a folder and name for the new MCP.
 */
function CreateMcpForm({ existingNames, onComplete, onCancel }: CreateMcpFormProps) {
  const [name, setName] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  /**
   * Validates the MCP name.
   * Must be lowercase alphanumeric with hyphens, 3-50 chars.
   */
  const validateName = (value: string): string | null => {
    if (!value.trim()) {
      return "Name is required";
    }
    if (!/^[a-z0-9-]+$/.test(value)) {
      return "Name must be lowercase letters, numbers, and hyphens only";
    }
    if (value.length < 3) {
      return "Name must be at least 3 characters";
    }
    if (value.length > 50) {
      return "Name must be 50 characters or less";
    }
    if (existingNames.includes(value)) {
      return "An MCP with this name already exists";
    }
    return null;
  };

  /**
   * Opens folder selection dialog.
   */
  const handleSelectFolder = useCallback(async () => {
    const folder = await window.electronAPI.selectFolder();
    if (folder) {
      setTargetPath(folder);
    }
  }, []);

  /**
   * Creates the new MCP from template.
   */
  const handleCreate = useCallback(async () => {
    setError(null);

    // Validate name
    const nameError = validateName(name);
    if (nameError) {
      setError(nameError);
      return;
    }

    // Validate folder
    if (!targetPath) {
      setError("Please select a folder");
      return;
    }

    setCreating(true);
    setStatus("Copying template...");

    try {
      setStatus("Installing dependencies (this may take a minute)...");
      const result = await window.electronAPI.mcp.createFromTemplate(targetPath, name);

      if (!result.success) {
        setError(result.error || "Failed to create MCP");
        setStatus(null);
        return;
      }

      setStatus("Done");
      // Wait a moment to show success message
      setTimeout(() => {
        onComplete();
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create MCP");
      setStatus(null);
    } finally {
      if (!error) {
        setCreating(false);
      }
    }
  }, [name, targetPath, existingNames, onComplete]);

  return (
    <div
      className="fixed inset-0 bg-background-primary/95 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="bg-background-primary border border-border-primary rounded-xl w-[90%] max-w-[500px] max-h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-primary">
          <h2 className="text-base font-semibold text-text-primary">Create New MCP</h2>
          <button
            className="text-2xl text-text-secondary hover:text-text-primary transition-colors cursor-pointer p-0 bg-transparent border-none leading-none"
            onClick={onCancel}
            disabled={creating}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 relative">
          {/* Status overlay - shows during creation */}
          {status && (
            <div className="absolute inset-0 flex items-center justify-center bg-background-primary z-10">
              <span className="text-sm text-text-primary animate-pulse">
                {status}
              </span>
            </div>
          )}

          {error && (
            <div className="bg-background-danger/10 border border-border-danger text-text-danger px-3 py-2.5 rounded-md mb-4 text-sm">
              {error}
            </div>
          )}

          <p className="text-sm text-text-secondary mb-4">
            Create a new MCP App from the example template.
            The template includes tools and a Pip UI.
          </p>

          {/* Name field */}
          <div className="mb-4">
            <label
              htmlFor="create-mcp-name"
              className="block mb-1.5 text-sm font-medium text-text-secondary"
            >
              MCP Name
            </label>
            <input
              id="create-mcp-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              placeholder="e.g., my-custom-mcp"
              disabled={creating}
              className={cn(
                "w-full px-3 py-2.5 bg-background-tertiary border border-border-primary rounded-md text-text-primary text-sm",
                "focus:outline-none focus:border-ring-primary",
                "disabled:opacity-60 disabled:cursor-not-allowed",
                "placeholder:text-text-secondary"
              )}
            />
            <p className="text-xs text-text-secondary mt-1">
              Lowercase letters, numbers, and hyphens only
            </p>
          </div>

          {/* Folder selection */}
          <div className="mb-4">
            <label className="block mb-1.5 text-sm font-medium text-text-secondary">
              Location
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={targetPath}
                readOnly
                placeholder="Select a folder..."
                className="flex-1 px-3 py-2.5 bg-background-tertiary border border-border-primary rounded-md text-text-primary text-sm placeholder:text-text-secondary"
              />
              <Button type="button" variant="outline-muted" onClick={handleSelectFolder} disabled={creating}>
                Browse
              </Button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-border-primary">
          <Button type="button" variant="outline-muted" onClick={onCancel} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={creating || !name || !targetPath}>
            {creating ? "Creating..." : "Create MCP"}
          </Button>
        </div>
      </div>
    </div>
  );
}
