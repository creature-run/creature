/**
 * Per-Project Settings Storage
 *
 * Manages project settings stored in Electron's userData directory.
 * Settings are stored at: userData/projects/<projectId>/project.json
 *
 * Also handles resolution of effective settings when a local `.creature/project.json`
 * override exists in the user's selected local directory.
 */

import { app } from "electron";
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
export interface LocalDirectoryContext {
  path: string;
}

/**
 * Project context stored in the settings file.
 * Now includes local_directory since it's a user selection, not implicit.
 */
export interface ProjectSettingsContext {
  local_directory?: LocalDirectoryContext;
  custom_instructions?: string;
}

/**
 * Schema for project settings stored in userData.
 * Contains all project configuration including the selected local directory.
 */
export interface ProjectSettingsConfig {
  $version: number;
  name: string;
  profile: ProjectProfile;
  context: ProjectSettingsContext;
  mcps: ProjectMcpConfig[];
  created_at: string;
  updated_at: string;
}

/**
 * Schema for local override config (`.creature/project.json`).
 * Similar to ProjectSettingsConfig but without local_directory (it's implicit).
 */
export interface LocalOverrideConfig {
  $version: number;
  name: string;
  profile: ProjectProfile;
  context: {
    custom_instructions?: string;
  };
  mcps: ProjectMcpConfig[];
  created_at: string;
  updated_at: string;
}

/**
 * Result of resolving effective project settings.
 */
export interface ResolvedProjectSettings {
  /** The effective settings to use */
  config: ProjectSettingsConfig;
  /** Where the settings came from */
  source: "userData" | "local";
  /** Whether a local override exists (even if not used due to errors) */
  hasLocalOverride: boolean;
}

const SETTINGS_VERSION = 1;
const LOCAL_CONFIG_DIR = ".creature";
const CONFIG_FILENAME = "project.json";

/**
 * Get current ISO timestamp.
 */
const now = (): string => {
  return new Date().toISOString();
};

// =============================================================================
// userData Project Settings
// =============================================================================

/**
 * Get the root directory for all project settings in userData.
 */
export const getProjectsSettingsRoot = (): string => {
  return path.join(app.getPath("userData"), "projects");
};

/**
 * Get the directory for a specific project's settings in userData.
 */
export const getUserDataProjectDir = (projectId: string): string => {
  return path.join(getProjectsSettingsRoot(), projectId);
};

/**
 * Get the path to a project's settings file in userData.
 */
export const getUserDataProjectConfigPath = (projectId: string): string => {
  return path.join(getUserDataProjectDir(projectId), CONFIG_FILENAME);
};

/**
 * Check if userData settings exist for a project.
 */
export const userDataSettingsExist = (projectId: string): boolean => {
  return fs.existsSync(getUserDataProjectConfigPath(projectId));
};

/**
 * Read project settings from userData.
 * Returns null if the file doesn't exist or is invalid.
 */
export const readUserDataProjectConfig = (projectId: string): ProjectSettingsConfig | null => {
  try {
    const configPath = getUserDataProjectConfigPath(projectId);

    if (!fs.existsSync(configPath)) {
      return null;
    }

    const data = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(data) as ProjectSettingsConfig;

    // Validate required fields
    if (!config.$version || !config.name || !config.profile) {
      console.error("[ProjectSettings] Invalid userData config: missing required fields");
      return null;
    }

    return config;
  } catch (error) {
    console.error("[ProjectSettings] Failed to read userData config for", projectId, error);
    return null;
  }
};

/**
 * Write project settings to userData.
 * Creates the project directory if it doesn't exist.
 * NEVER creates .creature in the user's local directory.
 */
export const writeUserDataProjectConfig = (
  projectId: string,
  config: Omit<ProjectSettingsConfig, "$version" | "updated_at"> & { updated_at?: string }
): ProjectSettingsConfig => {
  try {
    const projectDir = getUserDataProjectDir(projectId);
    const configPath = getUserDataProjectConfigPath(projectId);

    // Ensure project directory exists in userData
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    const fullConfig: ProjectSettingsConfig = {
      $version: SETTINGS_VERSION,
      name: config.name,
      profile: config.profile,
      context: config.context || {},
      mcps: config.mcps || [],
      created_at: config.created_at,
      updated_at: now(),
    };

    fs.writeFileSync(configPath, JSON.stringify(fullConfig, null, 2), "utf8");
    console.log("[ProjectSettings] Wrote userData config for", projectId);

    return fullConfig;
  } catch (error) {
    console.error("[ProjectSettings] Failed to write userData config for", projectId, error);
    throw new Error(`Failed to write project settings: ${error}`);
  }
};

/**
 * Delete project settings from userData.
 */
export const deleteUserDataProjectConfig = (projectId: string): boolean => {
  try {
    const projectDir = getUserDataProjectDir(projectId);

    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
      console.log("[ProjectSettings] Deleted userData settings for", projectId);
    }

    return true;
  } catch (error) {
    console.error("[ProjectSettings] Failed to delete userData config for", projectId, error);
    return false;
  }
};

// =============================================================================
// Local Override Config (.creature/project.json)
// =============================================================================

/**
 * Get the path to the .creature directory in a local directory.
 */
export const getLocalConfigDirPath = (localDir: string): string => {
  return path.join(localDir, LOCAL_CONFIG_DIR);
};

/**
 * Get the path to the local override config file.
 */
export const getLocalOverrideConfigPath = (localDir: string): string => {
  return path.join(localDir, LOCAL_CONFIG_DIR, CONFIG_FILENAME);
};

