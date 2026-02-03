/**
 * Per-Project Config File
 *
 * Manages `.creature/project.json` files stored inside each project folder.
 * This module handles reading/writing project settings to/from the project directory.
 */

import fs from "node:fs";
import path from "node:path";

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
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
}

/**
 * Project context stored in the config file.
 * Note: local_directory is NOT stored here since the folder path is implicit
 * from where the config file lives.
 */
export interface ProjectFileContext {
  custom_instructions?: string;
}

/**
 * Schema for `.creature/project.json` file.
 * Does not include `id` or `local_directory` - those are managed by the global index.
 */
export interface ProjectFileConfig {
  $version: number;
  name: string;
  profile: ProjectProfile;
  context: ProjectFileContext;
  mcps: ProjectMcpConfig[];
  created_at: string;
  updated_at: string;
}

const CONFIG_VERSION = 1;
const CONFIG_DIR = ".creature";
const CONFIG_FILENAME = "project.json";

/**
 * Get the path to the .creature directory for a project.
 */
export const getConfigDirPath = (projectRoot: string): string => {
  return path.join(projectRoot, CONFIG_DIR);
};

/**
 * Get the path to the project.json config file.
 */
export const getConfigFilePath = (projectRoot: string): string => {
  return path.join(projectRoot, CONFIG_DIR, CONFIG_FILENAME);
};

/**
 * Check if a project config file exists.
 */
export const configExists = (projectRoot: string): boolean => {
  return fs.existsSync(getConfigFilePath(projectRoot));
};

/**
 * Get current ISO timestamp.
 */
const now = (): string => {
  return new Date().toISOString();
};

/**
 * Read project config from `.creature/project.json`.
 * Returns null if the file doesn't exist or is invalid.
 */
export const readProjectConfig = (projectRoot: string): ProjectFileConfig | null => {
  try {
    const configPath = getConfigFilePath(projectRoot);

    if (!fs.existsSync(configPath)) {
      return null;
    }

    const data = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(data) as ProjectFileConfig;

    // Validate required fields
    if (!config.$version || !config.name || !config.profile) {
      console.error("[ProjectFile] Invalid config file: missing required fields");
      return null;
    }

    // Handle version migrations if needed in the future
    if (config.$version !== CONFIG_VERSION) {
      console.log("[ProjectFile] Config version mismatch, may need migration:", config.$version);
    }

    return config;
  } catch (error) {
    console.error("[ProjectFile] Failed to read config from", projectRoot, error);
    return null;
  }
};

/**
 * Write project config to `.creature/project.json`.
 * Creates the `.creature` directory if it doesn't exist.
 */
export const writeProjectConfig = (
  projectRoot: string,
  config: Omit<ProjectFileConfig, "$version" | "updated_at"> & { updated_at?: string }
): ProjectFileConfig => {
  try {
    const configDir = getConfigDirPath(projectRoot);
    const configPath = getConfigFilePath(projectRoot);

    // Ensure .creature directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const fullConfig: ProjectFileConfig = {
      $version: CONFIG_VERSION,
      name: config.name,
      profile: config.profile,
      context: config.context || {},
      mcps: config.mcps || [],
      created_at: config.created_at,
      updated_at: now(),
    };

    fs.writeFileSync(configPath, JSON.stringify(fullConfig, null, 2), "utf8");
    console.log("[ProjectFile] Wrote config to", configPath);

    return fullConfig;
  } catch (error) {
    console.error("[ProjectFile] Failed to write config to", projectRoot, error);
    throw new Error(`Failed to write project config: ${error}`);
  }
};

/**
 * Create a new project config file.
 */
export const createProjectConfig = (
  projectRoot: string,
  params: {
    name: string;
    profile: ProjectProfile;
    context?: ProjectFileContext;
    mcps?: ProjectMcpConfig[];
  }
): ProjectFileConfig => {
  const timestamp = now();

  return writeProjectConfig(projectRoot, {
    name: params.name,
    profile: params.profile,
    context: params.context || {},
    mcps: params.mcps || [],
    created_at: timestamp,
  });
};

/**
 * Update an existing project config file.
 * Only updates the fields that are provided.
 */
export const updateProjectConfig = (
  projectRoot: string,
  updates: {
    name?: string;
    profile?: ProjectProfile;
    context?: ProjectFileContext;
    mcps?: ProjectMcpConfig[];
  }
): ProjectFileConfig | null => {
  const existing = readProjectConfig(projectRoot);

  if (!existing) {
    console.error("[ProjectFile] Cannot update: config does not exist at", projectRoot);
    return null;
  }

  return writeProjectConfig(projectRoot, {
    name: updates.name ?? existing.name,
    profile: updates.profile ?? existing.profile,
    context: updates.context ?? existing.context,
    mcps: updates.mcps ?? existing.mcps,
    created_at: existing.created_at,
  });
};

/**
 * Delete the project config file and .creature directory (if empty).
 * Note: This is typically NOT called when "deleting" a project from the list,
 * since we only remove from the global index, not the user's files.
 */
export const deleteProjectConfig = (projectRoot: string): boolean => {
  try {
    const configPath = getConfigFilePath(projectRoot);
    const configDir = getConfigDirPath(projectRoot);

    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }

    // Only remove .creature dir if it's now empty
    if (fs.existsSync(configDir)) {
      const remaining = fs.readdirSync(configDir);
      if (remaining.length === 0) {
        fs.rmdirSync(configDir);
      }
    }

    return true;
  } catch (error) {
    console.error("[ProjectFile] Failed to delete config from", projectRoot, error);
    return false;
  }
};
