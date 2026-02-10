/**
 * Creature Storage Extension
 *
 * Implements server→client storage RPC for hosted/remote MCPs.
 * This is a Creature-only extension to the MCP protocol.
 *
 * Storage is scoped by projectId and serverName, stored under:
 *   userData/mcp-storage/<projectId>/<mcpKey>/
 *
 * KV data is stored in SQLite with FTS5 for full-text search.
 *
 * Methods:
 * - creature/storage/kv/get
 * - creature/storage/kv/set
 * - creature/storage/kv/delete
 * - creature/storage/kv/list
 * - creature/storage/kv/search
 * - creature/storage/blob/put
 * - creature/storage/blob/get
 * - creature/storage/blob/delete
 * - creature/storage/blob/list
 */

import fsPromises from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getMcpStorageDir } from "../storage/mcpStorageDir";
import { getCurrentProjectId } from "./client";
import {
  kvGet,
  kvSet,
  kvDelete,
  kvList,
  kvListWithValues,
  kvSearch,
  type KvSearchResult,
} from "../storage/kvSqlite";
import {
  vectorUpsert,
  vectorDelete,
  vectorSearch,
  type VectorSearchResult,
} from "../storage/vectorSqlite";
import { embedText } from "../embeddings/openai";

// =============================================================================
// Constants
// =============================================================================

/** Maximum blob size in bytes (10MB) */
const MAX_BLOB_SIZE = 10 * 1024 * 1024;

/** Maximum key length */
const MAX_KEY_LENGTH = 256;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

// =============================================================================
// Method Names
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
// Request Schemas
// =============================================================================

const KvGetSchema = z.object({
  key: z.string().max(MAX_KEY_LENGTH),
});

const KvSetSchema = z.object({
  key: z.string().max(MAX_KEY_LENGTH),
  value: z.string(),
});

const KvDeleteSchema = z.object({
  key: z.string().max(MAX_KEY_LENGTH),
});

const KvListSchema = z.object({
  prefix: z.string().max(MAX_KEY_LENGTH).optional(),
  cursor: z.string().max(MAX_KEY_LENGTH).optional(),
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
});

const KvListWithValuesSchema = z.object({
  prefix: z.string().max(MAX_KEY_LENGTH).optional(),
  cursor: z.string().max(MAX_KEY_LENGTH).optional(),
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
});

