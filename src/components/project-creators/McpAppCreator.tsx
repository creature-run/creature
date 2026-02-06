/**
 * McpAppCreator Component
 *
 * Creator for "dev-mcp" profile projects.
 * Supports both creating new MCPs from template and using existing MCP folders.
 */

import { useState, useCallback } from "react";
import { X } from "@phosphor-icons/react";
import { Button } from "../Button";
import { Input } from "../Input";
import { Label } from "../Label";
import { Spinner } from "../Spinner";
import { cn } from "../../lib/utils";
import type { ProjectCreatorProps } from "./types";

type McpCreatorStatus = 
  | "idle"
  | "creating"
  | "error";

type McpCreatorMode = "create" | "existing";

/**
 * McpAppCreator Component
 *
 * Creates an MCP development project.
 * - Create mode: create MCP from template in a new folder
 * - Existing mode: add an existing MCP folder as a project
 */
export function McpAppCreator({ onComplete, onCancel }: ProjectCreatorProps) {
  const [projectName, setProjectName] = useState("New MCP App");
  const [appName, setAppName] = useState("new-mcp-app");
  const [folderName, setFolderName] = useState("new-mcp-app");
  const [mode, setMode] = useState<McpCreatorMode>("create");
  
  // Create mode state
  const [createFolderLocation, setCreateFolderLocation] = useState("");
  
  // Existing mode state
  const [existingFolderPath, setExistingFolderPath] = useState("");
  
  const [status, setStatus] = useState<McpCreatorStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Opens folder selection dialog for "existing" mode.
   * Accepts any folder without validation.
   */
  const handleSelectExistingFolder = useCallback(async () => {
    const folder = await window.electronAPI.selectFolder();
    if (folder) {
      setExistingFolderPath(folder);
      setError(null);
    }
  }, []);

  /**
   * Opens folder selection dialog for "create" mode (parent location).
   */
  const handleSelectCreateLocation = useCallback(async () => {
    const folder = await window.electronAPI.selectFolder();
    if (folder) {
      setCreateFolderLocation(folder);
    }
  }, []);

  /**
   * Validates the folder name for new MCPs.
   */
  const validateFolderName = (value: string): string | null => {
    if (!value.trim()) {
      return "Folder name is required";
    }
    if (!/^[a-z0-9-]+$/.test(value)) {
      return "Folder name must be lowercase letters, numbers, and hyphens only";
    }
    if (value.length < 3) {
      return "Folder name must be at least 3 characters";
    }
    if (value.length > 50) {
      return "Folder name must be 50 characters or less";
    }
    return null;
  };

  /**
   * Derives a human-readable project name from a hyphenated app name.
   * Replaces hyphens with spaces and capitalizes each word.
   * e.g., "my-cool-app" → "My Cool App"
   */
  const deriveProjectName = useCallback((name: string): string => {
    if (!name) return "New MCP App";
    return name
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }, []);

  /**
   * Creates or adds the MCP app project.
   */
  const handleCreate = useCallback(async () => {
    setError(null);

    if (mode === "existing") {
      // Existing mode - need folder selection
      if (!existingFolderPath) {
        setError("Please select a folder");
        return;
      }
    } else {
      // Create mode - need app name, folder name, and parent location
      const appNameError = validateFolderName(appName);
      if (appNameError) {
        setError(appNameError.replace("Folder name", "MCP App name"));
        return;
      }

      const folderError = validateFolderName(folderName);
      if (folderError) {
        setError(folderError);
        return;
      }
      
      if (!createFolderLocation) {
        setError("Please select a folder location");
        return;
      }
    }

    setStatus("creating");
    setStatusMessage("Initializing...");

    try {
      // Call with different params based on mode
      const result = mode === "existing"
        ? await window.electronAPI.project.createMcpApp({
            mcpFolderPath: existingFolderPath,
            projectName: projectName.trim() || "New MCP App",
          })
        : await window.electronAPI.project.createMcpApp({
            targetPath: createFolderLocation,
            name: folderName.trim(),
            appName: appName.trim(),
            projectName: deriveProjectName(appName.trim()),
            projectRootMode: "app",
          });

      if (!result.success || !result.project) {
        throw new Error(result.error || "Failed to create MCP app");
      }

      // Complete
      onComplete({
        project: result.project,
      });
    } catch (err) {
      console.error("[McpAppCreator] Failed:", err);
      setError(err instanceof Error ? err.message : "Failed to create MCP app");
      setStatus("error");
      setStatusMessage(null);
    }
  }, [mode, projectName, appName, folderName, createFolderLocation, existingFolderPath, deriveProjectName, onComplete]);

  /**
   * Handle mode tab change and reset relevant state.
   */
  const handleModeChange = useCallback((newMode: McpCreatorMode) => {
    setMode(newMode);
    setError(null);
    // Reset state when switching modes
    if (newMode === "create") {
      setExistingFolderPath("");
    }
  }, []);

  /**
   * Handle MCP App name change.
   * Auto-formats to lowercase with hyphens. Derives project name and
   * folder name automatically so the user only fills in one field.
   */
  const handleAppNameChange = useCallback((value: string) => {
    const formatted = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    setAppName(formatted);
    setFolderName(formatted);
    setProjectName(deriveProjectName(formatted));
  }, [deriveProjectName]);

  /**
   * Handle folder name change with validation.
   * Folder name can be edited independently from app name.
   */
  const handleFolderNameChange = useCallback((value: string) => {
    const formatted = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    setFolderName(formatted);
  }, []);

  // Creating state - show status message
  if (status === "creating") {
    return (
      <>
        <div className="fixed inset-0 z-50 bg-background-primary/95 dialog-overlay" data-state="open" />
        <div className="fixed z-50 flex items-center justify-center w-full max-w-lg border border-border-primary bg-background-primary p-12 shadow-lg rounded-lg dialog-content" data-state="open">
          <div className="flex items-center gap-3">
            <Spinner size={16} />
            <span className="text-base text-text-primary">{statusMessage}</span>
          </div>
        </div>
      </>
    );
  }

  const isCreateDisabled = mode === "create"
    ? !createFolderLocation || !folderName || !appName
    : !existingFolderPath;

  // Main form
  return (
    <>
      <div className="fixed inset-0 z-50 bg-background-primary/95 dialog-overlay" onClick={onCancel} data-state="open" />
      <form
        className="fixed z-50 grid w-full max-w-lg gap-4 border border-border-primary bg-background-primary p-12 shadow-lg rounded-lg dialog-content"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (!isCreateDisabled) handleCreate(); }}
        data-state="open"
      >
        <div>
          {/* Header */}
          <div className="flex items-center justify-between pb-8">
            <h2 className="text-base font-medium text-text-primary">
              Create a new MCP App
            </h2>
            <button
              type="button"
              className="text-text-secondary hover:text-text-primary transition-colors cursor-pointer p-0 bg-transparent border-none"
              onClick={onCancel}
            >
              <X size={16} />
            </button>
          </div>

          {/* Mode Tabs */}
          <div className="mb-4">
            <div className="flex border-b border-border-primary">
              <button
                type="button"
                onClick={() => handleModeChange("create")}
                className={cn(
                  "px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px",
                  mode === "create"
                    ? "text-text-primary border-text-primary"
                    : "text-text-secondary border-transparent hover:text-text-primary"
                )}
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => handleModeChange("existing")}
                className={cn(
                  "px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px",
                  mode === "existing"
                    ? "text-text-primary border-text-primary"
                    : "text-text-secondary border-transparent hover:text-text-primary"
                )}
              >
                Existing
              </button>
            </div>
          </div>

          {error && (
            <div className="border border-border-danger bg-background-danger/10 text-text-danger text-sm rounded-md p-3 mb-6">
              {error}
            </div>
          )}

          {/* Create Mode Content */}
          {mode === "create" && (
            <>
              {/* MCP App Name */}
              <div className="mb-4">
                <Label htmlFor="app-name">
                  MCP App Name
                </Label>
                <Input
                  id="app-name"
                  type="text"
                  value={appName}
                  onChange={(e) => handleAppNameChange(e.target.value)}
                  placeholder="my-mcp-app"
                />
                <p className="text-sm text-text-secondary mt-2">
                  Lowercase letters, numbers, and hyphens only
                </p>
              </div>

              {/* Folder Location */}
              <div className="mb-4">
                <Label>Folder Location</Label>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={createFolderLocation}
                    readOnly
                    placeholder="Select parent folder..."
                    className="flex-1 bg-background-tertiary text-text-secondary cursor-default"
                  />
                  <Button type="button" variant="secondary" onClick={handleSelectCreateLocation}>
                    Browse
                  </Button>
                </div>
                {createFolderLocation && (
                  <p className="text-sm text-text-secondary mt-2">
                    Will create new MCP in subfolder "{folderName}"
                  </p>
                )}
              </div>

              {/* Folder Name */}
              <div className="mb-8">
                <Label htmlFor="folder-name">
                  Folder Name
                </Label>
                <Input
                  id="folder-name"
                  type="text"
                  value={folderName}
                  onChange={(e) => handleFolderNameChange(e.target.value)}
                  placeholder="new-mcp-app"
                />
                <p className="text-sm text-text-secondary mt-2">
                  Lowercase letters, numbers, and hyphens only
                </p>
              </div>
            </>
          )}

          {/* Existing Mode Content */}
          {mode === "existing" && (
            <>
              {/* Project Name */}
              <div className="mb-4">
                <Label htmlFor="project-name">
                  Project Name
                </Label>
                <Input
                  id="project-name"
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="New MCP App"
                />
              </div>

              {/* Folder Selection */}
              <div className="mb-8">
                <Label>Location of Existing App</Label>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={existingFolderPath}
                    readOnly
                    placeholder="Select folder..."
                    className="flex-1 bg-background-tertiary text-text-secondary cursor-default"
                  />
                  <Button type="button" variant="secondary" onClick={handleSelectExistingFolder}>
                    Browse
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* Footer */}
          <div className="flex justify-end gap-2 pt-6">
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isCreateDisabled}
            >
              {mode === "create" ? "Create" : "Add"}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
