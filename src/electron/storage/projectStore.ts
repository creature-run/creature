/**
 * Project Index Storage
 *
 * Stores an index of project IDs in a global JSON file.
 * Actual project settings are stored in userData/projects/<projectId>/project.json.
 *
 * Local overrides from .creature/project.json in user-selected directories
 * take precedence when present.
 */

import { app } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  readUserDataProjectConfig,
  writeUserDataProjectConfig,
  writeProjectSettings,
  deleteUserDataProjectConfig,
  resolveEffectiveProjectConfig,
  localOverrideExists,
  readLocalOverrideConfig,
  getProjectsSettingsRoot,
  DEFAULT_SAMPLING_SETTINGS,
  type ProjectProfile,
  type ProjectMcpConfig,
  type ProjectSettingsConfig,
  type SamplingSettings,
} from "./projectSettings";

// Re-export types for convenience
export type { ProjectProfile, ProjectMcpConfig };

/**
 * Local directory context (used in the composed LocalProject type).
 */
interface LocalDirectoryContext {
  path: string;
}

/**
 * Project context (composed from settings).
 */
export interface ProjectContext {
  local_directory?: LocalDirectoryContext;
  custom_instructions?: string;
}

/**
 * Composed project structure returned by the API.
 */
export interface LocalProject {
  id: string;
  name: string;
  profile: ProjectProfile;
  context: ProjectContext;
  mcps: ProjectMcpConfig[];
  sampling: SamplingSettings;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
}

/**
 * Project with local validation status.
 */
export interface ProjectWithValidation extends LocalProject {
  _localValidation?: {
    valid: boolean;
    error?: string;
  };
  /** Where the effective settings came from */
  _settingsSource?: "userData" | "local";
}

/**
 * Entry in the global project index.
 * Only stores ID and timestamps - settings are in userData.
 */
export interface ProjectIndexEntry {
  id: string;
  created_at: string;
  last_accessed_at: string;
}

/**
 * Storage format for the global index file.
 */
interface ProjectIndexStorage {
  version: number;
  projects: ProjectIndexEntry[];
}

const INDEX_VERSION = 1;

/**
 * Get the path to the project index file.
 */
const getIndexPath = (): string => {
  return path.join(app.getPath("userData"), "projects.json");
};

/**
 * Generate a unique project ID.
 */
const generateId = (): string => {
  return crypto.randomUUID();
};

/**
 * Get current ISO timestamp.
 */
const now = (): string => {
  return new Date().toISOString();
};

/**
 * Load the project index from storage.
 */
const loadIndex = (): ProjectIndexStorage => {
  try {
    const indexPath = getIndexPath();

    if (!fs.existsSync(indexPath)) {
      return { version: INDEX_VERSION, projects: [] };
    }

    const data = fs.readFileSync(indexPath, "utf8");
    const storage = JSON.parse(data) as ProjectIndexStorage;

    return storage;
  } catch (error) {
    console.error("[ProjectStore] Failed to load index:", error);
    return { version: INDEX_VERSION, projects: [] };
  }
};

/**
 * Save the project index to storage.
 */
const saveIndex = (storage: ProjectIndexStorage): void => {
  try {
    const indexPath = getIndexPath();
    fs.writeFileSync(indexPath, JSON.stringify(storage, null, 2), "utf8");
  } catch (error) {
    console.error("[ProjectStore] Failed to save index:", error);
    throw new Error("Failed to save project index");
  }
};

/**
 * Compose a LocalProject from index entry + userData settings + optional local override.
 * Returns null if settings can't be read.
 */
const composeProject = (entry: ProjectIndexEntry): { project: LocalProject; source: "userData" | "local" } | null => {
  // Read userData settings
  const userDataConfig = readUserDataProjectConfig(entry.id);
  if (!userDataConfig) {
    return null;
  }

  // Resolve effective settings (may use local override)
  const resolved = resolveEffectiveProjectConfig(entry.id, userDataConfig);

  return {
    project: {
      id: entry.id,
      name: resolved.config.name,
      profile: resolved.config.profile,
      context: {
        local_directory: resolved.config.context.local_directory,
        custom_instructions: resolved.config.context.custom_instructions,
      },
      mcps: resolved.config.mcps,
      sampling: resolved.config.sampling ?? DEFAULT_SAMPLING_SETTINGS,
      created_at: resolved.config.created_at,
      updated_at: resolved.config.updated_at,
      last_accessed_at: entry.last_accessed_at,
    },
    source: resolved.source,
  };
};

// =============================================================================
// Public API
// =============================================================================

/**
 * List all projects (composed from index + userData settings + local overrides).
 */
export const listProjects = async (): Promise<LocalProject[]> => {
  const index = loadIndex();
  const projects: LocalProject[] = [];

  for (const entry of index.projects) {
    const result = composeProject(entry);
    if (result) {
      projects.push(result.project);
    }
  }

  // Sort by last_accessed_at descending (most recent first)
  return projects.sort(
    (a, b) => new Date(b.last_accessed_at).getTime() - new Date(a.last_accessed_at).getTime()
  );
};

