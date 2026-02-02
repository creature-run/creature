/**
 * Window Path Utilities
 *
 * Provides correct paths for window assets in both dev and packaged modes.
 */

import { app } from "electron";
import path from "node:path";

/**
 * Get the directory containing popout HTML files.
 *
 * - Dev: Files are in dist/assets/popouts/ (built by vite.popout.config.mts)
 * - Packaged: Files are copied to Resources/mcp-uis/assets/popouts/
 */
export const getPopoutsDir = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "mcp-uis", "assets", "popouts");
  }
  // Dev mode: __dirname is .vite/build/, popouts are in dist/assets/popouts/
  return path.join(__dirname, "../../dist/assets/popouts");
};
