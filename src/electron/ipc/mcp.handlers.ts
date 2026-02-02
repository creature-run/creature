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
 * Find the path to an MCP app template directory.
 * Searches in various locations to support both development and production modes.
 *
 * @param templateName - Template name (e.g., "todos", "notes", "crm")
 */
const findTemplatePath = (templateName: string = "todos"): string | null => {
  const resourceName = `mcp-${templateName}`;

  // In packaged builds, templates are bundled in Resources directory
  if (app.isPackaged) {
    const resourcePath = path.join(process.resourcesPath, resourceName);
    if (fs.existsSync(path.join(resourcePath, "package.json"))) {
      console.log(`[MCP] Found bundled ${templateName} at ${resourcePath}`);
      return resourcePath;
    }
    console.warn(`[MCP] ${templateName} not found in bundled resources`);
    return null;
  }

  // Development: check mcp-apps location
  const devPath = path.resolve(findWorkspaceRoot() || "", `desktop/artifacts/mcp-apps/${templateName}`);
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
 * Create a new MCP from a template.
 *
 * Steps:
 * 1. Copy template to target directory
 * 2. Update package.json with new name
 * 3. Run npm install
 * 4. Run npm run build
 * 5. Add to user MCP configs
 *
 * @param targetPath - Directory to create the MCP in
 * @param name - Name for the new MCP
 * @param template - Template to use ("todos", "notes", or "crm")
 */
export const createFromTemplate = async ({
  targetPath,
  name,
  template = "todos",
}: {
  targetPath: string;
  name: string;
  template?: string;
}): Promise<{ success: boolean; error?: string }> => {
  console.log(`[MCP] Creating new MCP from ${template}: ${name} at ${targetPath}`);

  // Find template directory
  const templatePath = findTemplatePath(template);
  if (!templatePath) {
    return { success: false, error: `Could not find ${template} directory` };
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

    // Step 2: Update package.json with new name, bin field, and creature.name
    const packageJsonPath = path.join(mcpDir, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    packageJson.name = name;
    // Update bin field to use the new name (required for npx to work)
    if (packageJson.bin) {
      packageJson.bin = { [name]: "dist/server.js" };
    }
    // Update creature.name for registry publishing
    if (packageJson.creature) {
      packageJson.creature.name = name;
    }
    
    if (isWithinWorkspace(mcpDir) && packageJson.dependencies?.["open-mcp-app"]) {
      packageJson.dependencies["open-mcp-app"] = "*";
      console.log(`[MCP] Within workspace: using * for SDK`);
    }
    
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

    // Update template identity in source files
    // This handles both legacy format (src/server.ts, src/ui/page.tsx) and
    // artifact format (src/server/lib/types.ts, src/server/index.ts, src/ui/app.tsx)
    
    // Legacy format: src/server.ts
    const serverPath = path.join(mcpDir, "src", "server.ts");
    if (fs.existsSync(serverPath)) {
      let serverContent = fs.readFileSync(serverPath, "utf-8");
      serverContent = serverContent.replace(/name: "mcp-template"/g, `name: "${name}"`);
      serverContent = serverContent.replace(/ui:\/\/mcp-template\//g, `ui://${name}/`);
      fs.writeFileSync(serverPath, serverContent);
    }

    // Legacy format: src/ui/page.tsx
    const pagePath = path.join(mcpDir, "src", "ui", "page.tsx");
    if (fs.existsSync(pagePath)) {
      let pageContent = fs.readFileSync(pagePath, "utf-8");
      pageContent = pageContent.replace(/name: "mcp-template"/g, `name: "${name}"`);
      fs.writeFileSync(pagePath, pageContent);
    }

    // Artifact format: src/server/lib/types.ts - contains MCP_NAME constant
    const typesPath = path.join(mcpDir, "src", "server", "lib", "types.ts");
    if (fs.existsSync(typesPath)) {
      let typesContent = fs.readFileSync(typesPath, "utf-8");
      // Replace MCP_NAME constant (handles mcp-template-todos, mcp-template-notes, mcp-template-crm, etc.)
      typesContent = typesContent.replace(
        /export const MCP_NAME = "mcp-template-[^"]+"/g,
        `export const MCP_NAME = "${name}"`
      );
      // Replace any ui:// URIs that reference the template name
      typesContent = typesContent.replace(
        /ui:\/\/mcp-template-[^/]+\//g,
        `ui://${name}/`
      );
      fs.writeFileSync(typesPath, typesContent);
    }

    // Artifact format: src/ui/app.tsx - contains HostProvider name
    const appTsxPath = path.join(mcpDir, "src", "ui", "app.tsx");
    if (fs.existsSync(appTsxPath)) {
      let appContent = fs.readFileSync(appTsxPath, "utf-8");
      // Replace HostProvider name prop (handles mcp-template-todos, mcp-template-notes, mcp-template-crm, etc.)
      appContent = appContent.replace(
        /<HostProvider name="mcp-template-[^"]+"/g,
        `<HostProvider name="${name}"`
      );
      fs.writeFileSync(appTsxPath, appContent);
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
   * Create a new MCP from the template.
   */
  ipcMain.handle("mcp:createFromTemplate", async (_, { targetPath, name, template }) => {
    const result = await createFromTemplate({ targetPath, name, template });

    // Track MCP creation (no paths)
    telemetry.track("mcp_create_from_template", {
      template: template || "todos",
      success: result.success,
    });

    return result;
  });

  /**
   * Restart an MCP server by name.
   */
  ipcMain.handle("mcp:restart", async (_, { name }) => {
    try {
      await restartMcp({ name });

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
