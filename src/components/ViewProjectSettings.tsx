import { useState, useCallback, useEffect } from "react";
import { useApp } from "../contexts/AppContext";
import { X, ArrowClockwise, PencilSimple, Trash, Cube, FileText, Folder, Briefcase, Laptop, Globe, Plus, GitBranch } from "@phosphor-icons/react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Label } from "./Label";
import { Textarea } from "./Textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./Table";
import { cn } from "../lib/utils";
import { toast } from "sonner";
import type { MCPServerConfigForRenderer } from "../electron/preload";

interface ViewProjectSettingsProps {
  onClose: () => void;
}

interface EnvVar {
  key: string;
  value: string;
}

interface HeaderVar {
  key: string;
  value: string;
}

type MCPTransportType = "stdio" | "streamable-http";
type MCPSourceType = MCPTransportType | "git";

/**
 * Built-in MCP definitions with descriptions.
 * These are shipped with the app and don't require user configuration.
 */
const BUILTIN_MCPS = [
  { name: "browser", description: "Web browser automation" },
  { name: "todos", description: "Task management" },
  { name: "notes", description: "Note taking" },
  { name: "crm", description: "Contact and relationship management" },
  { name: "ide", description: "Read and write files within the project directory" },
  { name: "terminal", description: "Execute terminal commands" },
];

const formatGitDescription = (git: { url: string; ref?: string; subdir?: string }): string => {
  let description = git.url;
  if (git.ref) {
    description += `@${git.ref}`;
  }
  if (git.subdir) {
    const normalized = git.subdir.replace(/^\/+/, "");
    description += `/${normalized}`;
  }
  return description;
};

/**
 * ViewProjectSettings Component
 *
 * Project settings page that overlays the chat view.
 * Contains settings for project name, custom instructions, folder path, and MCPs.
 */
