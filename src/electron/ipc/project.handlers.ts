/**
 * Project IPC Handlers
 *
 * Handles project operations using local storage.
 * Local-first: Projects are stored locally, not on a cloud platform.
 */

import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { startChatServer } from "../server/chatServer";
import { getMcpStorageRoot } from "../storage/mcpStorageDir";
import * as telemetry from "../telemetry";
import {
  listProjects,
  getProject,
  getProjectEntry,
  createProject,
  updateProject,
  deleteProject,
  markProjectAccessed,
  addLocalValidation,
  validateLocalDirectory,
  findProjectByLocalDirectory,
  addExistingProject,
  type LocalProject,
  type ProjectProfile,
  type ProjectContext,
  type ProjectMcpConfig,
  type ProjectWithValidation,
} from "../storage/projectStore";
import type { SamplingSettings } from "../storage/projectSettings";

// Re-export types for use by other modules
export type { ProjectProfile, ProjectContext, ProjectMcpConfig, ProjectWithValidation };
export type { LocalProject as Project };

/**
 * Workspace root information for multi-root project support.
 */
export interface WorkspaceRoot {
  /** Unique identifier for this root (used in virtual paths) */
  id: string;
  /** Absolute path to the root directory */
  path: string;
  /** Human-readable label for display */
  label: string;
  /** Whether this root is an MCP app (has open-mcp-app dependency) */
  isMcpApp: boolean;
  /** Source of this root: workspace (main folder) or discovered (auto-found) */
  source: "workspace" | "discovered";
}

/**
 * Check if a directory is an MCP app by looking for open-mcp-app dependency.
 */
const isMcpAppDirectory = (dirPath: string): boolean => {
  try {
    const packageJsonPath = path.join(dirPath, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      return false;
    }
    const data = fs.readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(data) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // Check if open-mcp-app is in dependencies or devDependencies
    return !!(pkg.dependencies?.["open-mcp-app"] || pkg.devDependencies?.["open-mcp-app"]);
  } catch {
    return false;
  }
};

/**
 * Get package name from a directory's package.json.
 */
const getPackageName = (dirPath: string): string | null => {
  try {
    const packageJsonPath = path.join(dirPath, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }
    const data = fs.readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(data) as { name?: string };
    return pkg.name || null;
  } catch {
    return null;
  }
};

/**
 * Generate a short hash from a path for uniqueness.
 */
const shortHash = (str: string): string => {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 8);
};

/**
 * Discover MCP app projects under a directory (depth-limited scan).
 * Scans up to 2 levels deep to find directories with open-mcp-app dependency.
 */
const discoverMcpApps = (rootPath: string, maxDepth = 2): string[] => {
  const discovered: string[] = [];

  const scan = (dir: string, depth: number) => {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Skip hidden directories, node_modules, and common build directories
        if (entry.name.startsWith(".") || entry.name === "node_modules" || 
            entry.name === "dist" || entry.name === "build" || entry.name === "out") {
          continue;
        }

        const subPath = path.join(dir, entry.name);
        if (isMcpAppDirectory(subPath)) {
          discovered.push(subPath);
        } else {
          // Continue scanning subdirectories
          scan(subPath, depth + 1);
        }
      }
    } catch {
      // Ignore permission errors or other filesystem issues
    }
  };

  scan(rootPath, 0);
  return discovered;
};

/**
 * Compute effective workspace roots from project context.
 * Combines: workspace root + auto-discovered MCP apps.
 * Deduplicates by normalized absolute path.
 */
export const computeWorkspaceRoots = async (
  workspacePath: string | null
): Promise<WorkspaceRoot[]> => {
  const roots: WorkspaceRoot[] = [];
  const seenPaths = new Set<string>();

  // Helper to add a root with deduplication
  const addRoot = (
    rootPath: string,
    source: WorkspaceRoot["source"],
    labelOverride?: string
  ) => {
    const normalizedPath = path.resolve(rootPath);
    if (seenPaths.has(normalizedPath)) return;
    seenPaths.add(normalizedPath);

    const isMcpApp = isMcpAppDirectory(normalizedPath);
    const pkgName = getPackageName(normalizedPath);
    const label = labelOverride || pkgName || path.basename(normalizedPath);

    // Generate a unique ID from the path
    const id = shortHash(normalizedPath);

    roots.push({
      id,
      path: normalizedPath,
      label,
      isMcpApp,
      source,
    });
  };

  // 1. Add workspace root (main local_directory.path)
  if (workspacePath) {
    const validation = await validateLocalDirectory(workspacePath);
    if (validation.valid) {
      addRoot(workspacePath, "workspace");

      // 2. Auto-discover MCP apps under workspace (but not direct children)
      // Direct children are already accessible via the workspace root, so adding
      // them as separate roots would cause duplication in the IDE file tree.
      const normalizedWorkspace = path.resolve(workspacePath);
      const discovered = discoverMcpApps(workspacePath);
      for (const appPath of discovered) {
        const normalizedApp = path.resolve(appPath);
        const isDirectChild = path.dirname(normalizedApp) === normalizedWorkspace;
        const isSamePath = normalizedApp === normalizedWorkspace;
        
        if (!isDirectChild && !isSamePath) {
          addRoot(appPath, "discovered");
        }
      }
    }
  }

  return roots;
};

