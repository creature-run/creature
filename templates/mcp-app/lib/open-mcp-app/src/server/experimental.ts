/**
 * Experimental Server APIs
 *
 * These APIs provide access to host-specific features that may not be
 * supported by all hosts. Functions return null or throw when running
 * outside a supported environment.
 *
 * All experimental APIs are subject to change and should be used with
 * appropriate fallbacks.
 *
 * Recommended usage via `exp` namespace:
 * ```typescript
 * import { exp } from "open-mcp-app/server";
 *
 * const dir = exp.getWritableDirectory();
 * await exp.kvSet("key", "value");
 * ```
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  CreateMessageRequestParams,
  CreateMessageResult,
  CreateMessageResultWithTools,
  SamplingMessageContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import { getCurrentServer } from "./storageRpc.js";

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Get the writable storage directory from environment.
 * Internal helper - use experimental_getWritableDirectory for the public API.
 */
const getStorageDir = (): string | null => {
  const dir = process.env.CREATURE_MCP_STORAGE_DIR;
  return dir && dir.length > 0 ? dir : null;
};

/**
 * Resolve and validate a path is within the storage directory.
 * Throws if path escapes the sandbox or storage is unavailable.
 *
 * @param relativePath - Path relative to storage directory
 * @returns Absolute path within storage directory
 * @throws Error if storage unavailable or path escapes sandbox
 */
const resolveSafePath = (relativePath: string): string => {
  const storageDir = getStorageDir();
  if (!storageDir) {
    throw new Error(
      "Storage directory not available. This API only works when running inside Creature with a project open."
    );
  }

  // Resolve to absolute path
  const resolved = path.resolve(storageDir, relativePath);

  // Ensure the resolved path is within the storage directory
  // This prevents path traversal attacks like "../../../etc/passwd"
  const normalizedStorage = path.normalize(storageDir) + path.sep;
  const normalizedResolved = path.normalize(resolved);

  if (!normalizedResolved.startsWith(normalizedStorage) && normalizedResolved !== path.normalize(storageDir)) {
    throw new Error(
      `Path "${relativePath}" escapes the storage directory. Paths must stay within the designated storage area.`
    );
  }

  return resolved;
};

// ============================================================================
// Directory & Path APIs
// ============================================================================

/**
 * Get the writable storage directory for this MCP instance.
 *
 * When running inside Creature, returns an absolute path to a directory
 * where the MCP can safely read and write files. The directory is:
 * - Scoped to the current Creature project and MCP server name
 * - Persisted across restarts
 * - Located outside the user's repository
 *
 * Returns null when:
 * - Running outside Creature (e.g., in standalone mode, ChatGPT, or other hosts)
 * - No project is currently open in Creature
 *
 * @returns Absolute path to writable directory, or null if unavailable
 *
 * @example
 * ```typescript
 * import { experimental_getWritableDirectory } from "open-mcp-app/server";
 *
 * const storageDir = experimental_getWritableDirectory();
 * if (storageDir) {
 *   // Storage available - use sandboxed file APIs
 * } else {
 *   // Fallback to in-memory storage
 * }
 * ```
 */
export function experimental_getWritableDirectory(): string | null {
  return getStorageDir();
}

/**
 * Get the current Creature project ID.
 *
 * Returns the UUID of the currently open Creature project, which can be
 * used for server-side state keying or API calls.
 *
 * Returns null when running outside Creature or no project is open.
 *
 * @returns Creature project UUID, or null if unavailable
 */
export function experimental_getProjectId(): string | null {
  const id = process.env.CREATURE_PROJECT_ID;
  return id && id.length > 0 ? id : null;
}

/**
 * Get the MCP server name as known to Creature.
 *
 * Returns the server name used by Creature to identify this MCP,
 * typically the npm package name.
 *
 * Returns null when running outside Creature.
 *
 * @returns MCP server name, or null if unavailable
 */
export function experimental_getServerName(): string | null {
  const name = process.env.CREATURE_MCP_SERVER_NAME;
  return name && name.length > 0 ? name : null;
}


// ============================================================================
// Sandboxed File I/O APIs
// ============================================================================

/**
 * Read a file from the storage directory.
 *
 * All paths are relative to the storage directory and cannot escape it.
 * Throws if the path attempts to escape the sandbox.
 *
 * @param relativePath - Path relative to storage directory
 * @param encoding - File encoding (default: "utf-8")
 * @returns File contents as string
 * @throws Error if storage unavailable, path escapes sandbox, or file not found
 *
 * @example
 * ```typescript
 * import { experimental_readFile } from "open-mcp-app/server";
 *
 * const data = await experimental_readFile("config.json");
 * const config = JSON.parse(data);
 * ```
 */
