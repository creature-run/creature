/**
 * PlaygroundProjectCreator Component
 *
 * Creator for "playground" profile projects.
 * Simple project creation with no local directory - uses app-managed folder.
 * MCPs: browser, todos, notes
 */

import { useState, useCallback } from "react";
import { X } from "@phosphor-icons/react";
import { Button } from "../Button";
import { Input } from "../Input";
import { Label } from "../Label";
import { Spinner } from "../Spinner";
import type { ProjectCreatorProps } from "./types";

type WorkCreatorStatus =
  | "idle"
  | "creating"
  | "error";

/**
 * PlaygroundProjectCreator Component
 *
 * Creates a playground project with no local directory.
 * Uses app-managed folder for project storage.
 */
export function PlaygroundProjectCreator({ onComplete, onCancel }: ProjectCreatorProps) {
  const [projectName, setProjectName] = useState("MCP Apps Playground");
  const [status, setStatus] = useState<WorkCreatorStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Creates the project.
   * No folder selection - uses app-managed folder.
   */
  const handleCreate = useCallback(async () => {
    setStatus("creating");
    setStatusMessage("Initializing...");
    setError(null);

    try {
      // Create project without local_directory - will use app-managed folder
      // Include default MCPs for playground projects
      const createResult = await window.electronAPI.project.create({
        name: projectName.trim() || "MCP Apps Playground",
        profile: "playground",
        mcps: [
          { name: "browser", enabled: true },
          { name: "todos", enabled: true },
          { name: "notes", enabled: true },
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
      });
    } catch (err) {
      console.error("[WorkProjectCreator] Failed:", err);
      setError(err instanceof Error ? err.message : "Failed to create project");
      setStatus("error");
      setStatusMessage(null);
    }
  }, [projectName, onComplete]);

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
        onSubmit={(e) => { e.preventDefault(); if (projectName.trim()) handleCreate(); }}
        data-state="open"
      >
        <div>
          {/* Header */}
          <div className="flex items-center justify-between pb-8">
            <h2 className="text-lg font-medium text-text-primary">Create a general playground</h2>
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
          <div className="mb-8">
            <Label htmlFor="project-name">
              Project Name
            </Label>
            <Input
              id="project-name"
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="MCP Apps Playground"
            />
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 pt-6">
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!projectName.trim()}>
              Create
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