/**
 * Create project request body.
 */
interface CreateProjectRequest {
  name: string;
  profile: ProjectProfile;
  context?: ProjectContext;
  mcps?: ProjectMcpConfig[];
  sampling?: SamplingSettings;
}

/**
 * Update project request body.
 */
interface UpdateProjectRequest {
  name?: string;
  profile?: ProjectProfile;
  context?: ProjectContext;
  mcps?: ProjectMcpConfig[];
  sampling?: SamplingSettings;
}

/**
 * Register project-related IPC handlers.
 */
export const registerProjectHandlers = () => {
  /**
   * List all projects.
   * Validates local directory paths and adds validation status.
   */
  ipcMain.handle("project:list", async () => {
    try {
      const projects = await listProjects();

      // Validate local paths for each project
      const validatedProjects = await Promise.all(projects.map(addLocalValidation));

      return { success: true, projects: validatedProjects };
    } catch (error) {
      console.error("[Projects] Failed to list projects:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list projects",
      };
    }
  });

  /**
   * Get a single project by ID.
   */
  ipcMain.handle("project:get", async (_, { projectId }: { projectId: string }) => {
    try {
      const project = await getProject(projectId);

      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const validatedProject = await addLocalValidation(project);
      return { success: true, project: validatedProject };
    } catch (error) {
      console.error("[Projects] Failed to get project:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get project",
      };
    }
  });

  /**
   * Create a new project.
   * If no folder path is provided, an app-managed folder is created automatically.
   */
  ipcMain.handle("project:create", async (_, request: CreateProjectRequest) => {
    try {
      const project = await createProject({
        name: request.name,
        profile: request.profile,
        context: request.context,
        mcps: request.mcps,
      });

      // Track project creation (no paths)
      telemetry.track("project_create", {
        profile: request.profile,
      });

      return { success: true, project };
    } catch (error) {
      console.error("[Projects] Failed to create project:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create project",
      };
    }
  });

  /**
   * Update a project.
   */
  ipcMain.handle(
    "project:update",
    async (_, { projectId, ...updates }: { projectId: string } & UpdateProjectRequest) => {
      try {
        const project = await updateProject(projectId, updates);

        if (!project) {
          return { success: false, error: "Project not found" };
        }

        const validatedProject = await addLocalValidation(project);
        return { success: true, project: validatedProject };
      } catch (error) {
        console.error("[Projects] Failed to update project:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to update project",
        };
      }
    }
  );

  /**
   * Delete a project.
   * Deletes from index and userData settings. User's local directories are never deleted.
   */
  ipcMain.handle("project:delete", async (_, { projectId }: { projectId: string }) => {
    try {
      // Get the project entry
      const entry = getProjectEntry(projectId);
      if (!entry) {
        return { success: false, error: "Project not found" };
      }

      // Delete MCP storage data for this project
      const mcpStorageDir = path.join(getMcpStorageRoot(), projectId);
      if (fs.existsSync(mcpStorageDir)) {
        try {
          fs.rmSync(mcpStorageDir, { recursive: true, force: true });
          console.log("[Projects] Deleted MCP storage:", mcpStorageDir);
        } catch (fsError) {
          console.error("[Projects] Failed to delete MCP storage:", fsError);
          // Continue with index removal even if storage deletion fails
        }
      }

      // Remove from the index and delete userData settings
      const deleted = await deleteProject(projectId);

      if (!deleted) {
        return { success: false, error: "Failed to remove project from index" };
      }

      // Track project deletion
      telemetry.track("project_delete", {});

      return { success: true };
    } catch (error) {
      console.error("[Projects] Failed to delete project:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to delete project",
      };
    }
  });

  /**
   * Open a project.
   * Marks the project as accessed, starts the chat server, and initializes MCPs.
   */
  ipcMain.handle("project:open", async (_, { projectId }: { projectId: string }) => {
    try {
      // 1. Get the project
      const project = await getProject(projectId);

      if (!project) {
        return { success: false, error: "Project not found" };
      }

      // 2. Mark as accessed
      await markProjectAccessed(projectId);

      // 3. Validate local directory
      const validatedProject = await addLocalValidation(project);

      // 4. Start the chat server (idempotent)
      try {
        startChatServer();
      } catch (error) {
        console.error("[Projects] Failed to start chat server:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to start chat server",
        };
      }

      // 5. Compute workspace roots (auto-discover MCP apps)
      const workspacePath =
        validatedProject.context.local_directory?.path &&
        validatedProject._localValidation?.valid
          ? validatedProject.context.local_directory.path
          : null;
      
      const workspaceRoots = await computeWorkspaceRoots(workspacePath);

      // 6. Initialize MCPs for the project
      const { initMcpsForProject } = await import("../mcp/client");
      try {
        await initMcpsForProject({
          projectId,
          workspaceRoots,
          profile: validatedProject.profile,
          mcps: validatedProject.mcps,
        });
      } catch (error) {
        console.error("[Projects] Failed to initialize MCPs:", error);
        // Don't fail the open - chat should still work
      }

      // Track project open (no paths)
      telemetry.track("project_open", {
        profile: validatedProject.profile,
        workspace_roots_count: workspaceRoots.length,
        has_local_directory: !!validatedProject.context.local_directory,
      });

      return { success: true, project: validatedProject };
    } catch (error) {
      console.error("[Projects] Failed to open project:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to open project",
      };
    }
  });

  /**
   * Create MCP App project.
   * Supports both existing MCP folders and creating new ones from template.
   *
   * If the MCP app is created inside an existing project's local_directory,
   * it will be added to that project instead of creating a new separate project.
   */
  ipcMain.handle(
    "project:createMcpApp",
    async (
      _,
      {
        mcpFolderPath,
        targetPath,
        name,
        projectName,
        projectRootMode = "parent",
      }: {
        mcpFolderPath?: string; // Path to existing MCP folder
        targetPath?: string; // Parent path for new MCP
        name?: string; // Subfolder name for new MCP
        projectName: string;
        projectRootMode?: "parent" | "app"; // Where to set local_directory (default: "parent")
      }
    ) => {
      const pathModule = await import("path");
      let finalMcpPath: string;

      // Determine if we're using an existing MCP or creating a new one
      if (mcpFolderPath) {
        // Using existing folder - accept any folder without validation
        finalMcpPath = mcpFolderPath;
      } else if (targetPath && name) {
        // Creating new MCP from example template
        finalMcpPath = pathModule.join(targetPath, name);

        const { createFromTemplate } = await import("./mcp.handlers");
        const templateResult = await createFromTemplate({
          targetPath,
          name,
        });

        if (!templateResult.success) {
          return { success: false, error: templateResult.error };
        }
      } else {
        return {
          success: false,
          error: "Must provide either mcpFolderPath or both targetPath and name",
        };
      }

      // Check if we're inside an existing project's local_directory
      const findExistingProjectContaining = async (targetPath: string): Promise<{ id: string; project: LocalProject } | null> => {
        const normalizedTarget = pathModule.resolve(targetPath);
        const projects = await listProjects();

        for (const project of projects) {
          const localDir = project.context.local_directory?.path;
          if (!localDir) continue;

          const normalizedLocalDir = pathModule.resolve(localDir);
          // Check if targetPath is inside or equal to the project's local_directory
          if (normalizedTarget.startsWith(normalizedLocalDir + pathModule.sep) ||
              normalizedTarget === normalizedLocalDir) {
            return { id: project.id, project };
          }
        }
        return null;
      };

      // Check if the MCP app's parent directory (not the MCP app itself) is inside an existing project.
      // Only do this when projectRootMode === "parent". When the user explicitly chooses "app" mode,
      // they want the new MCP app folder to be its own standalone project root.
      const mcpParentDir = pathModule.dirname(finalMcpPath);
      const existingProjectInfo = projectRootMode === "parent"
        ? await findExistingProjectContaining(mcpParentDir)
        : null;

      try {
        let validatedProject;

        if (existingProjectInfo) {
          // MCP app is inside an existing project's local_directory - use that project
          console.log("[Projects] MCP app is inside existing project:", existingProjectInfo.project.name);
          validatedProject = await addLocalValidation(existingProjectInfo.project);
        } else {
          // Standalone MCP app project - create new project
          // projectRootMode determines the local_directory:
          // - "parent": targetPath (parent folder), with MCP app as workspace root
          // - "app": finalMcpPath (the MCP app folder itself)
          const useParentAsRoot = projectRootMode === "parent" && targetPath;
          const projectRoot = useParentAsRoot ? targetPath : finalMcpPath;

          const project = await createProject({
            name: projectName,
            profile: "dev-mcp",
            context: {
              local_directory: { path: projectRoot },
            },
            mcps: [
              { name: "browser", enabled: true },
              { name: "todos", enabled: true },
              { name: "notes", enabled: true },
              { name: "ide", enabled: true },
              { name: "terminal", enabled: true },
            ],
          });
          validatedProject = await addLocalValidation(project);
        }

        // Start chat server
        try {
          startChatServer();
        } catch (error) {
          console.error("[Projects] Failed to start chat server:", error);
          return {
            success: false,
            error: error instanceof Error ? error.message : "Failed to start chat server",
          };
        }

        // Initialize MCPs with workspace roots
        const workspacePath =
          validatedProject.context.local_directory?.path &&
          validatedProject._localValidation?.valid
            ? validatedProject.context.local_directory.path
            : null;

        const workspaceRoots = await computeWorkspaceRoots(workspacePath);

        const { initMcpsForProject } = await import("../mcp/client");
        try {
          await initMcpsForProject({
            projectId: validatedProject.id,
            workspaceRoots,
            profile: validatedProject.profile,
            mcps: validatedProject.mcps,
          });
        } catch (error) {
          console.error("[Projects] Failed to initialize MCPs:", error);
          // Don't fail - chat should still work
        }

        return { success: true, project: validatedProject };
      } catch (error) {
        console.error("[Projects] Failed to create MCP App project:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to create project",
        };
      }
    }
  );
};