export async function experimental_readFile(
  relativePath: string,
  encoding: BufferEncoding = "utf-8"
): Promise<string> {
  const safePath = resolveSafePath(relativePath);
  return fsPromises.readFile(safePath, { encoding });
}

/**
 * Read a file from the storage directory synchronously.
 *
 * @param relativePath - Path relative to storage directory
 * @param encoding - File encoding (default: "utf-8")
 * @returns File contents as string
 * @throws Error if storage unavailable, path escapes sandbox, or file not found
 */
export function experimental_readFileSync(
  relativePath: string,
  encoding: BufferEncoding = "utf-8"
): string {
  const safePath = resolveSafePath(relativePath);
  return fs.readFileSync(safePath, { encoding });
}

/**
 * Write a file to the storage directory.
 *
 * All paths are relative to the storage directory and cannot escape it.
 * Creates parent directories if they don't exist.
 * Throws if the path attempts to escape the sandbox.
 *
 * @param relativePath - Path relative to storage directory
 * @param data - Content to write
 * @param encoding - File encoding (default: "utf-8")
 * @throws Error if storage unavailable or path escapes sandbox
 *
 * @example
 * ```typescript
 * import { experimental_writeFile } from "open-mcp-app/server";
 *
 * await experimental_writeFile("config.json", JSON.stringify(config, null, 2));
 * await experimental_writeFile("data/notes.json", notesJson);
 * ```
 */
export async function experimental_writeFile(
  relativePath: string,
  data: string,
  encoding: BufferEncoding = "utf-8"
): Promise<void> {
  const safePath = resolveSafePath(relativePath);

  // Create parent directories if needed
  const dir = path.dirname(safePath);
  await fsPromises.mkdir(dir, { recursive: true });

  await fsPromises.writeFile(safePath, data, { encoding });
}

/**
 * Write a file to the storage directory synchronously.
 *
 * @param relativePath - Path relative to storage directory
 * @param data - Content to write
 * @param encoding - File encoding (default: "utf-8")
 * @throws Error if storage unavailable or path escapes sandbox
 */
export function experimental_writeFileSync(
  relativePath: string,
  data: string,
  encoding: BufferEncoding = "utf-8"
): void {
  const safePath = resolveSafePath(relativePath);

  // Create parent directories if needed
  const dir = path.dirname(safePath);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(safePath, data, { encoding });
}

/**
 * Delete a file from the storage directory.
 *
 * @param relativePath - Path relative to storage directory
 * @throws Error if storage unavailable, path escapes sandbox, or file not found
 *
 * @example
 * ```typescript
 * import { experimental_deleteFile } from "open-mcp-app/server";
 *
 * await experimental_deleteFile("temp/cache.json");
 * ```
 */
export async function experimental_deleteFile(relativePath: string): Promise<void> {
  const safePath = resolveSafePath(relativePath);
  await fsPromises.unlink(safePath);
}

/**
 * Delete a file from the storage directory synchronously.
 *
 * @param relativePath - Path relative to storage directory
 * @throws Error if storage unavailable, path escapes sandbox, or file not found
 */
export function experimental_deleteFileSync(relativePath: string): void {
  const safePath = resolveSafePath(relativePath);
  fs.unlinkSync(safePath);
}

/**
 * Check if a file or directory exists in the storage directory.
 *
 * @param relativePath - Path relative to storage directory
 * @returns true if the path exists, false otherwise
 * @throws Error if storage unavailable or path escapes sandbox
 *
 * @example
 * ```typescript
 * import { experimental_exists } from "open-mcp-app/server";
 *
 * if (await experimental_exists("config.json")) {
 *   // Load existing config
 * } else {
 *   // Create default config
 * }
 * ```
 */
