/**
 * Workspace Utilities
 *
 * Functions for finding and working with the Creature monorepo workspace.
 */

import path from "node:path";
import fs from "node:fs";
import { app } from "electron";

/**
 * Find the workspace root by looking for a package.json with workspaces field.
 * Searches multiple starting points and traverses up to find the monorepo root.
 *
 * @returns The workspace root path if found, null otherwise.
 */
export const findWorkspaceRoot = (): string | null => {
  const startPaths = [
    path.resolve(__dirname, "../../.."),
    path.resolve(__dirname, "../../../.."),
    app.getAppPath(),
    process.cwd(),
  ];

  for (const startPath of startPaths) {
    let currentPath = startPath;

    // Traverse up to find workspace root (max 5 levels)
    for (let i = 0; i < 5; i++) {
      const pkgJsonPath = path.join(currentPath, "package.json");
      if (fs.existsSync(pkgJsonPath)) {
        try {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
          if (pkgJson.workspaces && Array.isArray(pkgJson.workspaces)) {
            // Verify this is the creature workspace by checking for sdk workspace
            if (pkgJson.workspaces.includes("sdk") || pkgJson.name === "creature") {
              return currentPath;
            }
          }
        } catch {
          // Ignore parse errors
        }
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) break; // Reached filesystem root
      currentPath = parentPath;
    }
  }

  return null;
};
