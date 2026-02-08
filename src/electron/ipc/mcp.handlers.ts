/**
 * MCP IPC Handlers
 *
 * Handles MCP configuration-related IPC events.
 */

import { ipcMain, app } from "electron";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getMcpServerConfigs, restartMcp, disableMcp, getCurrentFolderPath, closeMcpsForProject, getUIResources } from "../mcp/client";
import { launchResourcePip } from "../mcp/controlPlane";
import { findWorkspaceRoot } from "../utils/workspace";
import { buildSpawnEnv, resolveBundledCommand } from "../utils/env";
import * as telemetry from "../telemetry";

/**
 * Find the path to the MCP app skeleton template directory.
 * Uses the minimal template from desktop/templates/mcp-app.
 * Searches in various locations to support both development and production modes.
 */
const findTemplatePath = (): string | null => {
  // In packaged builds, template is bundled in Resources directory
  if (app.isPackaged) {
    const resourcePath = path.join(process.resourcesPath, "mcp-app-template");
    if (fs.existsSync(path.join(resourcePath, "package.json"))) {
      console.log(`[MCP] Found bundled template at ${resourcePath}`);
      return resourcePath;
    }
    console.warn(`[MCP] Template not found in bundled resources`);
    return null;
  }

  // Development: check templates/mcp-app location
  const devPath = path.resolve(findWorkspaceRoot() || "", "desktop/templates/mcp-app");
  if (fs.existsSync(path.join(devPath, "package.json"))) {
    return devPath;
  }

  return null;
};

const isWithinWorkspace = (targetPath: string): boolean => {
  const workspaceRoot = findWorkspaceRoot();
  if (!workspaceRoot) return false;

  const relativePath = path.relative(workspaceRoot, targetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return false;
  }

  const pkgJsonPath = path.join(workspaceRoot, "package.json");
  try {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    const workspaces: string[] = pkgJson.workspaces || [];
    const firstDir = relativePath.split(path.sep)[0];
    
    for (const pattern of workspaces) {
      if (pattern.includes("*")) {
        const prefix = pattern.replace("*", "");
        if (firstDir.startsWith(prefix)) {
          return true;
        }
      } else if (firstDir === pattern) {
        return true;
      }
    }
  } catch {}

  return false;
};

/**
 * Copy a directory recursively.
 * Excludes node_modules and dist directories.
 */
const copyDirectory = ({
  src,
  dest,
  excludeDirs = ["node_modules", "dist"],
}: {
  src: string;
  dest: string;
  excludeDirs?: string[];
}): void => {
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (!excludeDirs.includes(entry.name)) {
        copyDirectory({ src: srcPath, dest: destPath, excludeDirs });
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
};

/**
 * Recursively replace a placeholder string in all text files within a directory.
 * Only processes files with extensions commonly used in MCP app templates
 * (.ts, .tsx, .json, .html, .css, .js) to avoid corrupting binary files.
 */
const replaceInAllFiles = ({
  dir,
  placeholder,
  value,
}: {
  dir: string;
  placeholder: string;
  value: string;
}): void => {
  const textExtensions = new Set([".ts", ".tsx", ".json", ".html", ".css", ".js"]);
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!["node_modules", "dist", ".creature"].includes(entry.name)) {
        replaceInAllFiles({ dir: fullPath, placeholder, value });
      }
    } else if (textExtensions.has(path.extname(entry.name))) {
      const content = fs.readFileSync(fullPath, "utf-8");
      if (content.includes(placeholder)) {
        fs.writeFileSync(fullPath, content.replaceAll(placeholder, value));
      }
    }
  }
};

/**
 * Run a shell command and return a promise.
 * Uses bundled npm/npx when available (in packaged app).
 */
const runCommand = ({
  command,
  args,
  cwd,
}: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<{ success: boolean; error?: string }> => {
  return new Promise((resolve) => {
    // Resolve npm/npx to bundled versions when available
    const resolved = resolveBundledCommand(command, args);
    const finalCommand = resolved.command;
    const finalArgs = resolved.args;

    console.log(`[MCP] Running: ${finalCommand} ${finalArgs.join(" ")} in ${cwd}`);

    const env = buildSpawnEnv({ npm_config_yes: "true" });

    const proc = spawn(finalCommand, finalArgs, {
      cwd,
      shell: !resolved.useBundled, // Don't use shell when running bundled node directly
      env,
    });

    let stderr = "";

    proc.stdout?.on("data", (data) => {
      console.log(`[MCP] stdout: ${data}`);
    });

    proc.stderr?.on("data", (data) => {
      console.error(`[MCP] stderr: ${data}`);
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr || `Process exited with code ${code}` });
      }
    });

    proc.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      proc.kill();
      resolve({ success: false, error: "Command timed out after 2 minutes" });
    }, 120000);
  });
};

/**
 * Create a new MCP from the skeleton template.
 *
 * Copies the minimal template from desktop/templates/mcp-app, replaces
 * __APP_NAME__ placeholders with the canonical app name, then installs
 * dependencies and builds.
 *
 * @param params.targetPath - Parent directory to create the MCP folder in
 * @param params.name - Folder name for the new MCP on disk
 * @param params.appName - Canonical MCP App name (used in package.json, createApp, URIs)
 */