export async function experimental_exists(relativePath: string): Promise<boolean> {
  const safePath = resolveSafePath(relativePath);
  try {
    await fsPromises.access(safePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a file or directory exists in the storage directory synchronously.
 *
 * @param relativePath - Path relative to storage directory
 * @returns true if the path exists, false otherwise
 * @throws Error if storage unavailable or path escapes sandbox
 */
export function experimental_existsSync(relativePath: string): boolean {
  const safePath = resolveSafePath(relativePath);
  return fs.existsSync(safePath);
}

/**
 * Create a directory in the storage directory.
 *
 * Creates parent directories if they don't exist.
 *
 * @param relativePath - Path relative to storage directory
 * @throws Error if storage unavailable or path escapes sandbox
 *
 * @example
 * ```typescript
 * import { experimental_mkdir } from "open-mcp-app/server";
 *
 * await experimental_mkdir("data/backups");
 * ```
 */
export async function experimental_mkdir(relativePath: string): Promise<void> {
  const safePath = resolveSafePath(relativePath);
  await fsPromises.mkdir(safePath, { recursive: true });
}

/**
 * Create a directory in the storage directory synchronously.
 *
 * @param relativePath - Path relative to storage directory
 * @throws Error if storage unavailable or path escapes sandbox
 */
export function experimental_mkdirSync(relativePath: string): void {
  const safePath = resolveSafePath(relativePath);
  fs.mkdirSync(safePath, { recursive: true });
}

/**
 * List files and directories in a storage directory path.
 *
 * @param relativePath - Path relative to storage directory (default: root)
 * @returns Array of file and directory names
 * @throws Error if storage unavailable, path escapes sandbox, or path not found
 *
 * @example
 * ```typescript
 * import { experimental_readdir } from "open-mcp-app/server";
 *
 * const files = await experimental_readdir("data");
 * for (const file of files) {
 *   console.log(file);
 * }
 * ```
 */
export async function experimental_readdir(relativePath: string = ""): Promise<string[]> {
  const safePath = resolveSafePath(relativePath);
  return fsPromises.readdir(safePath);
}

/**
 * List files and directories in a storage directory path synchronously.
 *
 * @param relativePath - Path relative to storage directory (default: root)
 * @returns Array of file and directory names
 * @throws Error if storage unavailable, path escapes sandbox, or path not found
 */
export function experimental_readdirSync(relativePath: string = ""): string[] {
  const safePath = resolveSafePath(relativePath);
  return fs.readdirSync(safePath);
}

/**
 * Remove a directory and all its contents from the storage directory.
 *
 * @param relativePath - Path relative to storage directory
 * @throws Error if storage unavailable or path escapes sandbox
 *
 * @example
 * ```typescript
 * import { experimental_rmdir } from "open-mcp-app/server";
 *
 * await experimental_rmdir("temp");
 * ```
 */
export async function experimental_rmdir(relativePath: string): Promise<void> {
  const safePath = resolveSafePath(relativePath);
  await fsPromises.rm(safePath, { recursive: true, force: true });
}

/**
 * Remove a directory and all its contents from the storage directory synchronously.
 *
 * @param relativePath - Path relative to storage directory
 * @throws Error if storage unavailable or path escapes sandbox
 */
export function experimental_rmdirSync(relativePath: string): void {
  const safePath = resolveSafePath(relativePath);
  fs.rmSync(safePath, { recursive: true, force: true });
}

// ============================================================================
// KV Store APIs (Creature Extension)
// ============================================================================

import {
  isStorageRpcAvailable,
  rpcKvGet,
  rpcKvSet,
  rpcKvDelete,
  rpcKvList,
  rpcKvListWithValues,
  rpcKvSearch,
  rpcVectorUpsert,
  rpcVectorSearch,
  rpcVectorDelete,
  rpcBlobPut,
  rpcBlobGet,
  rpcBlobDelete,
  rpcBlobList,
  type KvSearchResult,
  type VectorSearchResult,
} from "./storageRpc.js";

/** Maximum key length for KV store */
const MAX_KEY_LENGTH = 256;
const MAX_VECTOR_TEXT_LENGTH = 20000;

/**
 * Sanitize a key to prevent security issues.
 * Only allows alphanumeric, dash, underscore, dot, colon, and forward slash.
 * Rejects keys with ".." or absolute paths.
 */
const sanitizeKey = (key: string): string => {
  if (!key || key.length === 0) {
    throw new Error("Key cannot be empty");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`Key exceeds maximum length of ${MAX_KEY_LENGTH}`);
  }
  if (key.includes("..")) {
    throw new Error("Key cannot contain '..'");
  }
  if (path.isAbsolute(key)) {
    throw new Error("Key cannot be an absolute path");
  }
  // Allow a broader set of characters for KV keys (including :)
  if (!/^[a-zA-Z0-9_\-./:]+$/.test(key)) {
    throw new Error("Key contains invalid characters");
  }
  return key;
};

/**
 * Check if KV storage is available.
 *
 * Returns true if running inside Creature with storage enabled.
 * Use this to implement graceful fallbacks.
 *
 * @returns true if KV storage is available
 *
 * @example
 * ```typescript
 * import { experimental_kvIsAvailable } from "open-mcp-app/server";
 *
 * if (experimental_kvIsAvailable()) {
 *   // Use persistent KV storage
 * } else {
 *   // Fall back to in-memory storage
 * }
 * ```
 */
export function experimental_kvIsAvailable(): boolean {
  // KV is available if we're in Creature (storage RPC or env var is set)
  return isStorageRpcAvailable() || getStorageDir() !== null;
}

/**
 * Get a value from the KV store.
 *
 * Uses RPC to communicate with the Creature host for storage operations.
 * This ensures consistent behavior for both local and hosted MCPs.
 *
 * @param key - The key to retrieve
 * @returns The value, or null if not found or storage unavailable
 *
 * @example
 * ```typescript
 * import { experimental_kvGet } from "open-mcp-app/server";
 *
 * const value = await experimental_kvGet("user:preferences");
 * if (value) {
 *   const prefs = JSON.parse(value);
 * }
 * ```
 */
export async function experimental_kvGet(key: string): Promise<string | null> {
  const sanitizedKey = sanitizeKey(key);
  
  // Use RPC when available (preferred path for both local and hosted MCPs)
  if (isStorageRpcAvailable()) {
    try {
      return await rpcKvGet(sanitizedKey);
    } catch (error) {
      console.error("[KV] RPC error in kvGet:", error);
      return null;
    }
  }
  
  // Fallback: not in Creature or no server connection
  return null;
}

/**
 * Get a value from the KV store synchronously.
 *
 * Note: Sync variants are not supported with RPC and will return null.
 * Use the async version for reliable cross-platform behavior.
 *
 * @param key - The key to retrieve
 * @returns The value, or null if not found or storage unavailable
 * @deprecated Use experimental_kvGet instead for cross-platform support
 */
export function experimental_kvGetSync(key: string): string | null {
  // Sync operations cannot use RPC - return null
  console.warn("[KV] experimental_kvGetSync is deprecated. Use experimental_kvGet for cross-platform support.");
  return null;
}

/**
 * Set a value in the KV store.
 *
 * Uses RPC to communicate with the Creature host for storage operations.
 * This ensures consistent behavior for both local and hosted MCPs.
 *
 * @param key - The key to set
 * @param value - The value to store (string)
 * @returns true if successful, false if storage unavailable
 *
 * @example
 * ```typescript
 * import { experimental_kvSet } from "open-mcp-app/server";
 *
 * await experimental_kvSet("user:preferences", JSON.stringify(prefs));
 * ```
 */
export async function experimental_kvSet(key: string, value: string): Promise<boolean> {
  const sanitizedKey = sanitizeKey(key);
  
  // Use RPC when available (preferred path for both local and hosted MCPs)
  if (isStorageRpcAvailable()) {
    try {
      return await rpcKvSet(sanitizedKey, value);
    } catch (error) {
      console.error("[KV] RPC error in kvSet:", error);
      return false;
    }
  }
  
  // Fallback: not in Creature or no server connection
  return false;
}

/**
 * Set a value in the KV store synchronously.
 *
 * Note: Sync variants are not supported with RPC and will return false.
 * Use the async version for reliable cross-platform behavior.
 *
 * @param key - The key to set
 * @param value - The value to store (string)
 * @returns true if successful, false if storage unavailable
 * @deprecated Use experimental_kvSet instead for cross-platform support
 */
export function experimental_kvSetSync(key: string, value: string): boolean {
  // Sync operations cannot use RPC - return false
  console.warn("[KV] experimental_kvSetSync is deprecated. Use experimental_kvSet for cross-platform support.");
  return false;
}

/**
 * Delete a key from the KV store.
 *
 * Uses RPC to communicate with the Creature host for storage operations.
 * This ensures consistent behavior for both local and hosted MCPs.
 *
 * @param key - The key to delete
 * @returns true if the key existed and was deleted, false otherwise
 *
 * @example
 * ```typescript
 * import { experimental_kvDelete } from "open-mcp-app/server";
 *
 * const deleted = await experimental_kvDelete("user:preferences");
 * ```
 */
export async function experimental_kvDelete(key: string): Promise<boolean> {
  const sanitizedKey = sanitizeKey(key);
  
  // Use RPC when available (preferred path for both local and hosted MCPs)
  if (isStorageRpcAvailable()) {
    try {
      return await rpcKvDelete(sanitizedKey);
    } catch (error) {
      console.error("[KV] RPC error in kvDelete:", error);
      return false;
    }
  }
  
  // Fallback: not in Creature or no server connection
  return false;
}

/**
 * Delete a key from the KV store synchronously.
 *
 * Note: Sync variants are not supported with RPC and will return false.
 * Use the async version for reliable cross-platform behavior.
 *
 * @param key - The key to delete
 * @returns true if the key existed and was deleted, false otherwise
 * @deprecated Use experimental_kvDelete instead for cross-platform support
 */
export function experimental_kvDeleteSync(key: string): boolean {
  // Sync operations cannot use RPC - return false
  console.warn("[KV] experimental_kvDeleteSync is deprecated. Use experimental_kvDelete for cross-platform support.");
  return false;
}

/**
 * List keys in the KV store.
 *
 * Uses RPC to communicate with the Creature host for storage operations.
 * This ensures consistent behavior for both local and hosted MCPs.
 *
 * @param prefix - Optional prefix to filter keys
 * @returns Array of matching keys, or null if storage unavailable
 *
 * @example
 * ```typescript
 * import { experimental_kvList } from "open-mcp-app/server";
 *
 * const userKeys = await experimental_kvList("user:");
 * ```
 */
export async function experimental_kvList(prefix?: string): Promise<string[] | null> {
  const sanitizedPrefix = prefix ? sanitizeKey(prefix) : undefined;
  
  // Use RPC when available (preferred path for both local and hosted MCPs)
  if (isStorageRpcAvailable()) {
    try {
      return await rpcKvList(sanitizedPrefix);
    } catch (error) {
      console.error("[KV] RPC error in kvList:", error);
      return null;
    }
  }
  
  // Fallback: not in Creature or no server connection
  return null;
}

/**
 * List key-value pairs from the KV store.
 *
 * This is more efficient than calling kvList + kvGet for each key,
 * as it fetches all data in a single RPC call.
 *
 * @param prefix - Optional prefix to filter keys
 * @returns Array of key-value pairs, or null if storage unavailable
 *
 * @example
 * ```typescript
 * import { exp } from "open-mcp-app/server";
 *
 * const entries = await exp.kvListWithValues("todos:");
 * for (const { key, value } of entries ?? []) {
 *   console.log(key, JSON.parse(value));
 * }
 * ```
 */
export async function experimental_kvListWithValues(
  prefix?: string
): Promise<Array<{ key: string; value: string }> | null> {
  const sanitizedPrefix = prefix ? sanitizeKey(prefix) : undefined;
  
  // Use RPC when available (preferred path for both local and hosted MCPs)
  if (isStorageRpcAvailable()) {
    try {
      return await rpcKvListWithValues(sanitizedPrefix);
    } catch (error) {
      console.error("[KV] RPC error in kvListWithValues:", error);
      return null;
    }
  }
  
  // Fallback: not in Creature or no server connection
  return null;
}

/**
 * List keys in the KV store synchronously.
 *
 * Note: Sync variants are not supported with RPC and will return null.
 * Use the async version for reliable cross-platform behavior.
 *
 * @param prefix - Optional prefix to filter keys
 * @returns Array of matching keys, or null if storage unavailable
 * @deprecated Use experimental_kvList instead for cross-platform support
 */
export function experimental_kvListSync(prefix?: string): string[] | null {
  // Sync operations cannot use RPC - return null
  console.warn("[KV] experimental_kvListSync is deprecated. Use experimental_kvList for cross-platform support.");
  return null;
}

/**
 * Search values in the KV store using full-text search.
 *
 * Uses SQLite FTS5 on the Creature host for efficient full-text search.
 * Returns results ranked by relevance with optional snippets.
 *
 * @param query - The search query (uses SQLite FTS5 syntax)
 * @param options - Search options
 * @param options.prefix - Optional key prefix to filter results
 * @param options.limit - Maximum number of results (default 50, max 100)
 * @returns Array of search results, or null if storage unavailable
 *
 * @example
 * ```typescript
 * import { experimental_kvSearch } from "open-mcp-app/server";
 *
 * // Search for notes containing "meeting"
 * const results = await experimental_kvSearch("meeting");
 *
 * // Search with prefix filter
 * const todoResults = await experimental_kvSearch("urgent", { prefix: "todos:" });
 *
 * for (const result of results ?? []) {
 *   console.log(result.key, result.snippet, result.score);
 * }
 * ```
 */
export async function experimental_kvSearch(
  query: string,
  options?: { prefix?: string; limit?: number }
): Promise<KvSearchResult[] | null> {
  if (!query || query.trim().length === 0) {
    throw new Error("Search query cannot be empty");
  }
  
  const sanitizedPrefix = options?.prefix ? sanitizeKey(options.prefix) : undefined;
  
  // Use RPC when available
  if (isStorageRpcAvailable()) {
    try {
      return await rpcKvSearch(query, {
        prefix: sanitizedPrefix,
        limit: options?.limit,
      });
    } catch (error) {
      console.error("[KV] RPC error in kvSearch:", error);
      return null;
    }
  }
  
  // Fallback: not in Creature or no server connection
  return null;
}

export function experimental_vectorIsAvailable(): boolean {
  return isStorageRpcAvailable();
}

export async function experimental_vectorUpsert(
  key: string,
  text: string,
  metadata?: unknown
): Promise<boolean> {
  const sanitizedKey = sanitizeKey(key);
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Text cannot be empty");
  }
  if (trimmed.length > MAX_VECTOR_TEXT_LENGTH) {
    throw new Error(`Text exceeds maximum length of ${MAX_VECTOR_TEXT_LENGTH}`);
  }

  if (!isStorageRpcAvailable()) {
    return false;
  }

  return rpcVectorUpsert(sanitizedKey, trimmed, metadata);
}

export async function experimental_vectorSearch(
  query: string,
  options?: { prefix?: string; limit?: number }
): Promise<VectorSearchResult[] | null> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("Search query cannot be empty");
  }
  if (trimmed.length > MAX_VECTOR_TEXT_LENGTH) {
    throw new Error(`Text exceeds maximum length of ${MAX_VECTOR_TEXT_LENGTH}`);
  }

  const sanitizedPrefix = options?.prefix ? sanitizeKey(options.prefix) : undefined;

  if (!isStorageRpcAvailable()) {
    return null;
  }

  return rpcVectorSearch(trimmed, {
    prefix: sanitizedPrefix,
    limit: options?.limit,
  });
}

