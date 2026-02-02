/**
 * MCP Storage Directory Helper
 *
 * Computes and creates per-project/per-MCP storage directories under Electron's userData.
 * This provides MCP Apps with a stable, writable filesystem location for persisting data
 * without writing into the user's repository.
 *
 * Directory structure:
 *   userData/mcp-storage/<projectId>/<mcpKey>/
 *
 * The mcpKey is derived from the server name (npm package name) and is made filesystem-safe
 * to work across Windows, macOS, and Linux.
 */

import { app } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Sanitize a server name for use as a filesystem directory name.
 * Replaces unsafe characters with hyphens and limits length.
 */
const sanitizeServerName = (serverName: string): string => {
  // Replace characters that are unsafe on any OS (Windows, macOS, Linux)
  // Also replace @ and / which are common in npm package names
  return serverName
    .replace(/[@/\\:*?"<>|]/g, "-")
    .replace(/^\.+/, "") // Remove leading dots
    .replace(/\.+$/, "") // Remove trailing dots
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-+/, "") // Remove leading hyphens
    .replace(/-+$/, "") // Remove trailing hyphens
    .substring(0, 64); // Limit length
};

/**
 * Generate a short hash of the server name for collision resistance.
 * Returns the first 8 characters of a SHA-256 hash.
 */
const shortHash = (serverName: string): string => {
  return crypto.createHash("sha256").update(serverName).digest("hex").substring(0, 8);
};

/**
 * Generate a filesystem-safe directory key for an MCP server.
 * Combines a sanitized name with a short hash for readability and uniqueness.
 *
 * @example
 * // "@creature/my-app" → "creature-my-app--a1b2c3d4"
 * // "my-mcp-server" → "my-mcp-server--e5f6g7h8"
 */
const getMcpKey = (serverName: string): string => {
  const sanitized = sanitizeServerName(serverName);
  const hash = shortHash(serverName);
  return sanitized ? `${sanitized}--${hash}` : hash;
};

/**
 * Get the root directory for all MCP storage.
 * Creates the directory if it doesn't exist.
 */
export const getMcpStorageRoot = (): string => {
  const root = path.join(app.getPath("userData"), "mcp-storage");
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
};

/**
 * Get the storage directory for a specific project and MCP server.
 * Creates the directory if it doesn't exist.
 *
 * @param projectId - The Creature project UUID
 * @param serverName - The MCP server name (npm package name)
 * @returns Absolute path to the storage directory
 *
 * @example
 * const dir = getMcpStorageDir({
 *   projectId: "550e8400-e29b-41d4-a716-446655440000",
 *   serverName: "@creature/todos",
 * });
 * // → "/Users/me/Library/Application Support/Creature/mcp-storage/550e8400-e29b-41d4-a716-446655440000/creature-todos--a1b2c3d4"
 */
export const getMcpStorageDir = ({
  projectId,
  serverName,
}: {
  projectId: string;
  serverName: string;
}): string => {
  const root = getMcpStorageRoot();
  const mcpKey = getMcpKey(serverName);
  const dir = path.join(root, projectId, mcpKey);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[MCP Storage] Created storage directory: ${dir}`);
  }

  return dir;
};