/**
 * Get a project by ID (composed from index + userData settings + local override).
 */
export const getProject = async (projectId: string): Promise<LocalProject | null> => {
  const index = loadIndex();
  const entry = index.projects.find((p) => p.id === projectId);

  if (!entry) {
    return null;
  }

  const result = composeProject(entry);
  return result?.project || null;
};

/**
 * Get a project index entry by ID.
 */
export const getProjectEntry = (projectId: string): ProjectIndexEntry | null => {
  const index = loadIndex();
  return index.projects.find((p) => p.id === projectId) || null;
};

/**
 * Find a project by its local directory path.
 * Searches through all projects' context.local_directory settings.
 */
export const findProjectByLocalDirectory = (localDir: string): { id: string; project: LocalProject } | null => {
  const index = loadIndex();
  const normalizedPath = path.resolve(localDir);

  for (const entry of index.projects) {
    const result = composeProject(entry);
    if (!result) continue;

    const projectLocalDir = result.project.context.local_directory?.path;
    if (projectLocalDir && path.resolve(projectLocalDir) === normalizedPath) {
      return { id: entry.id, project: result.project };
    }
  }

  return null;
};

/**
 * Create a new project.
 * Writes settings to userData only - NEVER creates .creature in local directories.
 *
 * @param params.name - Project name
 * @param params.profile - Project profile type
 * @param params.context - Project context (local_directory is optional)
 * @param params.mcps - MCP configurations
 */
export const createProject = async (params: {
  name: string;
  profile: ProjectProfile;
  context?: ProjectContext;
  mcps?: ProjectMcpConfig[];
  sampling?: SamplingSettings;
}): Promise<LocalProject> => {
  const timestamp = now();
  const id = generateId();

  // Check for duplicate local_directory if provided
  const localDir = params.context?.local_directory?.path;
  if (localDir) {
    const existing = findProjectByLocalDirectory(localDir);
    if (existing) {
      throw new Error("A project already exists for this folder");
    }
  }

  // Write settings to userData only (NEVER create .creature in user directories)
  const config = writeUserDataProjectConfig(id, {
    name: params.name,
    profile: params.profile,
    context: {
      local_directory: localDir ? { path: localDir } : undefined,
      custom_instructions: params.context?.custom_instructions,
    },
    mcps: params.mcps || [],
    sampling: params.sampling ?? DEFAULT_SAMPLING_SETTINGS,
    created_at: timestamp,
  });

  // Add entry to the global index
  const index = loadIndex();
  const entry: ProjectIndexEntry = {
    id,
    created_at: timestamp,
    last_accessed_at: timestamp,
  };
  index.projects.push(entry);
  saveIndex(index);

  // Return the composed project
  return {
    id,
    name: config.name,
    profile: config.profile,
    context: {
      local_directory: config.context.local_directory,
      custom_instructions: config.context.custom_instructions,
    },
    mcps: config.mcps,
    sampling: config.sampling ?? DEFAULT_SAMPLING_SETTINGS,
    created_at: config.created_at,
    updated_at: config.updated_at,
    last_accessed_at: timestamp,
  };
};

/**
 * Update a project.
 * Always writes to userData. If local_directory has .creature, also writes there.
 */
export const updateProject = async (
  projectId: string,
  updates: {
    name?: string;
    profile?: ProjectProfile;
    context?: ProjectContext;
    mcps?: ProjectMcpConfig[];
    sampling?: SamplingSettings;
  }
): Promise<LocalProject | null> => {
  const index = loadIndex();
  const entry = index.projects.find((p) => p.id === projectId);

  if (!entry) {
    return null;
  }

  // Read existing userData settings
  const existing = readUserDataProjectConfig(projectId);
  if (!existing) {
    return null;
  }

  // Check for duplicate if local_directory is being changed
  const newLocalDir = updates.context?.local_directory?.path;
  const oldLocalDir = existing.context.local_directory?.path;
  if (newLocalDir && newLocalDir !== oldLocalDir) {
    const existingProject = findProjectByLocalDirectory(newLocalDir);
    if (existingProject && existingProject.id !== projectId) {
      throw new Error("A project already exists for this folder");
    }
  }

  // Build updated settings
  const updatedSettings: Omit<ProjectSettingsConfig, "$version" | "updated_at"> = {
    name: updates.name ?? existing.name,
    profile: updates.profile ?? existing.profile,
    context: {
      // Allow changing local_directory
      local_directory: updates.context?.local_directory !== undefined
        ? updates.context.local_directory
        : existing.context.local_directory,
      custom_instructions: updates.context?.custom_instructions !== undefined
        ? updates.context.custom_instructions
        : existing.context.custom_instructions,
    },
    mcps: updates.mcps ?? existing.mcps,
    sampling: updates.sampling ?? existing.sampling ?? DEFAULT_SAMPLING_SETTINGS,
    created_at: existing.created_at,
  };

  // Write settings (to userData, and to local .creature if it exists)
  const config = writeProjectSettings(projectId, updatedSettings);

  // Return the composed project
  return {
    id: projectId,
    name: config.name,
    profile: config.profile,
    context: {
      local_directory: config.context.local_directory,
      custom_instructions: config.context.custom_instructions,
    },
    mcps: config.mcps,
    sampling: config.sampling ?? DEFAULT_SAMPLING_SETTINGS,
    created_at: config.created_at,
    updated_at: config.updated_at,
    last_accessed_at: entry.last_accessed_at,
  };
};