export async function experimental_vectorDelete(key: string): Promise<boolean> {
  const sanitizedKey = sanitizeKey(key);

  if (!isStorageRpcAvailable()) {
    return false;
  }

  return rpcVectorDelete(sanitizedKey);
}

export type { KvSearchResult, VectorSearchResult };

// ============================================================================
// Blob Store APIs (Creature Extension)
// ============================================================================

/** Maximum blob size in bytes (10MB) */
const MAX_BLOB_SIZE = 10 * 1024 * 1024;

/**
 * Check if blob storage is available.
 *
 * Returns true if running inside Creature with storage enabled.
 * Use this to implement graceful fallbacks.
 *
 * @returns true if blob storage is available
 */
export function experimental_blobIsAvailable(): boolean {
  return isStorageRpcAvailable() || getStorageDir() !== null;
}

/**
 * Store a blob.
 *
 * Uses RPC to communicate with the Creature host for storage operations.
 * This ensures consistent behavior for both local and hosted MCPs.
 *
 * @param name - The blob name (acts as a path within the blobs directory)
 * @param data - The blob data as a Buffer or Uint8Array
 * @param mimeType - Optional MIME type metadata
 * @returns Object with success and size, or null if storage unavailable
 *
 * @example
 * ```typescript
 * import { experimental_blobPut } from "open-mcp-app/server";
 *
 * const imageData = fs.readFileSync("image.png");
 * await experimental_blobPut("images/photo.png", imageData, "image/png");
 * ```
 */
