/**
 * GeneralProjectCreator Component
 *
 * Creator for "dev-general" profile projects.
 * Minimal project creation flow for general development.
 */

import { useState, useCallback } from "react";
import { X } from "@phosphor-icons/react";
import { Button } from "../Button";
import { Input } from "../Input";
import { Label } from "../Label";
import { Spinner } from "../Spinner";
import { cn } from "../../lib/utils";
import type { ProjectCreatorProps } from "./types";

type GeneralCreatorStatus = 
  | "idle"
  | "creating"
  | "error";

/**
 * GeneralProjectCreator Component
 *
 * Creates a general development project.
 * Folder selection is required for dev projects.
 */
export function GeneralProjectCreator({ onComplete, onCancel }: ProjectCreatorProps) {
  const [projectName, setProjectName] = useState("Untitled");
  const [selectedFolder, setSelectedFolder] = useState("");
  const [status, setStatus] = useState<GeneralCreatorStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Opens folder selection dialog.
   */
  const handleSelectFolder = useCallback(async () => {
    const folder = await window.electronAPI.selectFolder();
    if (folder) {
      setSelectedFolder(folder);
    }
  }, []);

  /**
   * Creates the project.
   * Folder is required for dev projects.
   */
  const handleCreate = useCallback(async () => {
    // Validate folder is selected
    if (!selectedFolder) {
      setError("Please select a folder");
      return;
    }

    setStatus("creating");
    setStatusMessage("Initializing...");
    setError(null);

    try {
      // Create project - folder is required
      // Include all built-in MCPs by default
      const createResult = await window.electronAPI.project.create({
        name: projectName.trim() || "Untitled",
        profile: "dev-general",
        context: { local_directory: { path: selectedFolder } },
        mcps: [
          { name: "browser", enabled: true },
          { name: "todos", enabled: true },
          { name: "notes", enabled: true },
          { name: "ide", enabled: true },
          { name: "terminal", enabled: true },
        ],
      });

      if (!createResult.success || !createResult.project) {
        throw new Error(createResult.error || "Failed to create project");
      }

      // Open project
      const openResult = await window.electronAPI.project.open({
        projectId: createResult.project.id,
      });

      if (!openResult.success || !openResult.project) {
        throw new Error(openResult.error || "Failed to open project");
      }

      // Complete
      onComplete({
        project: openResult.project,
        // No initial message for general projects
      });
    } catch (err) {
      console.error("[GeneralProjectCreator] Failed:", err);
      setError(err instanceof Error ? err.message : "Failed to create project");
      setStatus("error");
      setStatusMessage(null);
    }
  }, [projectName, selectedFolder, onComplete]);

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

  // Main form
  return (
    <>
      <div className="fixed inset-0 z-50 bg-background-primary/95 dialog-overlay" onClick={onCancel} data-state="open" />
      <form
        className="fixed z-50 grid w-full max-w-lg gap-4 border border-border-primary bg-background-primary p-12 shadow-lg rounded-lg dialog-content"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (projectName.trim() && selectedFolder) handleCreate(); }}
        data-state="open"
      >
        <div>
          {/* Header */}
          <div className="flex items-center justify-between pb-8">
            <h2 className="text-base font-medium text-text-primary">Import an existing codebase</h2>
            <button
              type="button"
              className="text-text-secondary hover:text-text-primary transition-colors cursor-pointer p-0 bg-transparent border-none"
              onClick={onCancel}
            >
              <X size={16} />
            </button>
          </div>

          {error && (
            <div className="border border-border-danger bg-background-danger/10 text-text-danger text-sm rounded-md p-3 mb-6">
              {error}
            </div>
          )}

          {/* Project Name field */}
          <div className="mb-4">
            <Label htmlFor="project-name">
              Project Name
            </Label>
            <Input
              id="project-name"
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Untitled"
            />
          </div>

          {/* Folder selection (required) */}
          <div className="mb-4">
            <Label>
              Folder
            </Label>
            <div className="flex gap-2">
              <Input
                type="text"
                value={selectedFolder}
                readOnly
                placeholder="Select a folder..."
                className="flex-1 bg-background-tertiary text-text-secondary cursor-default"
              />
              <Button type="button" variant="secondary" onClick={handleSelectFolder}>
                Browse
              </Button>
            </div>
            <p className="text-sm text-text-secondary mt-2">
              Select a local folder for this project
            </p>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 pt-6">
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!projectName.trim() || !selectedFolder}>
              Create
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
