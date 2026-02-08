/**
 * Storage RPC Client
 *
 * Provides storage operations via RPC to the Creature host.
 * Used by experimental.ts to route KV and blob operations through the host
 * instead of direct file I/O, ensuring consistent behavior for both local
 * and hosted MCPs.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// =============================================================================
// RPC Method Names
// =============================================================================

export const STORAGE_METHODS = {
  KV_GET: "creature/storage/kv/get",
  KV_SET: "creature/storage/kv/set",
  KV_DELETE: "creature/storage/kv/delete",
  KV_LIST: "creature/storage/kv/list",
  KV_LIST_WITH_VALUES: "creature/storage/kv/listWithValues",
  KV_SEARCH: "creature/storage/kv/search",
  VECTOR_UPSERT: "creature/storage/vector/upsert",
  VECTOR_SEARCH: "creature/storage/vector/search",
  VECTOR_DELETE: "creature/storage/vector/delete",
  BLOB_PUT: "creature/storage/blob/put",
  BLOB_GET: "creature/storage/blob/get",
  BLOB_DELETE: "creature/storage/blob/delete",
  BLOB_LIST: "creature/storage/blob/list",
} as const;

// =============================================================================
// Types
// =============================================================================

export interface KvSearchResult {
  key: string;
  snippet?: string;
  score?: number;
}

export interface VectorSearchResult {
  key: string;
  score: number;
  metadata?: unknown;
}

// =============================================================================
// Server Context
// =============================================================================

/**
 * The current MCP server instance that can be used for sending requests.
 * Set when the App starts and a transport is connected.
 */
let currentServer: McpServer | null = null;

/**
 * Set the current MCP server for storage RPC.
 * Called by App when a transport connects.
 */
export const setCurrentServer = (server: McpServer | null): void => {
  currentServer = server;
};

/**
 * Get the current MCP server.
 */
export const getCurrentServer = (): McpServer | null => {
  return currentServer;
};

/**
 * Check if storage RPC is available.
 * Returns true if running in Creature and a server connection exists.
 */
export const isStorageRpcAvailable = (): boolean => {
  // Check if we're in Creature (env var is set)
  const isCreature = !!process.env.CREATURE_PROJECT_ID;
  // Check if we have a connected server
  return isCreature && currentServer !== null;
};

// =============================================================================
// RPC Helpers
// =============================================================================

// Generic result schema that accepts any object - we'll type-cast the result
const GenericResultSchema = z.record(z.unknown());

/**
 * Send a storage RPC request to the Creature host.
 * Throws if storage RPC is not available.
 */