export async function experimental_blobPut(
  name: string,
  data: Buffer | Uint8Array,
  mimeType?: string
): Promise<{ success: true; size: number } | null> {
  const sanitizedName = sanitizeKey(name);

  if (data.length > MAX_BLOB_SIZE) {
    throw new Error(`Blob exceeds maximum size of ${MAX_BLOB_SIZE} bytes`);
  }

  // Use RPC when available
  if (isStorageRpcAvailable()) {
    try {
      return await rpcBlobPut(sanitizedName, data, mimeType);
    } catch (error) {
      console.error("[Blob] RPC error in blobPut:", error);
      return null;
    }
  }

  // Fallback: not in Creature or no server connection
  return null;
}

/**
 * Store a blob synchronously.
 *
 * Note: Sync variants are not supported with RPC and will return null.
 * Use the async version for reliable cross-platform behavior.
 *
 * @param name - The blob name
 * @param data - The blob data
 * @param mimeType - Optional MIME type metadata
 * @returns Object with success and size, or null if storage unavailable
 * @deprecated Use experimental_blobPut instead for cross-platform support
 */
export function experimental_blobPutSync(
  name: string,
  data: Buffer | Uint8Array,
  mimeType?: string
): { success: true; size: number } | null {
  // Sync operations cannot use RPC - return null
  console.warn("[Blob] experimental_blobPutSync is deprecated. Use experimental_blobPut for cross-platform support.");
  return null;
}