export const createFromTemplate = async ({
  targetPath,
  name,
  appName,
}: {
  targetPath: string;
  name: string;
  appName: string;
}): Promise<{ success: boolean; error?: string }> => {
  console.log(`[MCP] Creating new MCP from template: ${name} (app: ${appName}) at ${targetPath}`);

  // Find template directory
  const templatePath = findTemplatePath();
  if (!templatePath) {
      return { success: false, error: "Could not find MCP app template directory" };
  }

  // Create target directory path
  const mcpDir = path.join(targetPath, name);

  // Check if directory already exists
  if (fs.existsSync(mcpDir)) {
    return { success: false, error: `Directory already exists: ${mcpDir}` };
  }

  try {
    // Step 1: Copy template (excludes node_modules, dist, .creature)
    console.log(`[MCP] Copying template from ${templatePath} to ${mcpDir}`);
    copyDirectory({ src: templatePath, dest: mcpDir, excludeDirs: ["node_modules", "dist", ".creature"] });

    // Step 1b: Remove package-lock.json if copied (it may have stale file: references)
    const lockFilePath = path.join(mcpDir, "package-lock.json");
    if (fs.existsSync(lockFilePath)) {
      fs.unlinkSync(lockFilePath);
    }

    // Step 2: Replace __APP_NAME__ placeholder in all source files.
    // The skeleton template uses __APP_NAME__ as a universal placeholder
    // in package.json, server index, and UI entry — one simple find-replace.
    replaceInAllFiles({ dir: mcpDir, placeholder: "__APP_NAME__", value: appName });

    // Step 2b: Handle workspace SDK linking and package.json overrides
    const packageJsonPath = path.join(mcpDir, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

    if (isWithinWorkspace(mcpDir) && packageJson.dependencies?.["open-mcp-app"]) {
      packageJson.dependencies["open-mcp-app"] = "*";
      console.log(`[MCP] Within workspace: using * for SDK`);
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    }

    // Step 3: Run npm install first, then link local SDK in dev mode
    // Order matters: npm install can remove symlinks, so we link after install
    const installResult = await runCommand({
      command: "npm",
      args: ["install"],
      cwd: mcpDir,
    });

    if (!installResult.success) {
      return { success: false, error: `npm install failed: ${installResult.error}` };
    }

    // Step 4: Run npm run build
    const buildResult = await runCommand({
      command: "npm",
      args: ["run", "build"],
      cwd: mcpDir,
    });

    if (!buildResult.success) {
      return { success: false, error: `npm run build failed: ${buildResult.error}` };
    }

    // Note: The created MCP will auto-detect as a Development MCP
    // when the user opens this folder as a project (creature.publish: true)
    console.log(`[MCP] Successfully created MCP: ${name}`);
    return { success: true };
  } catch (error) {
    console.error(`[MCP] Failed to create MCP:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Register MCP configuration IPC handlers.
 */
export const registerMcpHandlers = () => {
  /**
   * Get all MCP server configs for UI display.
   */
  ipcMain.handle("mcp:getConfigs", async () => {
    return getMcpServerConfigs();
  });

  /**
   * Create a new MCP from the example template.
   */
  ipcMain.handle("mcp:createFromTemplate", async (_, { targetPath, name, appName }) => {
    const result = await createFromTemplate({ targetPath, name, appName: appName || name });

    // Track MCP creation (no paths)
    telemetry.track("mcp_create_from_template", {
      success: result.success,
    });

    return result;
  });

  /**
   * Restart an MCP server by name.
   * Optionally accepts config for new custom MCPs.
   */
  ipcMain.handle("mcp:restart", async (_, { name, config }: { 
    name: string; 
    config?: { 
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
    };
  }) => {
    try {
      await restartMcp({ name, config });

      // Track MCP restart
      telemetry.track("mcp_restart", { server_name: name });

      return { success: true };
    } catch (error) {
      console.error("[MCP] Failed to restart:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  });

  /**
   * Disable and close an MCP server by name.
   * Used when deleting an MCP from project settings.
   */
  ipcMain.handle("mcp:disable", async (_, { name }) => {
    try {
      await disableMcp({ name });
      return { success: true };
    } catch (error) {
      console.error("[MCP] Failed to disable:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  });

  /**
   * Close all MCP connections.
   * Called when navigating away from a project (back to project list).
   */
  ipcMain.handle("mcp:closeAll", async () => {
    try {
      await closeMcpsForProject();

      // Track MCP close all
      telemetry.track("mcp_close_all");

      return { success: true };
    } catch (error) {
      console.error("[MCP] Failed to close all:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  });

  /**
   * Get the current folder path.
   * Returns null if no project folder is set.
   */
  ipcMain.handle("folder:getCurrent", () => {
    return getCurrentFolderPath();
  });

  /**
   * Get all UI resources from connected MCP servers.
   * Used by the sidebar to display MCP App icons.
   */
  ipcMain.handle("mcp:getUIResources", () => {
    return getUIResources();
  });

  /**
   * Launch a pip for a UI resource directly (without a tool call).
   * If a pip already exists for this resource, focuses it instead.
   */
  ipcMain.handle("mcp:launchResourcePip", async (_, { serverName, resourceUri }: { serverName: string; resourceUri: string }) => {
    try {
      const result = await launchResourcePip({ serverName, resourceUri });

      // Track pip launch
      telemetry.track("mcp_launch_resource_pip", {
        server_name: serverName,
        success: result.success,
      });

      return result;
    } catch (error) {
      console.error("[MCP] Failed to launch resource pip:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  });
};