const sendStorageRequest = async <T>(
  method: string,
  params: Record<string, unknown>
): Promise<T> => {
  if (!currentServer) {
    throw new Error(
      "Storage RPC not available: no server connection. " +
        "Make sure you're calling this from within a tool handler."
    );
  }

  try {
    // Use the underlying Server's request method to send a request to the client.
    // McpServer wraps a Server instance that extends Protocol, which has the request method.
    // The client (Creature Desktop) has handlers registered for these methods.
    // The Protocol.request() method requires a Zod schema for result validation.
    const server = currentServer.server;
    const result = await server.request(
      { method, params },
      GenericResultSchema
    );
    return result as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Storage RPC failed (${method}): ${message}`);
  }
};

// =============================================================================
// KV Operations
// =============================================================================

/**
 * Get a value from the KV store via RPC.
 */
export const rpcKvGet = async (key: string): Promise<string | null> => {
  const result = await sendStorageRequest<{ value: string | null }>(
    STORAGE_METHODS.KV_GET,
    { key }
  );
  return result.value;
};

/**
 * Set a value in the KV store via RPC.
 */
export const rpcKvSet = async (key: string, value: string): Promise<boolean> => {
  const result = await sendStorageRequest<{ success: boolean }>(
    STORAGE_METHODS.KV_SET,
    { key, value }
  );
  return result.success;
};

/**
 * Delete a key from the KV store via RPC.
 */
export const rpcKvDelete = async (key: string): Promise<boolean> => {
  const result = await sendStorageRequest<{ deleted: boolean }>(
    STORAGE_METHODS.KV_DELETE,
    { key }
  );
  return result.deleted;
};

/**
 * List keys in the KV store via RPC.
 */
export const rpcKvList = async (prefix?: string): Promise<string[]> => {
  const result = await sendStorageRequest<{ keys: string[] }>(
    STORAGE_METHODS.KV_LIST,
    { prefix }
  );
  return result.keys;
};

/**
 * List key-value pairs in the KV store via RPC.
 * Returns both keys and values in a single request to avoid N+1 lookups.
 */
export const rpcKvListWithValues = async (
  prefix?: string
): Promise<Array<{ key: string; value: string }>> => {
  const result = await sendStorageRequest<{ entries: Array<{ key: string; value: string }> }>(
    STORAGE_METHODS.KV_LIST_WITH_VALUES,
    { prefix }
  );
  return result.entries;
};

/**
 * Search values in the KV store via RPC.
 */
export const rpcKvSearch = async (
  query: string,
  options?: { prefix?: string; limit?: number }
): Promise<KvSearchResult[]> => {
  const result = await sendStorageRequest<{ matches: KvSearchResult[] }>(
    STORAGE_METHODS.KV_SEARCH,
    { query, prefix: options?.prefix, limit: options?.limit }
  );
  return result.matches;
};

export const rpcVectorUpsert = async (
  key: string,
  text: string,
  metadata?: unknown
): Promise<boolean> => {
  const result = await sendStorageRequest<{ success: boolean }>(
    STORAGE_METHODS.VECTOR_UPSERT,
    { key, text, metadata }
  );
  return result.success;
};

export const rpcVectorSearch = async (
  query: string,
  options?: { prefix?: string; limit?: number }
): Promise<VectorSearchResult[]> => {
  const result = await sendStorageRequest<{ matches: VectorSearchResult[] }>(
    STORAGE_METHODS.VECTOR_SEARCH,
    { query, prefix: options?.prefix, limit: options?.limit }
  );
  return result.matches;
};

export const rpcVectorDelete = async (key: string): Promise<boolean> => {
  const result = await sendStorageRequest<{ deleted: boolean }>(
    STORAGE_METHODS.VECTOR_DELETE,
    { key }
  );
  return result.deleted;
};

// =============================================================================
// Blob Operations
// =============================================================================

/**
 * Store a blob via RPC.
 */
export const rpcBlobPut = async (
  name: string,
  data: Buffer | Uint8Array,
  mimeType?: string
): Promise<{ success: true; size: number } | null> => {
  const result = await sendStorageRequest<{ success: true; size: number }>(
    STORAGE_METHODS.BLOB_PUT,
    {
      name,
      data: Buffer.from(data).toString("base64"),
      mimeType,
    }
  );
  return result;
};

/**
 * Get a blob via RPC.
 */
export const rpcBlobGet = async (
  name: string
): Promise<{ data: Buffer; mimeType?: string } | null> => {
  const result = await sendStorageRequest<{ data: string | null; mimeType?: string }>(
    STORAGE_METHODS.BLOB_GET,
    { name }
  );
  if (result.data === null) {
    return null;
  }
  return {
    data: Buffer.from(result.data, "base64"),
    mimeType: result.mimeType,
  };
};

/**
 * Delete a blob via RPC.
 */
export const rpcBlobDelete = async (name: string): Promise<boolean> => {
  const result = await sendStorageRequest<{ deleted: boolean }>(
    STORAGE_METHODS.BLOB_DELETE,
    { name }
  );
  return result.deleted;
};

/**
 * List blobs via RPC.
 */
export const rpcBlobList = async (prefix?: string): Promise<string[]> => {
  const result = await sendStorageRequest<{ names: string[] }>(
    STORAGE_METHODS.BLOB_LIST,
    { prefix }
  );
  return result.names;
};