/**
 * Retrieve a blob.
 *
 * Uses RPC to communicate with the Creature host for storage operations.
 * This ensures consistent behavior for both local and hosted MCPs.
 *
 * @param name - The blob name
 * @returns Object with data and optional mimeType, or null if not found
 *
 * @example
 * ```typescript
 * import { experimental_blobGet } from "open-mcp-app/server";
 *
 * const result = await experimental_blobGet("images/photo.png");
 * if (result) {
 *   // result.data is a Buffer
 *   // result.mimeType is optional string
 * }
 * ```
 */
export async function experimental_blobGet(
  name: string
): Promise<{ data: Buffer; mimeType?: string } | null> {
  const sanitizedName = sanitizeKey(name);

  // Use RPC when available
  if (isStorageRpcAvailable()) {
    try {
      return await rpcBlobGet(sanitizedName);
    } catch (error) {
      console.error("[Blob] RPC error in blobGet:", error);
      return null;
    }
  }

  // Fallback: not in Creature or no server connection
  return null;
}
/**
 * Retrieve a blob synchronously.
 *
 * Note: Sync variants are not supported with RPC and will return null.
 * Use the async version for reliable cross-platform behavior.
 *
 * @param name - The blob name
 * @returns Object with data and optional mimeType, or null if not found
 * @deprecated Use experimental_blobGet instead for cross-platform support
 */