/**
 * Delete a project from the index and userData.
 * Does NOT delete local .creature/project.json or user directories.
 */
export const deleteProject = async (projectId: string): Promise<boolean> => {
  const index = loadIndex();
  const entryIndex = index.projects.findIndex((p) => p.id === projectId);

  if (entryIndex === -1) {
    return false;
  }

  // Remove from index
  index.projects.splice(entryIndex, 1);
  saveIndex(index);

  // Delete userData settings
  deleteUserDataProjectConfig(projectId);

  return true;
};

/**
 * Mark a project as accessed (updates last_accessed_at in index).
 */
export const markProjectAccessed = async (projectId: string): Promise<void> => {
  const index = loadIndex();
  const entry = index.projects.find((p) => p.id === projectId);

  if (entry) {
    entry.last_accessed_at = now();
    saveIndex(index);
  }
};

/**
 * Validates that a local directory path exists.
 */
export const validateLocalDirectory = async (
  dirPath: string
): Promise<{ valid: boolean; error?: string }> => {
  try {
    const fsPromises = await import("node:fs/promises");
    const stats = await fsPromises.stat(dirPath);
    if (!stats.isDirectory()) {
      return { valid: false, error: "Path is not a directory" };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Directory not found" };
  }
};

/**
 * Adds local validation and settings source to a project.
 */
export const addLocalValidation = async (
  project: LocalProject
): Promise<ProjectWithValidation> => {
  // Get settings source
  const userDataConfig = readUserDataProjectConfig(project.id);
  let settingsSource: "userData" | "local" = "userData";

  if (userDataConfig) {
    const resolved = resolveEffectiveProjectConfig(project.id, userDataConfig);
    settingsSource = resolved.source;
  }

  if (!project.context.local_directory?.path) {
    return {
      ...project,
      _settingsSource: settingsSource,
    };
  }

  const projectPath = project.context.local_directory.path;
  const validation = await validateLocalDirectory(projectPath);

  return {
    ...project,
    _localValidation: validation,
    _settingsSource: settingsSource,
  };
};

/**
 * Add an existing project folder to the index.
 * Reads initial settings from `.creature/project.json` if it exists.
 * Does NOT create .creature directory.
 */
export const addExistingProject = async (
  rootPath: string,
  defaults?: {
    name?: string;
    profile?: ProjectProfile;
  }
): Promise<LocalProject> => {
  // Check if already in index
  const existing = findProjectByLocalDirectory(rootPath);
  if (existing) {
    return existing.project;
  }

  const timestamp = now();
  const id = generateId();

  // Check if local .creature/project.json exists and read it
  let initialSettings: Omit<ProjectSettingsConfig, "$version" | "updated_at">;

  if (localOverrideExists(rootPath)) {
    const localConfig = readLocalOverrideConfig(rootPath);
    if (localConfig) {
      initialSettings = {
        name: localConfig.name,
        profile: localConfig.profile as ProjectProfile,
        context: {
          local_directory: { path: rootPath },
          custom_instructions: localConfig.context.custom_instructions,
        },
        mcps: localConfig.mcps,
        created_at: localConfig.created_at,
      };
    } else {
      // Local config exists but is invalid - use defaults
      const folderName = path.basename(rootPath);
      initialSettings = {
        name: defaults?.name || folderName,
        profile: defaults?.profile || "dev-general",
        context: {
          local_directory: { path: rootPath },
        },
        mcps: [],
        created_at: timestamp,
      };
    }
  } else {
    // No local config - use defaults
    const folderName = path.basename(rootPath);
    initialSettings = {
      name: defaults?.name || folderName,
      profile: defaults?.profile || "dev-general",
      context: {
        local_directory: { path: rootPath },
      },
      mcps: [],
      created_at: timestamp,
    };
  }

  // Write to userData only (do NOT create .creature)
  const config = writeUserDataProjectConfig(id, initialSettings);

  // Add to index
  const index = loadIndex();
  const entry: ProjectIndexEntry = {
    id,
    created_at: timestamp,
    last_accessed_at: timestamp,
  };
  index.projects.push(entry);
  saveIndex(index);

  // Return composed project
  return {
    id,
    name: config.name,
    profile: config.profile,
    context: {
      local_directory: config.context.local_directory,
      custom_instructions: config.context.custom_instructions,
    },
    mcps: config.mcps,
    created_at: config.created_at,
    updated_at: config.updated_at,
    last_accessed_at: timestamp,
  };
};