/**
 * Check if a local override config exists.
 * NEVER creates .creature directory.
 */
export const localOverrideExists = (localDir: string): boolean => {
  return fs.existsSync(getLocalOverrideConfigPath(localDir));
};

/**
 * Check if the .creature directory exists (even if project.json doesn't).
 */
export const localConfigDirExists = (localDir: string): boolean => {
  return fs.existsSync(getLocalConfigDirPath(localDir));
};

/**
 * Read local override config from `.creature/project.json`.
 * Returns null if the file doesn't exist or is invalid.
 * NEVER creates .creature directory.
 */
export const readLocalOverrideConfig = (localDir: string): LocalOverrideConfig | null => {
  try {
    const configPath = getLocalOverrideConfigPath(localDir);

    if (!fs.existsSync(configPath)) {
      return null;
    }

    const data = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(data) as LocalOverrideConfig;

    // Validate required fields
    if (!config.$version || !config.name || !config.profile) {
      console.error("[ProjectSettings] Invalid local override config: missing required fields");
      return null;
    }

    return config;
  } catch (error) {
    console.error("[ProjectSettings] Failed to read local override from", localDir, error);
    return null;
  }
};

/**
 * Write to local override config.
 * ONLY writes if .creature directory already exists.
 * NEVER creates .creature directory.
 *
 * @returns true if written, false if .creature doesn't exist
 */
export const writeLocalOverrideConfig = (
  localDir: string,
  config: Omit<LocalOverrideConfig, "$version" | "updated_at"> & { updated_at?: string }
): LocalOverrideConfig | null => {
  try {
    const configDir = getLocalConfigDirPath(localDir);
    const configPath = getLocalOverrideConfigPath(localDir);

    // NEVER create .creature directory - only write if it already exists
    if (!fs.existsSync(configDir)) {
      console.log("[ProjectSettings] Skipping local write - .creature does not exist at", localDir);
      return null;
    }

    const fullConfig: LocalOverrideConfig = {
      $version: SETTINGS_VERSION,
      name: config.name,
      profile: config.profile,
      context: {
        custom_instructions: config.context?.custom_instructions,
      },
      mcps: config.mcps || [],
      created_at: config.created_at,
      updated_at: now(),
    };

    fs.writeFileSync(configPath, JSON.stringify(fullConfig, null, 2), "utf8");
    console.log("[ProjectSettings] Wrote local override to", configPath);

    return fullConfig;
  } catch (error) {
    console.error("[ProjectSettings] Failed to write local override to", localDir, error);
    return null;
  }
};

// =============================================================================
// Settings Resolution
// =============================================================================

/**
 * Resolve effective project settings.
 *
 * Priority: Local override (.creature/project.json) takes full precedence
 * when it exists and is valid. The local_directory selection is always
 * taken from userData (since it's the user's choice of which folder to use).
 *
 * @param projectId - The project ID
 * @param userDataConfig - The userData settings (must be provided)
 * @returns Resolved settings with source information
 */
export const resolveEffectiveProjectConfig = (
  projectId: string,
  userDataConfig: ProjectSettingsConfig
): ResolvedProjectSettings => {
  const localDir = userDataConfig.context.local_directory?.path;

  // No local directory selected - use userData settings
  if (!localDir) {
    return {
      config: userDataConfig,
      source: "userData",
      hasLocalOverride: false,
    };
  }

  // Check for local override
  const hasOverride = localOverrideExists(localDir);
  if (!hasOverride) {
    return {
      config: userDataConfig,
      source: "userData",
      hasLocalOverride: false,
    };
  }

  // Try to read local override
  const localConfig = readLocalOverrideConfig(localDir);
  if (!localConfig) {
    // Local override exists but is invalid - fall back to userData
    console.warn("[ProjectSettings] Local override invalid, using userData for", projectId);
    return {
      config: userDataConfig,
      source: "userData",
      hasLocalOverride: true,
    };
  }

  // Local override is valid - use it (full replace except local_directory)
  const effectiveConfig: ProjectSettingsConfig = {
    $version: localConfig.$version,
    name: localConfig.name,
    profile: localConfig.profile,
    context: {
      // local_directory is ALWAYS from userData (it's the user's selection)
      local_directory: userDataConfig.context.local_directory,
      custom_instructions: localConfig.context.custom_instructions,
    },
    mcps: localConfig.mcps,
    created_at: localConfig.created_at,
    updated_at: localConfig.updated_at,
  };

  return {
    config: effectiveConfig,
    source: "local",
    hasLocalOverride: true,
  };
};

/**
 * Write project settings to the appropriate location(s).
 *
 * Always writes to userData. If a local_directory is set AND .creature exists
 * in that directory, also writes to .creature/project.json.
 *
 * @param projectId - The project ID
 * @param config - The settings to write
 * @returns The written userData config
 */
export const writeProjectSettings = (
  projectId: string,
  config: Omit<ProjectSettingsConfig, "$version" | "updated_at"> & { updated_at?: string }
): ProjectSettingsConfig => {
  // Always write to userData
  const userDataConfig = writeUserDataProjectConfig(projectId, config);

  // If local_directory is set and .creature exists, also write there
  const localDir = config.context?.local_directory?.path;
  if (localDir && localConfigDirExists(localDir)) {
    writeLocalOverrideConfig(localDir, {
      name: config.name,
      profile: config.profile,
      context: {
        custom_instructions: config.context?.custom_instructions,
      },
      mcps: config.mcps || [],
      created_at: config.created_at,
    });
  }

  return userDataConfig;
};