export function experimental_blobGetSync(
  name: string
): { data: Buffer; mimeType?: string } | null {
  // Sync operations cannot use RPC - return null
  console.warn("[Blob] experimental_blobGetSync is deprecated. Use experimental_blobGet for cross-platform support.");
  return null;
}

/**
 * Delete a blob.
 *
 * Uses RPC to communicate with the Creature host for storage operations.
 * This ensures consistent behavior for both local and hosted MCPs.
 *
 * @param name - The blob name
 * @returns true if deleted, false if not found or storage unavailable
 *
 * @example
 * ```typescript
 * import { experimental_blobDelete } from "open-mcp-app/server";
 *
 * await experimental_blobDelete("images/old-photo.png");
 * ```
 */
export async function experimental_blobDelete(name: string): Promise<boolean> {
  const sanitizedName = sanitizeKey(name);

  // Use RPC when available
  if (isStorageRpcAvailable()) {
    try {
      return await rpcBlobDelete(sanitizedName);
    } catch (error) {
      console.error("[Blob] RPC error in blobDelete:", error);
      return false;
    }
  }

  // Fallback: not in Creature or no server connection
  return false;
}

/**
 * Delete a blob synchronously.
 *
 * Note: Sync variants are not supported with RPC and will return false.
 * Use the async version for reliable cross-platform behavior.
 *
 * @param name - The blob name
 * @returns true if deleted, false if not found or storage unavailable
 * @deprecated Use experimental_blobDelete instead for cross-platform support
 */
export function experimental_blobDeleteSync(name: string): boolean {
  // Sync operations cannot use RPC - return false
  console.warn("[Blob] experimental_blobDeleteSync is deprecated. Use experimental_blobDelete for cross-platform support.");
  return false;
}

/**
 * List blobs.
 *
 * Uses RPC to communicate with the Creature host for storage operations.
 * This ensures consistent behavior for both local and hosted MCPs.
 *
 * @param prefix - Optional prefix to filter blob names
 * @returns Array of blob names, or null if storage unavailable
 *
 * @example
 * ```typescript
 * import { experimental_blobList } from "open-mcp-app/server";
 *
 * const images = await experimental_blobList("images/");
 * ```
 */
export async function experimental_blobList(prefix?: string): Promise<string[] | null> {
  const sanitizedPrefix = prefix ? sanitizeKey(prefix) : undefined;

  // Use RPC when available
  if (isStorageRpcAvailable()) {
    try {
      return await rpcBlobList(sanitizedPrefix);
    } catch (error) {
      console.error("[Blob] RPC error in blobList:", error);
      return null;
    }
  }

  // Fallback: not in Creature or no server connection
  return null;
}

/**
 * List blobs synchronously.
 *
 * Note: Sync variants are not supported with RPC and will return null.
 * Use the async version for reliable cross-platform behavior.
 *
 * @param prefix - Optional prefix to filter blob names
 * @returns Array of blob names, or null if storage unavailable
 * @deprecated Use experimental_blobList instead for cross-platform support
 */
export function experimental_blobListSync(prefix?: string): string[] | null {
  // Sync operations cannot use RPC - return null
  console.warn("[Blob] experimental_blobListSync is deprecated. Use experimental_blobList for cross-platform support.");
  return null;
}