const KvSearchSchema = z.object({
  query: z.string().min(1).max(1000),
  prefix: z.string().max(MAX_KEY_LENGTH).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const VectorUpsertSchema = z.object({
  key: z.string().max(MAX_KEY_LENGTH),
  text: z.string().min(1).max(20000),
  metadata: z.unknown().optional(),
});

const VectorSearchSchema = z.object({
  query: z.string().min(1).max(20000),
  prefix: z.string().max(MAX_KEY_LENGTH).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const VectorDeleteSchema = z.object({
  key: z.string().max(MAX_KEY_LENGTH),
});

const BlobPutSchema = z.object({
  name: z.string().max(MAX_KEY_LENGTH),
  data: z.string(), // base64 encoded
  mimeType: z.string().optional(),
});

const BlobGetSchema = z.object({
  name: z.string().max(MAX_KEY_LENGTH),
});

const BlobDeleteSchema = z.object({
  name: z.string().max(MAX_KEY_LENGTH),
});

const BlobListSchema = z.object({
  prefix: z.string().max(MAX_KEY_LENGTH).optional(),
  cursor: z.string().max(MAX_KEY_LENGTH).optional(),
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
});

// =============================================================================
// Utilities
// =============================================================================

/**
 * Sanitize a key/name to prevent path traversal attacks.
 * Only allows alphanumeric, dash, underscore, dot, colon, and forward slash.
 * Rejects keys with ".." or absolute paths.
 *
 * Note: Colons are allowed to match SDK key naming conventions (e.g., "todos:item:abc123").
 */
const sanitizeKey = (key: string): string => {
  if (!key || key.length === 0) {
    throw new Error("Key cannot be empty");
  }
  if (key.includes("..")) {
    throw new Error("Key cannot contain '..'");
  }
  if (path.isAbsolute(key)) {
    throw new Error("Key cannot be an absolute path");
  }
  // Remove any leading slashes
  const cleaned = key.replace(/^\/+/, "");
  // Only allow safe characters (including colon for SDK compatibility)
  if (!/^[a-zA-Z0-9_\-./:]+$/.test(cleaned)) {
    throw new Error("Key contains invalid characters");
  }
  return cleaned;
};

/**
 * Get the storage directory for a server.
 * Throws if no project is open.
 */
const getStorageDirForServer = (serverName: string): string => {
  const projectId = getCurrentProjectId();
  if (!projectId) {
    throw new Error("No project is currently open");
  }
  return getMcpStorageDir({ projectId, serverName });
};

/**
 * Get the blobs directory path.
 */
const getBlobsDir = (storageDir: string): string => {
  return path.join(storageDir, "blobs");
};

const normalizeListLimit = (limit?: number): number => {
  if (!Number.isInteger(limit)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);
};

// =============================================================================
// KV Handlers
// =============================================================================

/**
 * Handle creature/storage/kv/get
 */
export const handleKvGet = async (
  serverName: string,
  params: unknown
): Promise<{ value: string | null }> => {
  const { key } = KvGetSchema.parse(params);
  const sanitizedKey = sanitizeKey(key);
  const storageDir = getStorageDirForServer(serverName);
  const value = await kvGet(storageDir, sanitizedKey);
  return { value };
};

/**
 * Handle creature/storage/kv/set
 */
export const handleKvSet = async (
  serverName: string,
  params: unknown
): Promise<{ success: true }> => {
  const { key, value } = KvSetSchema.parse(params);
  const sanitizedKey = sanitizeKey(key);
  const storageDir = getStorageDirForServer(serverName);
  await kvSet(storageDir, sanitizedKey, value);
  return { success: true };
};

/**
 * Handle creature/storage/kv/delete
 */
export const handleKvDelete = async (
  serverName: string,
  params: unknown
): Promise<{ deleted: boolean }> => {
  const { key } = KvDeleteSchema.parse(params);
  const sanitizedKey = sanitizeKey(key);
  const storageDir = getStorageDirForServer(serverName);
  const deleted = await kvDelete(storageDir, sanitizedKey);
  return { deleted };
};

/**
 * Handle creature/storage/kv/list
 */
export const handleKvList = async (
  serverName: string,
  params: unknown
): Promise<{ keys: string[]; nextCursor: string | null }> => {
  const { prefix, cursor, limit } = KvListSchema.parse(params);
  const storageDir = getStorageDirForServer(serverName);
  const sanitizedPrefix = prefix ? sanitizeKey(prefix) : undefined;
  const sanitizedCursor = cursor ? sanitizeKey(cursor) : undefined;
  return kvList(storageDir, {
    prefix: sanitizedPrefix,
    cursor: sanitizedCursor,
    limit,
  });
};

/**
 * Handle creature/storage/kv/listWithValues
 * Returns both keys and values in a single query to avoid N+1 lookups.
 */
export const handleKvListWithValues = async (
  serverName: string,
  params: unknown
): Promise<{ entries: Array<{ key: string; value: string }>; nextCursor: string | null }> => {
  const { prefix, cursor, limit } = KvListWithValuesSchema.parse(params);
  const storageDir = getStorageDirForServer(serverName);
  const sanitizedPrefix = prefix ? sanitizeKey(prefix) : undefined;
  const sanitizedCursor = cursor ? sanitizeKey(cursor) : undefined;
  return kvListWithValues(storageDir, {
    prefix: sanitizedPrefix,
    cursor: sanitizedCursor,
    limit,
  });
};

/**
 * Handle creature/storage/kv/search
 */
export const handleKvSearch = async (
  serverName: string,
  params: unknown
): Promise<{ matches: KvSearchResult[] }> => {
  const { query, prefix, limit } = KvSearchSchema.parse(params);
  const storageDir = getStorageDirForServer(serverName);
  const sanitizedPrefix = prefix ? sanitizeKey(prefix) : undefined;
  const matches = await kvSearch(storageDir, query, {
    prefix: sanitizedPrefix,
    limit,
  });
  return { matches };
};

export const handleVectorUpsert = async (
  serverName: string,
  params: unknown
): Promise<{ success: true }> => {
  const { key, text, metadata } = VectorUpsertSchema.parse(params);
  const sanitizedKey = sanitizeKey(key);
  const storageDir = getStorageDirForServer(serverName);
  const { embedding } = await embedText(text);
  await vectorUpsert(storageDir, sanitizedKey, embedding, metadata);
  return { success: true };
};

export const handleVectorSearch = async (
  serverName: string,
  params: unknown
): Promise<{ matches: VectorSearchResult[] }> => {
  const { query, prefix, limit } = VectorSearchSchema.parse(params);
  const storageDir = getStorageDirForServer(serverName);
  const sanitizedPrefix = prefix ? sanitizeKey(prefix) : undefined;
  const { embedding } = await embedText(query);
  const matches = await vectorSearch(storageDir, embedding, {
    prefix: sanitizedPrefix,
    limit,
  });
  return { matches };
};

export const handleVectorDelete = async (
  serverName: string,
  params: unknown
): Promise<{ deleted: boolean }> => {
  const { key } = VectorDeleteSchema.parse(params);
  const sanitizedKey = sanitizeKey(key);
  const storageDir = getStorageDirForServer(serverName);
  const deleted = await vectorDelete(storageDir, sanitizedKey);
  return { deleted };
};

// =============================================================================
// Blob Handlers
// =============================================================================

/**
 * Handle creature/storage/blob/put
 */
export const handleBlobPut = async (
  serverName: string,
  params: unknown
): Promise<{ success: true; size: number }> => {
  const { name, data, mimeType } = BlobPutSchema.parse(params);
  const sanitizedName = sanitizeKey(name);

  // Decode base64 to get size
  const buffer = Buffer.from(data, "base64");
  if (buffer.length > MAX_BLOB_SIZE) {
    throw new Error(`Blob exceeds maximum size of ${MAX_BLOB_SIZE} bytes`);
  }

  const storageDir = getStorageDirForServer(serverName);
  const blobsDir = getBlobsDir(storageDir);
  const blobPath = path.join(blobsDir, sanitizedName);

  // Ensure blob directory exists
  await fsPromises.mkdir(path.dirname(blobPath), { recursive: true });

  // Write the blob
  await fsPromises.writeFile(blobPath, buffer);

  // Optionally store metadata
  if (mimeType) {
    const metaPath = `${blobPath}.meta.json`;
    await fsPromises.writeFile(metaPath, JSON.stringify({ mimeType }), "utf-8");
  }

  return { success: true, size: buffer.length };
};

/**
 * Handle creature/storage/blob/get
 */
export const handleBlobGet = async (
  serverName: string,
  params: unknown
): Promise<{ data: string | null; mimeType?: string }> => {
  const { name } = BlobGetSchema.parse(params);
  const sanitizedName = sanitizeKey(name);

  const storageDir = getStorageDirForServer(serverName);
  const blobsDir = getBlobsDir(storageDir);
  const blobPath = path.join(blobsDir, sanitizedName);

  try {
    const buffer = await fsPromises.readFile(blobPath);
    const data = buffer.toString("base64");

    // Try to read metadata
    let mimeType: string | undefined;
    try {
      const metaPath = `${blobPath}.meta.json`;
      const metaStr = await fsPromises.readFile(metaPath, "utf-8");
      const meta = JSON.parse(metaStr);
      mimeType = meta.mimeType;
    } catch {
      // No metadata file, that's ok
    }

    return { data, mimeType };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { data: null };
    }
    throw error;
  }
};

/**
 * Handle creature/storage/blob/delete
 */
export const handleBlobDelete = async (
  serverName: string,
  params: unknown
): Promise<{ deleted: boolean }> => {
  const { name } = BlobDeleteSchema.parse(params);
  const sanitizedName = sanitizeKey(name);

  const storageDir = getStorageDirForServer(serverName);
  const blobsDir = getBlobsDir(storageDir);
  const blobPath = path.join(blobsDir, sanitizedName);

  try {
    await fsPromises.unlink(blobPath);
    // Try to delete metadata too
    try {
      await fsPromises.unlink(`${blobPath}.meta.json`);
    } catch {
      // No metadata file, that's ok
    }
    return { deleted: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { deleted: false };
    }
    throw error;
  }
};

/**
 * Handle creature/storage/blob/list
 */
export const handleBlobList = async (
  serverName: string,
  params: unknown
): Promise<{ names: string[]; nextCursor: string | null }> => {
  const { prefix, cursor, limit } = BlobListSchema.parse(params);

  const storageDir = getStorageDirForServer(serverName);
  const blobsDir = getBlobsDir(storageDir);
  const listLimit = normalizeListLimit(limit);
  const sanitizedPrefix = prefix ? sanitizeKey(prefix) : undefined;
  const sanitizedCursor = cursor ? sanitizeKey(cursor) : undefined;

  try {
    const entries = await fsPromises.readdir(blobsDir, { recursive: true });
    let names = entries
      .filter((e) => typeof e === "string" && !e.endsWith(".meta.json"))
      .map((e) => (typeof e === "string" ? e : String(e)));

    if (sanitizedPrefix) {
      names = names.filter((n) => n.startsWith(sanitizedPrefix));
    }
    if (sanitizedCursor) {
      names = names.filter((n) => n > sanitizedCursor);
    }

    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const page = names.slice(0, listLimit + 1);
    const hasMore = page.length > listLimit;
    const pagedNames = hasMore ? page.slice(0, listLimit) : page;

    return {
      names: pagedNames,
      nextCursor: hasMore ? pagedNames[pagedNames.length - 1] ?? null : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { names: [], nextCursor: null };
    }
    throw error;
  }
};

// =============================================================================
// Handler Dispatch
// =============================================================================

/**
 * Dispatch a storage method call.
 * Returns the result or throws on error.
 */
export const dispatchStorageMethod = async (
  method: string,
  serverName: string,
  params: unknown
): Promise<unknown> => {
  switch (method) {
    case STORAGE_METHODS.KV_GET:
      return handleKvGet(serverName, params);
    case STORAGE_METHODS.KV_SET:
      return handleKvSet(serverName, params);
    case STORAGE_METHODS.KV_DELETE:
      return handleKvDelete(serverName, params);
    case STORAGE_METHODS.KV_LIST:
      return handleKvList(serverName, params);
    case STORAGE_METHODS.KV_LIST_WITH_VALUES:
      return handleKvListWithValues(serverName, params);
    case STORAGE_METHODS.KV_SEARCH:
      return handleKvSearch(serverName, params);
    case STORAGE_METHODS.VECTOR_UPSERT:
      return handleVectorUpsert(serverName, params);
    case STORAGE_METHODS.VECTOR_SEARCH:
      return handleVectorSearch(serverName, params);
    case STORAGE_METHODS.VECTOR_DELETE:
      return handleVectorDelete(serverName, params);
    case STORAGE_METHODS.BLOB_PUT:
      return handleBlobPut(serverName, params);
    case STORAGE_METHODS.BLOB_GET:
      return handleBlobGet(serverName, params);
    case STORAGE_METHODS.BLOB_DELETE:
      return handleBlobDelete(serverName, params);
    case STORAGE_METHODS.BLOB_LIST:
      return handleBlobList(serverName, params);
    default:
      throw new Error(`Unknown storage method: ${method}`);
  }
};

/**
 * Check if a method is a Creature storage method.
 */
export const isStorageMethod = (method: string): boolean => {
  return method.startsWith("creature/storage/");
};

// =============================================================================
// Capability Advertisement
// =============================================================================

/**
 * Creature storage capabilities to advertise during MCP initialize.
 */
export const CREATURE_STORAGE_CAPABILITIES = {
  creatureStorage: {
    kv: true,
    kvSearch: true,
    blobs: true,
    maxBlobBytes: MAX_BLOB_SIZE,
    vector: {
      enabled: true,
      provider: "openai",
      maxTextLength: 20000,
      maxResults: 100,
    },
    pagination: {
      defaultLimit: DEFAULT_LIST_LIMIT,
      maxLimit: MAX_LIST_LIMIT,
      cursor: "lexicographic",
    },
  },
};
