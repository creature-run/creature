/**
 * Environment Utilities
 *
 * Helpers for managing process environment in packaged Electron apps.
 * macOS apps launched from Finder have minimal PATH that doesn't include
 * user-installed tools like npm, node, etc.
 */

import { app } from "electron";
import path from "path";

const isWindows = process.platform === "win32";
const pathSeparator = isWindows ? ";" : ":";

/**
 * Common paths where Node.js/npm are installed by various package managers.
 * Used to extend PATH when running commands.
 */
const getNodeInstallationPaths = (): string[] => {
  if (isWindows) {
    const appData = process.env.APPDATA ?? "";
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const userProfile = process.env.USERPROFILE ?? "";
    
    return [
      path.join(programFiles, "nodejs"),                    // Standard Node.js install
      path.join(appData, "npm"),                            // npm global packages
      path.join(appData, "nvm"),                            // nvm-windows
      path.join(localAppData, "Volta", "bin"),              // Volta
      path.join(userProfile, ".fnm"),                       // fnm
      path.join(userProfile, "scoop", "shims"),             // Scoop
    ];
  }
  
  const home = process.env.HOME ?? "";
  return [
    "/usr/local/bin",                              // Homebrew (Intel Mac)
    "/opt/homebrew/bin",                           // Homebrew (Apple Silicon)
    "/usr/bin",                                    // System
    path.join(home, ".asdf/shims"),                // asdf
    path.join(home, ".nvm/current/bin"),           // nvm
    path.join(home, ".volta/bin"),                 // volta
    path.join(home, ".fnm/current/bin"),           // fnm
  ];
};

/**
 * Get extended PATH string with common Node installation locations.
 * Always extends PATH to ensure Node tools are available when spawning commands.
 *
 * @param currentPath - The current PATH value (defaults to process.env.PATH)
 * @returns Extended PATH string with Node installation locations prepended
 *
 * @example
 * const env = { ...process.env, PATH: getExtendedPath() };
 * spawn(command, args, { env });
 */
export const getExtendedPath = (currentPath?: string): string => {
  const basePath = currentPath ?? process.env.PATH ?? "";
  const extraPaths = getNodeInstallationPaths().join(pathSeparator);
  return `${extraPaths}${pathSeparator}${basePath}`;
};

/**
 * Build environment object with extended PATH for spawning commands.
 * Only extends PATH when running as a packaged app.
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