export async function experimental_sampleMessage(
  params: CreateMessageRequestParams
): Promise<CreateMessageResult | CreateMessageResultWithTools> {
  const server = getCurrentServer();
  if (!server) {
    throw new Error("Sampling not available: no server connection");
  }
  const rawResult = await server.server.request(
    { method: "sampling/createMessage", params },
    z.record(z.unknown())
  );

  const result = rawResult as Record<string, unknown>;
  const content = result.content as SamplingMessageContentBlock | SamplingMessageContentBlock[] | undefined;
  const hasTools = !!(params.tools || params.toolChoice);

  if (!content) {
    throw new Error("Sampling result missing content");
  }

  if (!hasTools && Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "image") return `[image:${block.mimeType}]`;
        if (block.type === "audio") return `[audio:${block.mimeType}]`;
        if (block.type === "tool_use") return `[tool_use:${block.name}]`;
        if (block.type === "tool_result") return `[tool_result:${block.toolUseId}]`;
        return JSON.stringify(block);
      })
      .join("\n");
    result.content = { type: "text", text };
  }

  if (hasTools && !Array.isArray(content)) {
    result.content = [content];
  }

  return result as CreateMessageResult | CreateMessageResultWithTools;
}

// ============================================================================
// Unified `exp` Namespace
// ============================================================================

/**
 * Experimental APIs namespace.
 *
 * Provides a consistent interface matching the core SDK pattern (`host.exp.*`).
 * All methods are subject to change.
 *
 * @example
 * ```typescript
 * import { exp } from "open-mcp-app/server";
 *
 * // Environment
 * if (exp.isCreatureHost()) {
 *   const dir = exp.getWritableDirectory();
 * }
 *
 * // KV Store
 * await exp.kvSet("user:prefs", JSON.stringify(prefs));
 * const value = await exp.kvGet("user:prefs");
 *
 * // File I/O
 * await exp.writeFile("config.json", JSON.stringify(config));
 * const data = await exp.readFile("config.json");
 * ```
 */
export const exp = {
  // Directory & environment
  getWritableDirectory: experimental_getWritableDirectory,
  getProjectId: experimental_getProjectId,
  getServerName: experimental_getServerName,

  // File I/O (async)
  readFile: experimental_readFile,
  writeFile: experimental_writeFile,
  deleteFile: experimental_deleteFile,
  exists: experimental_exists,
  mkdir: experimental_mkdir,
  readdir: experimental_readdir,
  rmdir: experimental_rmdir,

  // File I/O (sync)
  readFileSync: experimental_readFileSync,
  writeFileSync: experimental_writeFileSync,
  deleteFileSync: experimental_deleteFileSync,
  existsSync: experimental_existsSync,
  mkdirSync: experimental_mkdirSync,
  readdirSync: experimental_readdirSync,
  rmdirSync: experimental_rmdirSync,

  // KV Store
  kvIsAvailable: experimental_kvIsAvailable,
  kvGet: experimental_kvGet,
  kvSet: experimental_kvSet,
  kvDelete: experimental_kvDelete,
  kvList: experimental_kvList,
  kvListWithValues: experimental_kvListWithValues,
  kvSearch: experimental_kvSearch,
  vectorIsAvailable: experimental_vectorIsAvailable,
  vectorUpsert: experimental_vectorUpsert,
  vectorSearch: experimental_vectorSearch,
  vectorDelete: experimental_vectorDelete,
  /** @deprecated Use kvGet instead */
  kvGetSync: experimental_kvGetSync,
  /** @deprecated Use kvSet instead */
  kvSetSync: experimental_kvSetSync,
  /** @deprecated Use kvDelete instead */
  kvDeleteSync: experimental_kvDeleteSync,
  /** @deprecated Use kvList instead */
  kvListSync: experimental_kvListSync,

  // Blob Store
  blobIsAvailable: experimental_blobIsAvailable,
  blobPut: experimental_blobPut,
  blobGet: experimental_blobGet,
  blobDelete: experimental_blobDelete,
  blobList: experimental_blobList,
  /** @deprecated Use blobPut instead */
  blobPutSync: experimental_blobPutSync,
  /** @deprecated Use blobGet instead */
  blobGetSync: experimental_blobGetSync,
  /** @deprecated Use blobDelete instead */
  blobDeleteSync: experimental_blobDeleteSync,
  /** @deprecated Use blobList instead */
  blobListSync: experimental_blobListSync,
  sampleMessage: experimental_sampleMessage,
};
