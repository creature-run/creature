import { useState, useEffect, useCallback } from "react";
import { Lightning, FileCode, Warning, Clock, Trash, Cube } from "@phosphor-icons/react";
import { Spinner } from "./Spinner";
import { Button } from "./Button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./Card";
import { truncatePathLeft } from "../lib/utils";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "./AlertDialog";
import { PlaygroundProjectCreator, GeneralProjectCreator, McpAppCreator } from "./project-creators";
import type { ProjectCreatorResult } from "./project-creators";
import type { ProjectWithValidation } from "../electron/preload";

interface ProjectListProps {
  onProjectSelected: (project: ProjectWithValidation) => void;
}

/**
 * ProjectList Component
 *
 * Minimal project selection UI that displays in the main content area.
 * Shows a "New" link at the top, followed by a list of previous projects.
 * Designed to integrate seamlessly with the existing layout.
 */
export function ProjectList({
  onProjectSelected,
}: ProjectListProps) {
  const [projects, setProjects] = useState<ProjectWithValidation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [activeCreator, setActiveCreator] = useState<"playground" | "general" | "mcp" | null>(null);

  /**
   * Fetch projects from the API on mount.
   */
  useEffect(() => {
    const fetchProjects = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const result = await window.electronAPI.project.list();
        if (result.success && result.projects) {
          setProjects(result.projects);
        } else {
          setError(result.error || "Failed to load projects");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load projects");
      } finally {
        setIsLoading(false);
      }
    };

    fetchProjects();
  }, []);

  /**
   * Opens a project and notifies the parent.
   */
  const handleOpenProject = useCallback(
    async (project: ProjectWithValidation) => {
      setOpeningProjectId(project.id);
      setError(null);

      try {
        const result = await window.electronAPI.project.open({ projectId: project.id });
        if (result.success && result.project) {
          onProjectSelected(result.project);
        } else {
          setError(result.error || "Failed to open project");
          setOpeningProjectId(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to open project");
        setOpeningProjectId(null);
      }
    },
    [onProjectSelected]
  );

  /**
   * Handles completion of project creator.
   */
  const handleCreatorComplete = useCallback(
    (result: ProjectCreatorResult) => {
      setActiveCreator(null);
      onProjectSelected(result.project);
    },
    [onProjectSelected]
  );

  /**
   * Handles cancellation of project creator.
   */
  const handleCreatorCancel = useCallback(() => {
    setActiveCreator(null);
  }, []);

  /**
   * Deletes a project (soft delete) with optimistic update.
   * Removes the project from the list immediately for a snappy UX,
   * then restores it if the API call fails.
   */
  const handleDeleteProject = useCallback(async (projectId: string) => {
    setError(null);

    // Find the project to delete for potential rollback
    const projectToDelete = projects.find((p) => p.id === projectId);
    if (!projectToDelete) return;

    // Optimistic update: remove immediately
    setProjects((prev) => prev.filter((p) => p.id !== projectId));

    try {
      const result = await window.electronAPI.project.delete({ projectId });
      if (!result.success) {
        // Rollback: restore the project to the list
        setProjects((prev) => [...prev, projectToDelete]);
        setError(result.error || "Failed to delete project");
      }
    } catch (err) {
      // Rollback: restore the project to the list
      setProjects((prev) => [...prev, projectToDelete]);
      setError(err instanceof Error ? err.message : "Failed to delete project");
    }
  }, [projects]);

  /**
   * Formats a date as a relative time string.
   */
  const formatRelativeTime = (dateString: string): string => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  // Show full-view spinner when loading or opening a project
  if (isLoading || openingProjectId) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  }

  return (
    <div className="h-full flex justify-center px-6 pt-16 pb-8">
      <div className="w-full max-w-[600px] flex flex-col">
        {/* New Project Cards */}
        <div className="flex items-center mb-7">
          <div
            className="flex-1 border-t border-border-secondary origin-right"
            style={{ animation: "divider-grow-left 0.3s ease-out 0.11s backwards" }}
          />
          <span
            className="px-5 text-sm text-text-primary"
            style={{ animation: "fade-in 0.22s ease-out backwards" }}
          >
            What Are You Building?
          </span>
          <div
            className="flex-1 border-t border-border-secondary origin-left"
            style={{ animation: "divider-grow-right 0.3s ease-out 0.11s backwards" }}
          />
        </div>
        <div className="mb-8 grid grid-cols-3 gap-4">
          <Card
            className="cursor-pointer transition-all duration-200 bg-transparent border-border-secondary hover:bg-background-primary hover:border-background-inverse hover:shadow-[1px_1px_0_var(--color-background-inverse),2px_2px_0_var(--color-background-inverse),3px_3px_0_var(--color-background-inverse),4px_4px_0_var(--color-background-inverse),5px_5px_0_var(--color-background-inverse)] hover:-translate-x-[2px] hover:-translate-y-[2px] active:translate-x-0 active:translate-y-0 active:shadow-none select-none"
            style={{ animation: "gentle-rise 0.5s ease-out 0.25s backwards" }}
            onClick={() => setActiveCreator("mcp")}
          >
            <CardHeader className="flex flex-col items-start py-6">
              <Cube size={20} className="text-text-secondary mb-3" />
              <CardTitle className="mb-1 text-base">
                <span className="text-[13px]">New MCP App</span>
              </CardTitle>
              <CardDescription className="text-sm leading-relaxed">
                Build a visual AI tool from scratch.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card
            className="cursor-pointer transition-all duration-200 bg-transparent border-border-secondary hover:bg-background-primary hover:border-background-inverse hover:shadow-[1px_1px_0_var(--color-background-inverse),2px_2px_0_var(--color-background-inverse),3px_3px_0_var(--color-background-inverse),4px_4px_0_var(--color-background-inverse),5px_5px_0_var(--color-background-inverse)] hover:-translate-x-[2px] hover:-translate-y-[2px] active:translate-x-0 active:translate-y-0 active:shadow-none select-none"
            style={{ animation: "gentle-rise 0.5s ease-out 0.35s backwards" }}
            onClick={() => setActiveCreator("general")}
          >
            <CardHeader className="flex flex-col items-start py-6">
              <FileCode size={20} className="text-text-secondary mb-3" />
              <CardTitle className="mb-1 text-base">
                <span className="text-[13px]">Existing Codebase</span>
              </CardTitle>
              <CardDescription className="text-sm leading-relaxed">
                Code with help from MCP Apps.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card
            className="cursor-pointer transition-all duration-200 bg-transparent border-border-secondary hover:bg-background-primary hover:border-background-inverse hover:shadow-[1px_1px_0_var(--color-background-inverse),2px_2px_0_var(--color-background-inverse),3px_3px_0_var(--color-background-inverse),4px_4px_0_var(--color-background-inverse),5px_5px_0_var(--color-background-inverse)] hover:-translate-x-[2px] hover:-translate-y-[2px] active:translate-x-0 active:translate-y-0 active:shadow-none select-none"
            style={{ animation: "gentle-rise 0.5s ease-out 0.45s backwards" }}
            onClick={() => setActiveCreator("playground")}
          >
            <CardHeader className="flex flex-col items-start py-6">
              <Lightning size={20} className="text-text-secondary mb-3" />
              <CardTitle className="mb-1 text-base">
                <span className="text-[13px]">Playground</span>
              </CardTitle>
              <CardDescription className="text-sm leading-relaxed">
                Do anything with MCP Apps.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>

        {/* Divider with label */}
        <div className="flex items-center mb-8">
          <div
            className="flex-1 border-t border-border-secondary origin-right"
            style={{ animation: "divider-grow-left 0.3s ease-out 0.6s backwards" }}
          />
          <span
            className="px-5 text-sm text-text-primary"
            style={{ animation: "fade-in 0.22s ease-out 0.5s backwards" }}
          >
            Existing Projects
          </span>
          <div
            className="flex-1 border-t border-border-secondary origin-left"
            style={{ animation: "divider-grow-right 0.3s ease-out 0.6s backwards" }}
          />
        </div>

        {/* Error message */}
        {error && <div className="mb-4 text-text-danger text-sm">{error}</div>}

        {/* Projects list - scrollable */}
        {projects.length > 0 && (
          <div
            className="flex-1 overflow-y-auto -mx-2 space-y-1"
            style={{ animation: "fade-in 0.3s ease-out 0.75s backwards" }}
          >
            {projects.map((project) => {
              const hasFolder = !!project.context.local_directory?.path;
              const folderInvalid =
                hasFolder && project._localValidation?.valid === false;
              // Show folder path when local_directory is set
              const showFolderPath = hasFolder;

              return (
                <div
                  key={project.id}
                  className="flex items-center rounded hover:bg-background-tertiary/50 transition-colors group"
                >
                  <button
                    onClick={() => handleOpenProject(project)}
                    className="flex-1 text-left px-2 py-2 min-w-0"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-base text-text-primary truncate">
                        {project.name}
                      </span>
                    </div>
                    {showFolderPath && (
                      <div className="flex items-center gap-1 text-[10px] text-text-secondary mt-0.5">
                        <span className="truncate">
                          {truncatePathLeft(
                            project.context.local_directory?.path || "",
                            50
                          )}
                        </span>
                        {folderInvalid && (
                          <Warning
                            size={10}
                            className="text-warning shrink-0"
                            weight="fill"
                          />
                        )}
                      </div>
                    )}
                  </button>

                  {/* Time and delete button */}
                  <div className="flex items-center gap-1 mr-1 shrink-0">
                    <div className="flex items-center gap-1 text-[10px] text-text-secondary">
                      <Clock size={10} />
                      <span>
                        {formatRelativeTime(project.last_accessed_at)}
                      </span>
                    </div>

                    {/* Delete button with confirmation */}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          className="p-1.5 rounded opacity-0 group-hover:opacity-100 transition-opacity text-text-secondary hover:text-text-danger"
                          title="Delete project"
                        >
                          <Trash size={12} />
                        </button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="max-w-md">
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete Project</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to delete{" "}
                            <span className="font-medium text-text-primary">
                              "{project.name}"
                            </span>
                            ? This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDeleteProject(project.id)}
                            className="bg-solid-danger text-text-inverse hover:bg-solid-danger/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Empty state */}
        {projects.length === 0 && (
          <div
            className="text-base text-text-secondary pt-4 text-center"
            style={{ animation: "fade-in 0.3s ease-out 0.75s backwards" }}
          >
            No projects yet
          </div>
        )}
      </div>

      {/* Project Creator Modals */}
      {activeCreator === "playground" && (
        <PlaygroundProjectCreator
          onComplete={handleCreatorComplete}
          onCancel={handleCreatorCancel}
        />
      )}
      {activeCreator === "general" && (
        <GeneralProjectCreator
          onComplete={handleCreatorComplete}
          onCancel={handleCreatorCancel}
        />
      )}
      {activeCreator === "mcp" && (
        <McpAppCreator
          onComplete={handleCreatorComplete}
          onCancel={handleCreatorCancel}
        />
      )}
    </div>
  );
}

