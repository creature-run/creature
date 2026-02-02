/**
 * Environment Utilities
 *
 * Helpers for managing process environment in packaged Electron apps.
 *
 * The packaged app bundles both Node.js (via Electron) and npm (copied to resources).
 * This ensures the app works without requiring Node/npm to be installed on the system.
 *
 * - Node.js: Available via process.execPath with ELECTRON_RUN_AS_NODE=1
 * - npm/npx: Bundled in Resources/npm/ and run via Electron's Node
 * - node wrapper: Shell script at Resources/bin/node that invokes Electron as Node,
 *   allowing npm postinstall scripts to find and run node
 */

import { app } from "electron";
import fs from "fs";
import path from "path";

/**
 * Get the path to the bin directory containing the node wrapper script.
 * This is created at packaging time in forge.config.ts.
 */
export const getNodeBinDir = (): string | null => {
  if (!app.isPackaged) {
    return null;
  }
  
  const binDir = path.join(process.resourcesPath, "bin");
  if (fs.existsSync(binDir)) {
    return binDir;
  }
  
  return null;
};

/**
 * Get the path to the bundled npm CLI script.
 * In packaged mode, npm is bundled in Resources/npm/bin/npm-cli.js
 * In development, we use the system npm.
 */
export const getBundledNpmCliPath = (): string | null => {
  if (!app.isPackaged) {
    return null; // Use system npm in development
  }

  const npmCliPath = path.join(process.resourcesPath, "npm", "bin", "npm-cli.js");
  if (fs.existsSync(npmCliPath)) {
    return npmCliPath;
  }

  console.warn("[env] Bundled npm not found at:", npmCliPath);
  return null;
};

/**
 * Get the path to the bundled npx CLI script.
 * In packaged mode, npx is bundled in Resources/npm/bin/npx-cli.js
 * In development, we use the system npx.
 */
export const getBundledNpxCliPath = (): string | null => {
  if (!app.isPackaged) {
    return null; // Use system npx in development
  }

  const npxCliPath = path.join(process.resourcesPath, "npm", "bin", "npx-cli.js");
  if (fs.existsSync(npxCliPath)) {
    return npxCliPath;
  }

  return null;
};

/**
 * Resolve a command to use bundled npm/npx when available.
 * Returns { command, args, useBundled } where:
 * - command: The resolved command (process.execPath for bundled, original otherwise)
 * - args: The resolved args (prepended with CLI path for bundled)
 * - useBundled: Whether we're using the bundled version
 *
 * @example
 * // Input: command="npm", args=["install"]
 * // Output (packaged): { command: process.execPath, args: ["/path/to/npm-cli.js", "install"], useBundled: true }
 * // Output (dev): { command: "npm", args: ["install"], useBundled: false }
 */
export const resolveBundledCommand = (
  command: string,
  args: string[]
): { command: string; args: string[]; useBundled: boolean } => {
  if (command === "npm") {
    const npmCli = getBundledNpmCliPath();
    if (npmCli) {
      return {
        command: process.execPath,
        args: [npmCli, ...args],
        useBundled: true,
      };
    }
  }

  if (command === "npx") {
    const npxCli = getBundledNpxCliPath();
    if (npxCli) {
      return {
        command: process.execPath,
        args: [npxCli, ...args],
        useBundled: true,
      };
    }
  }

  return { command, args, useBundled: false };
};

/**
 * Get extended PATH string.
 * In packaged mode, prepends the node bin directory (containing node wrapper)
 * so that npm postinstall scripts can find node.
 *
 * @param currentPath - The current PATH value (defaults to process.env.PATH)
 * @returns Extended PATH string
 */
export const getExtendedPath = (currentPath?: string): string => {
  const basePath = currentPath ?? process.env.PATH ?? "";
  
  // In packaged mode, prepend the node bin directory
  const binDir = getNodeBinDir();
  if (binDir) {
    return `${binDir}:${basePath}`;
  }
  
  return basePath;
};

/**
 * Build environment object for spawning commands.
 *
 * @param additionalEnv - Additional environment variables to include
 * @returns Environment object suitable for spawn/exec
 *
 * @example
 * const env = buildSpawnEnv({ npm_config_yes: "true" });
 * spawn("npm", ["install"], { cwd, env });
 */
export const buildSpawnEnv = (
  additionalEnv: Record<string, string> = {}
): NodeJS.ProcessEnv => {
  return {
    ...process.env,
    ...additionalEnv,
    PATH: getExtendedPath(),
  };
};