export function ViewProjectSettings({ onClose }: ViewProjectSettingsProps) {
  const { session, setProject } = useApp();

  // Context state
  const [projectName, setProjectName] = useState(session.project?.name || "");
  const [customInstructions, setCustomInstructions] = useState(
    session.project?.context?.custom_instructions || ""
  );
  const [localDirectory, setLocalDirectory] = useState(session.project?.context?.local_directory?.path || "");
  const [isSaving, setIsSaving] = useState(false);

  // MCP state
  const [mcpServers, setMcpServers] = useState<MCPServerConfigForRenderer[]>([]);
  const [initialMcpServers, setInitialMcpServers] = useState<MCPServerConfigForRenderer[]>([]);
  const [isLoadingMcps, setIsLoadingMcps] = useState(false);
  const [restartingServer, setRestartingServer] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  // Track MCPs marked for deletion (only applied on Save Changes)
  const [mcpsToDelete, setMcpsToDelete] = useState<Set<string>>(new Set());
  // Track MCPs to be added (re-enabled built-ins)
  const [mcpsToAdd, setMcpsToAdd] = useState<Set<string>>(new Set());

  // Dialog state
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingMcp, setEditingMcp] = useState<MCPServerConfigForRenderer | null>(null);

  /**
   * Load MCP servers for the current project.
   */
  const loadMcpServers = useCallback(async () => {
    if (!session.project) return;
    setIsLoadingMcps(true);
    try {
      const servers = await window.electronAPI.mcp.getConfigs();
      setMcpServers(servers);
      setInitialMcpServers(servers);
    } catch (error) {
      console.error("Failed to load MCP servers:", error);
      setMcpError(error instanceof Error ? error.message : "Failed to load MCPs");
    } finally {
      setIsLoadingMcps(false);
    }
  }, [session.project]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.mcp.onStatus((data) => {
      setMcpServers((prev) =>
        prev.map((server) =>
          server.name === data.name
            ? { ...server, status: data.status, lastError: data.error }
            : server
        )
      );
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Load MCPs on mount
  useEffect(() => {
    loadMcpServers();
  }, [loadMcpServers]);

  /**
   * Opens folder selection dialog for local directory.
   */
  const handleSelectLocalDirectory = useCallback(async () => {
    const folder = await window.electronAPI.selectFolder();
    if (folder) {
      setLocalDirectory(folder);
    }
  }, []);

  /**
   * Clears the local directory selection.
   */
  const handleClearLocalDirectory = useCallback(() => {
    setLocalDirectory("");
  }, []);

  /**
   * Save all changes (context + MCPs).
   * MCPs are saved and new ones are connected.
   */
  const handleSaveChanges = async () => {
    if (!session.project) return;

    setIsSaving(true);
    try {
      // Build the flat MCP list - all MCPs that should be active
      const projectMcps: Array<{ name: string; transport?: string; url?: string; headers?: Record<string, string>; git?: { url: string; ref?: string; subdir?: string }; command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; enabled: boolean }> = [];

      // Add existing MCPs (not marked for deletion)
      for (const mcp of mcpServers) {
        if (mcpsToDelete.has(mcp.name)) continue;

        if (mcp.scope === "custom") {
          // Custom MCPs need full config
          if (mcp.git?.url) {
            projectMcps.push({
              name: mcp.name,
              transport: mcp.git.transport ?? "streamable-http",
              git: mcp.git,
              enabled: true,
            });
          } else if (mcp.transport === "streamable-http") {
            projectMcps.push({
              name: mcp.name,
              transport: mcp.transport,
              url: mcp.url,
              headers: mcp.headers,
              enabled: true,
            });
          } else {
            projectMcps.push({
              name: mcp.name,
              transport: mcp.transport,
              command: mcp.command,
              args: mcp.args,
              cwd: mcp.cwd,
              env: mcp.env,
              enabled: true,
            });
          }
        } else {
          // Built-in MCPs just need name
          projectMcps.push({ name: mcp.name, enabled: true });
        }
      }

      // Add newly added built-in MCPs
      for (const mcpName of mcpsToAdd) {
        projectMcps.push({ name: mcpName, enabled: true });
      }

      // Track what needs to be connected/disconnected
      const initialNames = new Set(initialMcpServers.map(s => s.name));
      const mcpsToDisconnect = Array.from(mcpsToDelete);
      const mcpsToConnect = projectMcps.filter(m => !initialNames.has(m.name));

      // Build context with local_directory if set
      const updatedContext: { custom_instructions?: string; local_directory?: { path: string } } = {
        custom_instructions: customInstructions || undefined,
        local_directory: localDirectory ? { path: localDirectory } : undefined,
      };

      const result = await window.electronAPI.project.update({
        projectId: session.project.id,
        name: projectName,
        context: updatedContext,
        mcps: projectMcps,
      });

      if (result.success && result.project) {
        setProject(result.project);

        // Disconnect deleted MCPs
        for (const mcpName of mcpsToDisconnect) {
          try {
            await window.electronAPI.mcp.disable(mcpName);
          } catch (error) {
            console.error(`Failed to disconnect MCP ${mcpName}:`, error);
          }
        }

        // Connect newly added MCPs (pass config for custom MCPs)
        for (const mcp of mcpsToConnect) {
          try {
            await window.electronAPI.mcp.restart(mcp.name, mcp);
          } catch (error) {
            console.error(`Failed to connect MCP ${mcp.name}:`, error);
            toast.error(`Failed to connect ${mcp.name}`);
          }
        }

        // Clear markers and reload
        setMcpsToDelete(new Set());
        setMcpsToAdd(new Set());
        await loadMcpServers();
        toast.success("Settings saved");
      } else {
        toast.error(result.error || "Failed to save settings");
      }
    } catch (error) {
      toast.error("Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Restart an MCP server.
   */
  const handleRestartMcp = async (name: string) => {
    setRestartingServer(name);
    try {
      const result = await window.electronAPI.mcp.restart(name);
      if (result.success) {
        toast.success(`${name} restarted`);
      } else {
        toast.error(result.error || "Failed to restart MCP");
      }
    } catch (error) {
      toast.error("Failed to restart MCP");
    } finally {
      setRestartingServer(null);
    }
  };

  /**
   * Edit an existing custom MCP.
   */
  const handleEditMcp = (mcp: MCPServerConfigForRenderer) => {
    setEditingMcp(mcp);
    setShowAddDialog(false);
  };

  /**
   * Open the Add MCPs dialog.
   */
  const handleOpenAddDialog = () => {
    setShowAddDialog(true);
    setEditingMcp(null);
  };

  /**
   * Save custom MCP from dialog to local state.
   * Changes are not persisted until "Save Changes" is clicked.
   */
  const handleCustomMcpSave = (mcpConfig: MCPServerConfigForRenderer) => {
    if (editingMcp) {
      // Update existing MCP in local state
      setMcpServers(mcpServers.map((s) =>
        s.name === editingMcp.name ? { ...mcpConfig, scope: s.scope } : s
      ));
    } else {
      // Add new MCP to local state
      setMcpServers([...mcpServers, { ...mcpConfig, scope: "custom" as const }]);
    }

    setEditingMcp(null);
    setShowAddDialog(false);
  };

  /**
   * Add a built-in MCP back to the project.
   * This marks it for re-enabling on save.
   */
  const handleAddBuiltinMcp = (name: string) => {
    // If it was marked for deletion, just undo that
    if (mcpsToDelete.has(name)) {
      handleUndoMcpDeletion(name);
    } else {
      // Mark for adding (will restart on save)
      setMcpsToAdd(new Set([...mcpsToAdd, name]));
    }
  };

  /**
   * Mark an MCP for deletion.
   * Deletion is not persisted until "Save Changes" is clicked.
   */
  const handleMarkMcpForDeletion = (name: string) => {
    setMcpsToDelete(new Set([...mcpsToDelete, name]));
    // If it was marked for adding, remove that
    if (mcpsToAdd.has(name)) {
      const newSet = new Set(mcpsToAdd);
      newSet.delete(name);
      setMcpsToAdd(newSet);
    }
  };

  /**
   * Undo marking an MCP for deletion.
   */
  const handleUndoMcpDeletion = (name: string) => {
    const newSet = new Set(mcpsToDelete);
    newSet.delete(name);
    setMcpsToDelete(newSet);
  };

  /**
   * Get list of built-in MCPs that are not currently in the project.
   */
  const getAvailableBuiltinMcps = () => {
    const currentMcpNames = new Set(mcpServers.map(s => s.name));

    return BUILTIN_MCPS.filter(mcp =>
      (!currentMcpNames.has(mcp.name) || mcpsToDelete.has(mcp.name)) // Not in project or marked for deletion
    ).filter(mcp => !mcpsToAdd.has(mcp.name)); // Not already being added
  };

  return (
    <div className="absolute inset-0 z-50 bg-background-primary flex flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border-secondary">
        <div className="flex items-center justify-between px-6 py-4">
          <h1 className="text-base font-medium text-text-primary">Project Settings</h1>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-background-tertiary text-text-secondary hover:text-text-primary transition-colors focus:outline-none"
            title="Close"
          >
            <X size={16} weight="bold" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-6 flex justify-center">
          <div className="w-full max-w-[800px]">
            {/* Page Title */}
            <div className="mb-12 flex items-start justify-between">
              <div>
                <h2 className="text-base font-medium text-text-primary">Context</h2>
                <p className="text-sm text-text-secondary mt-1">Configure instructions, MCPs and resources for the AI agent in this project</p>
              </div>
              <Button onClick={handleSaveChanges} disabled={isSaving}>
                {isSaving ? "Saving..." : "Save Changes"}
              </Button>
            </div>

            {/* Project Name */}
            <div className="mb-10">
              <Label>
                <div className="flex items-center gap-2">
                  <Briefcase size={14} weight="regular" />
                  <span>Project Name</span>
                </div>
              </Label>
              <Input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Enter project name..."
              />
            </div>

            {/* Custom Instructions */}
            <div className="mb-10">
              <Label>
                <div className="flex items-center gap-2">
                  <FileText size={14} weight="regular" />
                  <span>Custom Instructions</span>
                </div>
              </Label>
              <Textarea
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                placeholder="Add custom instructions for the AI..."
                className="h-32"
              />
            </div>

            {/* Local Directory - editable for all projects */}
            <div className="mb-10">
              <Label>
                <div className="flex items-center gap-2">
                  <Folder size={14} weight="regular" />
                  <span>Local Directory</span>
                  {(session.project?.profile === "dev-general" || session.project?.profile === "dev-mcp") && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-background-tertiary text-text-secondary">required</span>
                  )}
                </div>
              </Label>
              <div className="flex gap-2">
                <Input
                  type="text"
                  value={localDirectory}
                  readOnly
                  placeholder="No folder selected"
                  className="flex-1 bg-background-tertiary text-text-secondary cursor-default"
                />
                <Button variant="secondary" onClick={handleSelectLocalDirectory}>
                  Browse
                </Button>
                {localDirectory && (
                  <Button variant="secondary" onClick={handleClearLocalDirectory}>
                    Clear
                  </Button>
                )}
              </div>
              <p className="text-sm text-text-tertiary mt-2">
                {(session.project?.profile === "dev-general" || session.project?.profile === "dev-mcp")
                  ? "Required for development projects. The agent can read and write files in this directory."
                  : "Optional. Select a folder for the agent to access files."}
              </p>
            </div>

            {/* MCPs Section */}
            <div>
              <div className="mb-4 flex items-start justify-between">
                <div>
                  <h2 className="text-base font-medium text-text-primary flex items-center gap-2">
                    <Cube size={16} weight="regular" />
                    <span>MCPs</span>
                  </h2>
                  <p className="text-sm text-text-secondary mt-1">Manage the MCP Servers that are available in this project</p>
                </div>
                <Button variant="secondary" size="sm" onClick={handleOpenAddDialog}>
                  Add MCPs
                </Button>
              </div>

              {mcpError && (
                <div className="alert alert-destructive mb-4">
                  {mcpError}
                </div>
              )}

              {/* MCP List */}
              <div className="mb-4">
                {isLoadingMcps ? (
                  <p className="text-base text-text-secondary">Loading MCPs...</p>
                ) : mcpServers.length === 0 && mcpsToAdd.size === 0 ? (
                  <p className="text-base text-text-secondary">
                    No MCPs configured.
                  </p>
                ) : (
                  <>
                    <div className="rounded-md border border-border-primary">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[180px]">Name</TableHead>
                            <TableHead className="w-auto">Description</TableHead>
                            <TableHead className="w-[100px]">Type</TableHead>
                            <TableHead className="w-[120px] text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {/* Show MCPs marked to be added */}
                          {Array.from(mcpsToAdd).map((mcpName) => {
                            const builtinDef = BUILTIN_MCPS.find(b => b.name === mcpName);
                            return (
                              <TableRow key={mcpName} className="bg-background-secondary/30">
                                <TableCell className="font-medium w-[180px]">
                                  <div className="flex items-center gap-2">
                                    <Cube size={14} className="flex-shrink-0 text-ring-primary" />
                                    <span className="truncate">{mcpName}</span>
                                    <span className="text-[9px] px-1 py-0.5 rounded bg-ring-primary/20 text-ring-primary">new</span>
                                  </div>
                                </TableCell>
                                <TableCell className="text-text-secondary w-auto">
                                  <div className="break-words">{builtinDef?.description || ""}</div>
                                </TableCell>
                                <TableCell className="w-[120px]">
                                  <span className="text-[9px] px-1.5 py-0.5 rounded border bg-background-tertiary border-border-primary text-text-secondary whitespace-nowrap">
                                    built-in
                                  </span>
                                </TableCell>
                                <TableCell className="w-[120px] text-right">
                                  <button
                                    className="text-sm text-text-secondary hover:text-text-primary transition-colors focus:outline-none"
                                    onClick={() => {
                                      const newSet = new Set(mcpsToAdd);
                                      newSet.delete(mcpName);
                                      setMcpsToAdd(newSet);
                                    }}
                                    title="Remove"
                                  >
                                    Undo
                                  </button>
                                </TableCell>
                              </TableRow>
                            );
                          })}

                          {/* Show existing MCPs */}
                          {mcpServers.map((mcp) => {
                            const isMarkedForDeletion = mcpsToDelete.has(mcp.name);
                            const hasError = mcp.status === "error";

                            // Generate description based on MCP type
                            let description = "";
                            if (mcp.scope === "builtin") {
                              const builtinDef = BUILTIN_MCPS.find(b => b.name === mcp.name);
                              description = builtinDef?.description || "";
                            } else if (mcp.git?.url) {
                              description = formatGitDescription(mcp.git);
                            } else if (mcp.transport === "streamable-http" && mcp.url) {
                              description = mcp.url;
                            } else {
                              description = mcp.command ? `${mcp.command} ${mcp.args?.join(" ") || ""}` : "Custom MCP server";
                            }

                            return (
                              <TableRow key={mcp.name} className={isMarkedForDeletion ? "opacity-50" : ""}>
                                <TableCell className="font-medium w-[180px]">
                                  <div className="flex items-center gap-2">
                                    <Cube size={14} className={cn("flex-shrink-0", isMarkedForDeletion ? "text-text-secondary" : "text-ring-primary")} />
                                    <span className={cn("truncate", isMarkedForDeletion && "line-through")}>{mcp.name}</span>
                                  </div>
                                </TableCell>
                                <TableCell className="text-text-secondary w-auto">
                                  <div className="break-words">{description}</div>
                                  {hasError && (
                                    <div className="text-[11px] text-text-danger mt-1 break-words">
                                      Failed to start{mcp.lastError ? `: ${mcp.lastError}` : "."}
                                    </div>
                                  )}
                                </TableCell>
                                <TableCell className="w-[120px]">
                                  <div className="flex items-center gap-1">
                                    <span className="text-[9px] px-1.5 py-0.5 rounded border bg-background-tertiary border-border-primary text-text-secondary whitespace-nowrap">
                                      {mcp.scope === "builtin" ? "built-in" : mcp.scope === "development" ? "dev" : "custom"}
                                    </span>
                                    {hasError && (
                                      <span className="text-[9px] px-1.5 py-0.5 rounded border border-border-danger text-text-danger bg-background-danger/10 whitespace-nowrap">
                                        error
                                      </span>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="w-[120px] text-right">
                                  <div className="flex items-center justify-end gap-2">
                                    {isMarkedForDeletion ? (
                                      <button
                                        className="text-sm text-text-secondary hover:text-text-primary transition-colors focus:outline-none"
                                        onClick={() => handleUndoMcpDeletion(mcp.name)}
                                        title="Undo"
                                      >
                                        Undo
                                      </button>
                                    ) : (
                                      <>
                                        <button
                                          className={cn(
                                            "p-1 rounded text-text-secondary hover:text-text-primary transition-colors focus:outline-none",
                                            restartingServer === mcp.name && "animate-spin"
                                          )}
                                          onClick={() => handleRestartMcp(mcp.name)}
                                          disabled={restartingServer === mcp.name}
                                          title="Restart"
                                        >
                                          <ArrowClockwise size={11} />
                                        </button>

                                        {mcp.scope === "custom" && (
                                          <button
                                            className="p-1 rounded text-text-secondary hover:text-text-primary transition-colors focus:outline-none"
                                            onClick={() => handleEditMcp(mcp)}
                                            title="Edit"
                                          >
                                            <PencilSimple size={11} />
                                          </button>
                                        )}

                                        <button
                                          className="p-1 rounded text-text-secondary hover:text-text-danger transition-colors focus:outline-none"
                                          onClick={() => handleMarkMcpForDeletion(mcp.name)}
                                          title="Delete"
                                        >
                                          <Trash size={11} />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Add MCPs Dialog (tabbed) */}
      {showAddDialog && (
        <AddMcpDialog
          availableBuiltinMcps={getAvailableBuiltinMcps()}
          existingNames={mcpServers.map((s) => s.name)}
          onAddBuiltin={handleAddBuiltinMcp}
          onAddCustom={handleCustomMcpSave}
          onClose={() => setShowAddDialog(false)}
        />
      )}

      {/* Edit Custom MCP Dialog (no tabs) */}
      {editingMcp && (
        <CustomMcpForm
          mcp={editingMcp}
          existingNames={mcpServers.map((s) => s.name).filter((n) => n !== editingMcp.name)}
          onSave={handleCustomMcpSave}
          onCancel={() => setEditingMcp(null)}
        />
      )}
    </div>
  );
}

/**
 * Add MCP Dialog with tabs for built-in MCPs and custom MCPs.
 */
interface AddMcpDialogProps {
  availableBuiltinMcps: typeof BUILTIN_MCPS;
  existingNames: string[];
  onAddBuiltin: (name: string) => void;
  onAddCustom: (mcp: MCPServerConfigForRenderer) => void;
  onClose: () => void;
}

function AddMcpDialog({ availableBuiltinMcps, existingNames, onAddBuiltin, onAddCustom, onClose }: AddMcpDialogProps) {
  const [activeTab, setActiveTab] = useState<"mcps" | "custom">("mcps");

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-background-primary/95 dialog-overlay"
        onClick={onClose}
        data-state="open"
      />
      <div
        className="fixed z-50 grid w-full max-w-lg gap-4 border border-border-primary bg-background-primary p-8 shadow-lg rounded-lg dialog-content"
        onClick={(e) => e.stopPropagation()}
        data-state="open"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4">
          <h2 className="text-lg font-medium text-text-primary">Add MCPs</h2>
          <button
            className="text-text-secondary hover:text-text-primary transition-colors cursor-pointer p-0 bg-transparent border-none"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-border-secondary mb-6">
          <button
            className={cn(
              "px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px",
              activeTab === "mcps"
                ? "text-text-primary border-ring-primary"
                : "text-text-secondary border-transparent hover:text-text-primary"
            )}
            onClick={() => setActiveTab("mcps")}
          >
            MCPs
          </button>
          <button
            className={cn(
              "px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px",
              activeTab === "custom"
                ? "text-text-primary border-ring-primary"
                : "text-text-secondary border-transparent hover:text-text-primary"
            )}
            onClick={() => setActiveTab("custom")}
          >
            Custom
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === "mcps" && (
          <BuiltinMcpList
            mcps={availableBuiltinMcps}
            onAdd={(name) => {
              onAddBuiltin(name);
              onClose();
            }}
          />
        )}

        {activeTab === "custom" && (
          <CustomMcpFormInline
            existingNames={existingNames}
            onSave={(mcp) => {
              onAddCustom(mcp);
              onClose();
            }}
            onCancel={onClose}
          />
        )}
      </div>
    </>
  );
}

/**
 * List of available built-in MCPs to add.
 */
interface BuiltinMcpListProps {
  mcps: typeof BUILTIN_MCPS;
  onAdd: (name: string) => void;
}

function BuiltinMcpList({ mcps, onAdd }: BuiltinMcpListProps) {
  if (mcps.length === 0) {
    return (
      <div className="text-center py-8 text-text-secondary text-base">
        All built-in MCPs are already in this project.
      </div>
    );
  }

  return (
    <div className="space-y-3 max-h-[300px] overflow-y-auto">
      {mcps.map((mcp) => (
        <div
          key={mcp.name}
          className="flex items-center justify-between p-3 rounded-md border border-border-secondary hover:border-border-primary transition-colors"
        >
          <div className="flex items-center gap-3">
            <Cube size={16} className="text-ring-primary flex-shrink-0" />
            <div>
              <div className="text-base font-medium text-text-primary">{mcp.name}</div>
              <div className="text-sm text-text-secondary">{mcp.description}</div>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={() => onAdd(mcp.name)}>
            <Plus size={12} className="mr-1" />
            Add
          </Button>
        </div>
      ))}
    </div>
  );
}

/**
 * Inline custom MCP form (used in tabbed dialog).
 */
interface CustomMcpFormInlineProps {
  existingNames: string[];
  onSave: (mcp: MCPServerConfigForRenderer) => void;
  onCancel: () => void;
}

function CustomMcpFormInline({ existingNames, onSave, onCancel }: CustomMcpFormInlineProps) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<MCPSourceType>("streamable-http");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitSubdir, setGitSubdir] = useState("");
  const [gitTransport, setGitTransport] = useState<MCPTransportType>("streamable-http");
  const [gitSetupCommand, setGitSetupCommand] = useState("");
  const [gitStartCommand, setGitStartCommand] = useState("");
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [headers, setHeaders] = useState<HeaderVar[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    if (existingNames.includes(name.trim())) {
      setError("An MCP with this name already exists");
      return;
    }

    if (source === "stdio" && !command.trim()) {
      setError("Command is required for Local transport");
      return;
    }

    if (source === "streamable-http" && !url.trim()) {
      setError("URL is required for HTTP transport");
      return;
    }

    if (source === "git" && !gitUrl.trim()) {
      setError("Repo URL is required for Git source");
      return;
    }

    if (source === "git" && gitTransport === "stdio" && !gitStartCommand.trim()) {
      setError("Start command is required for stdio Git MCPs");
      return;
    }

    const envObj: Record<string, string> = {};
    for (const v of envVars) {
      if (v.key.trim()) {
        envObj[v.key.trim()] = v.value;
      }
    }

    const headersObj: Record<string, string> = {};
    for (const h of headers) {
      if (h.key.trim()) {
        headersObj[h.key.trim()] = h.value;
      }
    }

    const config: MCPServerConfigForRenderer = {
      name: name.trim(),
      transport: source === "git" ? gitTransport : source,
      enabled: true,
      scope: "custom",
      command: "",
      args: [],
    };

    if (source === "git") {
      config.git = {
        url: gitUrl.trim(),
        ref: gitRef.trim() || undefined,
        subdir: gitSubdir.trim() || undefined,
        transport: gitTransport,
        setupCommand: gitSetupCommand.trim() || undefined,
        startCommand: gitStartCommand.trim() || undefined,
      };
    } else if (source === "stdio") {
      config.command = command.trim();
      config.args = args.trim() ? args.trim().split(/\s+/) : [];
      if (Object.keys(envObj).length > 0) {
        config.env = envObj;
      }
    } else {
      config.url = url.trim();
      if (Object.keys(headersObj).length > 0) {
        config.headers = headersObj;
      }
    }

    onSave(config);
  };

  const addEnvVar = () => setEnvVars([...envVars, { key: "", value: "" }]);
  const removeEnvVar = (index: number) => setEnvVars(envVars.filter((_, i) => i !== index));
  const updateEnvVar = (index: number, field: "key" | "value", value: string) => {
    const newVars = [...envVars];
    newVars[index][field] = value;
    setEnvVars(newVars);
  };

  const addHeader = () => setHeaders([...headers, { key: "", value: "" }]);
  const removeHeader = (index: number) => setHeaders(headers.filter((_, i) => i !== index));
  const updateHeader = (index: number, field: "key" | "value", value: string) => {
    const newHeaders = [...headers];
    newHeaders[index][field] = value;
    setHeaders(newHeaders);
  };

  return (
    <div>
      {error && (
        <div className="border border-border-danger bg-background-danger/10 text-text-danger text-sm rounded-md p-3 mb-4">
          {error}
        </div>
      )}

      {/* Name */}
      <div className="mb-4">
        <Label>Name</Label>
        <Input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-mcp"
        />
      </div>

      {/* Source */}
      <div className="mb-4">
        <Label>Source</Label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="source-inline"
              checked={source === "streamable-http"}
              onChange={() => setSource("streamable-http")}
              className="cursor-pointer"
            />
            <span className="flex items-center gap-1">
              <Globe size={14} />
              <span>HTTP</span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="source-inline"
              checked={source === "stdio"}
              onChange={() => setSource("stdio")}
              className="cursor-pointer"
            />
            <span className="flex items-center gap-1">
              <Laptop size={14} />
              <span>Stdio</span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="radio"
              name="source-inline"
              checked={source === "git"}
              onChange={() => setSource("git")}
              className="cursor-pointer"
            />
            <span className="flex items-center gap-1">
              <GitBranch size={14} />
              <span>Git</span>
            </span>
          </label>
        </div>
      </div>

      {/* HTTP-specific fields */}
      {source === "streamable-http" && (
        <>
          <div className="mb-4">
            <Label>URL</Label>
            <Input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
            />
          </div>
          <div className="mb-4">
            <Label>Headers</Label>
            <div className="max-h-[120px] overflow-y-auto border border-border-secondary rounded-md p-2">
              {headers.length === 0 ? (
                <p className="text-sm text-text-tertiary py-2 text-center">No headers</p>
              ) : (
                headers.map((h, i) => (
                  <div key={i} className="flex gap-2 mb-2 last:mb-0">
                    <Input
                      type="text"
                      value={h.key}
                      onChange={(e) => updateHeader(i, "key", e.target.value)}
                      placeholder="Header-Name"
                      className="flex-1"
                    />
                    <Input
                      type="text"
                      value={h.value}
                      onChange={(e) => updateHeader(i, "value", e.target.value)}
                      placeholder="value"
                      className="flex-1"
                    />
                    <button
                      onClick={() => removeHeader(i)}
                      className="p-2 text-text-secondary hover:text-text-danger transition-colors"
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <button
              onClick={addHeader}
              className="text-sm text-text-secondary hover:text-text-primary transition-colors mt-2"
            >
              + Add header
            </button>
          </div>
        </>
      )}

      {/* stdio-specific fields */}
      {source === "stdio" && (
        <>
          <div className="mb-4">
            <Label>Command</Label>
            <Input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
            />
          </div>
          <div className="mb-4">
            <Label>Arguments</Label>
            <Input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="@modelcontextprotocol/server-filesystem /path"
            />
          </div>
          <div className="mb-4">
            <Label>Environment Variables</Label>
            <div className="max-h-[120px] overflow-y-auto border border-border-secondary rounded-md p-2">
              {envVars.length === 0 ? (
                <p className="text-sm text-text-tertiary py-2 text-center">No environment variables</p>
              ) : (
                envVars.map((v, i) => (
                  <div key={i} className="flex gap-2 mb-2 last:mb-0">
                    <Input
                      type="text"
                      value={v.key}
                      onChange={(e) => updateEnvVar(i, "key", e.target.value)}
                      placeholder="KEY"
                      className="flex-1"
                    />
                    <Input
                      type="text"
                      value={v.value}
                      onChange={(e) => updateEnvVar(i, "value", e.target.value)}
                      placeholder="value"
                      className="flex-1"
                    />
                    <button
                      onClick={() => removeEnvVar(i)}
                      className="p-2 text-text-secondary hover:text-text-danger transition-colors"
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <button
              onClick={addEnvVar}
              className="text-sm text-text-secondary hover:text-text-primary transition-colors mt-2"
            >
              + Add variable
            </button>
          </div>
        </>
      )}

      {source === "git" && (
        <>
          <div className="mb-4">
            <Label>Transport</Label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="radio"
                  name="git-transport-inline"
                  checked={gitTransport === "streamable-http"}
                  onChange={() => setGitTransport("streamable-http")}
                  className="cursor-pointer"
                />
                <span className="flex items-center gap-1">
                  <Globe size={14} />
                  <span>HTTP</span>
                </span>
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="radio"
                  name="git-transport-inline"
                  checked={gitTransport === "stdio"}
                  onChange={() => setGitTransport("stdio")}
                  className="cursor-pointer"
                />
                <span className="flex items-center gap-1">
                  <Laptop size={14} />
                  <span>Stdio</span>
                </span>
              </label>
            </div>
          </div>
          <div className="mb-4">
            <Label>Repo URL</Label>
            <Input
              type="text"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://github.com/org/repo.git"
            />
          </div>
          <div className="mb-4">
            <Label>Ref (optional)</Label>
            <Input
              type="text"
              value={gitRef}
              onChange={(e) => setGitRef(e.target.value)}
              placeholder="main"
            />
          </div>
          <div className="mb-4">
            <Label>Subdir (optional)</Label>
            <Input
              type="text"
              value={gitSubdir}
              onChange={(e) => setGitSubdir(e.target.value)}
              placeholder="packages/my-mcp"
            />
          </div>
          <div className="mb-4">
            <Label>Setup Command (optional)</Label>
            <Input
              type="text"
              value={gitSetupCommand}
              onChange={(e) => setGitSetupCommand(e.target.value)}
              placeholder="npm install"
            />
          </div>
          <div className="mb-4">
            <Label>Start Command {gitTransport === "stdio" ? "(required)" : "(optional)"}</Label>
            <Input
              type="text"
              value={gitStartCommand}
              onChange={(e) => setGitStartCommand(e.target.value)}
              placeholder="npm run dev"
            />
          </div>
        </>
      )}

      {/* Footer */}
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleSubmit}>
          Add
        </Button>
      </div>
    </div>
  );
}

/**
 * Custom MCP Form Dialog (no tabs, for editing existing custom MCPs).
 */
interface CustomMcpFormProps {
  mcp: MCPServerConfigForRenderer;
  existingNames: string[];
  onSave: (mcp: MCPServerConfigForRenderer) => void;
  onCancel: () => void;
}

function CustomMcpForm({ mcp, existingNames, onSave, onCancel }: CustomMcpFormProps) {
  const [name, setName] = useState(mcp.name);
  const [source, setSource] = useState<MCPSourceType>(
    mcp.git?.url ? "git" : mcp.transport || "streamable-http"
  );
  const [command, setCommand] = useState(mcp.command || "");
  const [args, setArgs] = useState(mcp.args?.join(" ") || "");
  const [url, setUrl] = useState(mcp.url || "");
  const [gitUrl, setGitUrl] = useState(mcp.git?.url || "");
  const [gitRef, setGitRef] = useState(mcp.git?.ref || "");
  const [gitSubdir, setGitSubdir] = useState(mcp.git?.subdir || "");
  const [gitTransport, setGitTransport] = useState<MCPTransportType>(
    mcp.git?.transport || "streamable-http"
  );
  const [gitSetupCommand, setGitSetupCommand] = useState(mcp.git?.setupCommand || "");
  const [gitStartCommand, setGitStartCommand] = useState(mcp.git?.startCommand || "");
  const [envVars, setEnvVars] = useState<EnvVar[]>(
    Object.entries(mcp.env || {}).map(([key, value]) => ({ key, value }))
  );
  const [headers, setHeaders] = useState<HeaderVar[]>(
    Object.entries(mcp.headers || {}).map(([key, value]) => ({ key, value }))
  );
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    if (existingNames.includes(name.trim())) {
      setError("An MCP with this name already exists");
      return;
    }

    if (source === "stdio" && !command.trim()) {
      setError("Command is required for Local transport");
      return;
    }

    if (source === "streamable-http" && !url.trim()) {
      setError("URL is required for HTTP transport");
      return;
    }

    if (source === "git" && !gitUrl.trim()) {
      setError("Repo URL is required for Git source");
      return;
    }

    if (source === "git" && gitTransport === "stdio" && !gitStartCommand.trim()) {
      setError("Start command is required for stdio Git MCPs");
      return;
    }

    const envObj: Record<string, string> = {};
    for (const v of envVars) {
      if (v.key.trim()) {
        envObj[v.key.trim()] = v.value;
      }
    }

    const headersObj: Record<string, string> = {};
    for (const h of headers) {
      if (h.key.trim()) {
        headersObj[h.key.trim()] = h.value;
      }
    }

    const config: MCPServerConfigForRenderer = {
      name: name.trim(),
      transport: source === "git" ? gitTransport : source,
      enabled: true,
      scope: "custom",
      command: "",
      args: [],
    };

    if (source === "git") {
      config.git = {
        url: gitUrl.trim(),
        ref: gitRef.trim() || undefined,
        subdir: gitSubdir.trim() || undefined,
        transport: gitTransport,
        setupCommand: gitSetupCommand.trim() || undefined,
        startCommand: gitStartCommand.trim() || undefined,
      };
    } else if (source === "stdio") {
      config.command = command.trim();
      config.args = args.trim() ? args.trim().split(/\s+/) : [];
      if (Object.keys(envObj).length > 0) {
        config.env = envObj;
      }
    } else {
      config.url = url.trim();
      if (Object.keys(headersObj).length > 0) {
        config.headers = headersObj;
      }
    }

    onSave(config);
  };

  const addEnvVar = () => setEnvVars([...envVars, { key: "", value: "" }]);
  const removeEnvVar = (index: number) => setEnvVars(envVars.filter((_, i) => i !== index));
  const updateEnvVar = (index: number, field: "key" | "value", value: string) => {
    const newVars = [...envVars];
    newVars[index][field] = value;
    setEnvVars(newVars);
  };

  const addHeader = () => setHeaders([...headers, { key: "", value: "" }]);
  const removeHeader = (index: number) => setHeaders(headers.filter((_, i) => i !== index));
  const updateHeader = (index: number, field: "key" | "value", value: string) => {
    const newHeaders = [...headers];
    newHeaders[index][field] = value;
    setHeaders(newHeaders);
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-background-primary/95 dialog-overlay"
        onClick={onCancel}
        data-state="open"
      />
      <div
        className="fixed z-50 grid w-full max-w-lg gap-4 border border-border-primary bg-background-primary p-8 shadow-lg rounded-lg dialog-content"
        onClick={(e) => e.stopPropagation()}
        data-state="open"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4">
          <h2 className="text-lg font-medium text-text-primary">Edit MCP</h2>
          <button
            className="text-text-secondary hover:text-text-primary transition-colors cursor-pointer p-0 bg-transparent border-none"
            onClick={onCancel}
          >
            <X size={16} />
          </button>
        </div>

        <div>
          {error && (
            <div className="border border-border-danger bg-background-danger/10 text-text-danger text-xs rounded-md p-3 mb-4">
              {error}
            </div>
          )}

          {/* Name (disabled for editing) */}
          <div className="mb-4">
            <Label>Name</Label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-mcp"
              disabled
            />
          </div>

          {/* Source */}
          <div className="mb-4">
            <Label>Source</Label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="source-edit"
                  checked={source === "streamable-http"}
                  onChange={() => setSource("streamable-http")}
                  className="cursor-pointer"
                />
                <span className="flex items-center gap-1">
                  <Globe size={14} />
                  <span>HTTP</span>
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="source-edit"
                  checked={source === "stdio"}
                  onChange={() => setSource("stdio")}
                  className="cursor-pointer"
                />
                <span className="flex items-center gap-1">
                  <Laptop size={14} />
                  <span>Stdio</span>
                </span>
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="radio"
                  name="source-edit"
                  checked={source === "git"}
                  onChange={() => setSource("git")}
                  className="cursor-pointer"
                />
                <span className="flex items-center gap-1">
                  <GitBranch size={14} />
                  <span>Git</span>
                </span>
              </label>
            </div>
          </div>

          {/* HTTP-specific fields */}
          {source === "streamable-http" && (
            <>
              <div className="mb-4">
                <Label>URL</Label>
                <Input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                />
              </div>
              <div className="mb-4">
                <Label>Headers</Label>
                <div className="max-h-[120px] overflow-y-auto border border-border-secondary rounded-md p-2">
                  {headers.length === 0 ? (
                    <p className="text-sm text-text-tertiary py-2 text-center">No headers</p>
                  ) : (
                    headers.map((h, i) => (
                      <div key={i} className="flex gap-2 mb-2 last:mb-0">
                        <Input
                          type="text"
                          value={h.key}
                          onChange={(e) => updateHeader(i, "key", e.target.value)}
                          placeholder="Header-Name"
                          className="flex-1"
                        />
                        <Input
                          type="text"
                          value={h.value}
                          onChange={(e) => updateHeader(i, "value", e.target.value)}
                          placeholder="value"
                          className="flex-1"
                        />
                        <button
                          onClick={() => removeHeader(i)}
                          className="p-2 text-text-secondary hover:text-text-danger transition-colors"
                        >
                          <Trash size={14} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <button
                  onClick={addHeader}
                  className="text-sm text-text-secondary hover:text-text-primary transition-colors mt-2"
                >
                  + Add header
                </button>
              </div>
            </>
          )}

          {/* stdio-specific fields */}
          {source === "stdio" && (
            <>
              <div className="mb-4">
                <Label>Command</Label>
                <Input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                />
              </div>
              <div className="mb-4">
                <Label>Arguments</Label>
                <Input
                  type="text"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="@modelcontextprotocol/server-filesystem /path"
                />
              </div>
              <div className="mb-4">
                <Label>Environment Variables</Label>
                <div className="max-h-[120px] overflow-y-auto border border-border-secondary rounded-md p-2">
                  {envVars.length === 0 ? (
                    <p className="text-sm text-text-tertiary py-2 text-center">No environment variables</p>
                  ) : (
                    envVars.map((v, i) => (
                      <div key={i} className="flex gap-2 mb-2 last:mb-0">
                        <Input
                          type="text"
                          value={v.key}
                          onChange={(e) => updateEnvVar(i, "key", e.target.value)}
                          placeholder="KEY"
                          className="flex-1"
                        />
                        <Input
                          type="text"
                          value={v.value}
                          onChange={(e) => updateEnvVar(i, "value", e.target.value)}
                          placeholder="value"
                          className="flex-1"
                        />
                        <button
                          onClick={() => removeEnvVar(i)}
                          className="p-2 text-text-secondary hover:text-text-danger transition-colors"
                        >
                          <Trash size={14} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <button
                  onClick={addEnvVar}
                  className="text-sm text-text-secondary hover:text-text-primary transition-colors mt-2"
                >
                  + Add variable
                </button>
              </div>
            </>
          )}

          {source === "git" && (
            <>
              <div className="mb-4">
                <Label>Transport</Label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="radio"
                      name="git-transport-edit"
                      checked={gitTransport === "streamable-http"}
                      onChange={() => setGitTransport("streamable-http")}
                      className="cursor-pointer"
                    />
                    <span className="flex items-center gap-1">
                      <Globe size={14} />
                      <span>HTTP</span>
                    </span>
                  </label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="radio"
                      name="git-transport-edit"
                      checked={gitTransport === "stdio"}
                      onChange={() => setGitTransport("stdio")}
                      className="cursor-pointer"
                    />
                    <span className="flex items-center gap-1">
                      <Laptop size={14} />
                      <span>Stdio</span>
                    </span>
                  </label>
                </div>
              </div>
              <div className="mb-4">
                <Label>Repo URL</Label>
                <Input
                  type="text"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git"
                />
              </div>
              <div className="mb-4">
                <Label>Ref (optional)</Label>
                <Input
                  type="text"
                  value={gitRef}
                  onChange={(e) => setGitRef(e.target.value)}
                  placeholder="main"
                />
              </div>
              <div className="mb-4">
                <Label>Subdir (optional)</Label>
                <Input
                  type="text"
                  value={gitSubdir}
                  onChange={(e) => setGitSubdir(e.target.value)}
                  placeholder="packages/my-mcp"
                />
              </div>
              <div className="mb-4">
                <Label>Setup Command (optional)</Label>
                <Input
                  type="text"
                  value={gitSetupCommand}
                  onChange={(e) => setGitSetupCommand(e.target.value)}
                  placeholder="npm install"
                />
              </div>
              <div className="mb-4">
                <Label>Start Command {gitTransport === "stdio" ? "(required)" : "(optional)"}</Label>
                <Input
                  type="text"
                  value={gitStartCommand}
                  onChange={(e) => setGitStartCommand(e.target.value)}
                  placeholder="npm run dev"
                />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSubmit}>
            Save
          </Button>
        </div>
      </div>
    </>
  );
}
