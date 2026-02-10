/**
 * SQLite-backed KV Store with Full-Text Search
 *
 * Provides a key-value store backed by SQLite with FTS5 for full-text search.
 * Uses Node's built-in node:sqlite module (available in Node 22+).
 *
 * Schema:
 *   kv(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)
 *   kv_fts(key, value) USING fts5 - virtual table for full-text search
 */

import { DatabaseSync, StatementSync } from "node:sqlite";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface KvSearchResult {
  key: string;
  snippet?: string;
  score?: number;
}

export interface KvSearchOptions {
  prefix?: string;
  limit?: number;
}

export interface KvListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface KvListResult {
  keys: string[];
  nextCursor: string | null;
}

export interface KvListWithValuesResult {
  entries: Array<{ key: string; value: string }>;
  nextCursor: string | null;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

const normalizeListLimit = (limit?: number): number => {
  if (!Number.isInteger(limit)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);
};

// =============================================================================
// Database Management
// =============================================================================

/** Cache of open database connections per storage directory */
const dbCache = new Map<string, DatabaseSync>();

/**
 * Get or create a database connection for the given storage directory.
 */
const getDb = (storageDir: string): DatabaseSync => {
  const cached = dbCache.get(storageDir);
  if (cached) {
    return cached;
  }

  // Ensure directory exists
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  const dbPath = path.join(storageDir, "kv.sqlite");
  const db = new DatabaseSync(dbPath);

  // Enable WAL mode for better concurrent access
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Create FTS5 virtual table for full-text search
  // Using external content mode to avoid data duplication
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS kv_fts USING fts5(
      key,
      value,
      content='kv',
      content_rowid='rowid'
    )
  `);

  // Create triggers to keep FTS index in sync with main table
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS kv_ai AFTER INSERT ON kv BEGIN
      INSERT INTO kv_fts(rowid, key, value) VALUES (NEW.rowid, NEW.key, NEW.value);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS kv_ad AFTER DELETE ON kv BEGIN
      INSERT INTO kv_fts(kv_fts, rowid, key, value) VALUES ('delete', OLD.rowid, OLD.key, OLD.value);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS kv_au AFTER UPDATE ON kv BEGIN
      INSERT INTO kv_fts(kv_fts, rowid, key, value) VALUES ('delete', OLD.rowid, OLD.key, OLD.value);
      INSERT INTO kv_fts(rowid, key, value) VALUES (NEW.rowid, NEW.key, NEW.value);
    END
  `);

  dbCache.set(storageDir, db);
  return db;
};

/**
 * Close a database connection and remove it from the cache.
 */
export const closeDb = (storageDir: string): void => {
  const db = dbCache.get(storageDir);
  if (db) {
    db.close();
    dbCache.delete(storageDir);
  }
};

/**
 * Close all open database connections.
 */
export const closeAllDbs = (): void => {
  for (const [storageDir, db] of dbCache) {
    db.close();
    dbCache.delete(storageDir);
  }
};

// =============================================================================
// Migration from kv.json
// =============================================================================

/**
 * Migrate existing kv.json data to SQLite.
 * Called on first access to a storage directory.
 */
export const migrateFromJson = async (storageDir: string): Promise<void> => {
  const jsonPath = path.join(storageDir, "kv.json");

  try {
    const data = await fsPromises.readFile(jsonPath, "utf-8");
    const store = JSON.parse(data) as Record<string, string>;

    const db = getDb(storageDir);
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch())"
    );

    // Use a transaction for atomicity
    db.exec("BEGIN TRANSACTION");
    try {
      for (const [key, value] of Object.entries(store)) {
        stmt.run(key, value);
      }
      db.exec("COMMIT");
      console.log(
        `[KV SQLite] Migrated ${Object.keys(store).length} keys from kv.json`
      );

      // Rename old file instead of deleting (for safety)
      const backupPath = path.join(storageDir, "kv.json.migrated");
      await fsPromises.rename(jsonPath, backupPath);
      console.log(`[KV SQLite] Renamed kv.json to kv.json.migrated`);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // No kv.json to migrate, that's fine
      return;
    }
    console.error("[KV SQLite] Migration failed:", error);
    throw error;
  }
};

/**
 * Ensure migration has been attempted for this storage directory.
 */
const migrationAttempted = new Set<string>();

const ensureMigration = async (storageDir: string): Promise<void> => {
  if (migrationAttempted.has(storageDir)) {
    return;
  }
  migrationAttempted.add(storageDir);
  await migrateFromJson(storageDir);
};

// =============================================================================
// KV Operations
// =============================================================================

/**
 * Get a value from the KV store.
 */
export const kvGet = async (
  storageDir: string,
  key: string
): Promise<string | null> => {
  await ensureMigration(storageDir);
  const db = getDb(storageDir);
  const stmt = db.prepare("SELECT value FROM kv WHERE key = ?");
  const row = stmt.get(key) as { value: string } | undefined;
  return row?.value ?? null;
};

/**
 * Set a value in the KV store.
 */
export const kvSet = async (
  storageDir: string,
  key: string,
  value: string
): Promise<void> => {
  await ensureMigration(storageDir);
  const db = getDb(storageDir);
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch())"
  );
  stmt.run(key, value);
};

/**
 * Delete a key from the KV store.
 * Returns true if the key existed.
 */
export const kvDelete = async (
  storageDir: string,
  key: string
): Promise<boolean> => {
  await ensureMigration(storageDir);
  const db = getDb(storageDir);
  const stmt = db.prepare("DELETE FROM kv WHERE key = ?");
  const result = stmt.run(key);
  return result.changes > 0;
};

/**
 * List keys in the KV store, optionally filtered by prefix.
 */
export const kvList = async (
  storageDir: string,
  options: KvListOptions = {}
): Promise<KvListResult> => {
  await ensureMigration(storageDir);
  const db = getDb(storageDir);
  const limit = normalizeListLimit(options.limit);
  const queryLimit = limit + 1;

  let stmt: StatementSync;
  let rows: Array<{ key: string }>;

  if (options.prefix && options.cursor) {
    const escapedPrefix = options.prefix.replace(/[%_]/g, "\\$&");
    stmt = db.prepare(
      "SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' AND key > ? ORDER BY key ASC LIMIT ?"
    );
    rows = stmt.all(`${escapedPrefix}%`, options.cursor, queryLimit) as Array<{ key: string }>;
  } else if (options.prefix) {
    // Use LIKE with escaped prefix for prefix matching
    const escapedPrefix = options.prefix.replace(/[%_]/g, "\\$&");
    stmt = db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key ASC LIMIT ?");
    rows = stmt.all(`${escapedPrefix}%`, queryLimit) as Array<{ key: string }>;
  } else if (options.cursor) {
    stmt = db.prepare("SELECT key FROM kv WHERE key > ? ORDER BY key ASC LIMIT ?");
    rows = stmt.all(options.cursor, queryLimit) as Array<{ key: string }>;
  } else {
    stmt = db.prepare("SELECT key FROM kv ORDER BY key ASC LIMIT ?");
    rows = stmt.all(queryLimit) as Array<{ key: string }>;
  }

  const hasMore = rows.length > limit;
  const keys = rows.slice(0, limit).map((r) => r.key);
  return {
    keys,
    nextCursor: hasMore ? keys[keys.length - 1] ?? null : null,
  };
};

/**
 * List key-value pairs in the KV store, optionally filtered by prefix.
 * Returns both keys and values in a single query to avoid N+1 lookups.
 */
export const kvListWithValues = async (
  storageDir: string,
  options: KvListOptions = {}
): Promise<KvListWithValuesResult> => {
  await ensureMigration(storageDir);
  const db = getDb(storageDir);
  const limit = normalizeListLimit(options.limit);
  const queryLimit = limit + 1;

  let stmt: StatementSync;
  let rows: Array<{ key: string; value: string }>;

  if (options.prefix && options.cursor) {
    const escapedPrefix = options.prefix.replace(/[%_]/g, "\\$&");
    stmt = db.prepare(
      "SELECT key, value FROM kv WHERE key LIKE ? ESCAPE '\\' AND key > ? ORDER BY key ASC LIMIT ?"
    );
    rows = stmt.all(`${escapedPrefix}%`, options.cursor, queryLimit) as Array<{
      key: string;
      value: string;
    }>;
  } else if (options.prefix) {
    const escapedPrefix = options.prefix.replace(/[%_]/g, "\\$&");
    stmt = db.prepare(
      "SELECT key, value FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key ASC LIMIT ?"
    );
    rows = stmt.all(`${escapedPrefix}%`, queryLimit) as Array<{ key: string; value: string }>;
  } else if (options.cursor) {
    stmt = db.prepare("SELECT key, value FROM kv WHERE key > ? ORDER BY key ASC LIMIT ?");
    rows = stmt.all(options.cursor, queryLimit) as Array<{ key: string; value: string }>;
  } else {
    stmt = db.prepare("SELECT key, value FROM kv ORDER BY key ASC LIMIT ?");
    rows = stmt.all(queryLimit) as Array<{ key: string; value: string }>;
  }

  const hasMore = rows.length > limit;
  const entries = rows.slice(0, limit);
  return {
    entries,
    nextCursor: hasMore ? entries[entries.length - 1]?.key ?? null : null,
  };
};

/**
 * Search values in the KV store using full-text search.
 * Uses SQLite FTS5 with BM25 ranking.
 */
export const kvSearch = async (
  storageDir: string,
  query: string,
  options: KvSearchOptions = {}
): Promise<KvSearchResult[]> => {
  await ensureMigration(storageDir);
  const db = getDb(storageDir);

  const limit = Math.min(options.limit ?? 50, 100); // Cap at 100

  // Escape special FTS5 characters and prepare query
  // FTS5 uses double quotes for phrase matching, so we escape them
  const safeQuery = query.replace(/"/g, '""');

  let sql: string;
  let params: (string | number)[];

  if (options.prefix) {
    // Filter by key prefix and search in value
    const escapedPrefix = options.prefix.replace(/[%_]/g, "\\$&");
    sql = `
      SELECT 
        kv.key,
        snippet(kv_fts, 1, '<mark>', '</mark>', '...', 32) as snippet,
        bm25(kv_fts) as score
      FROM kv_fts
      JOIN kv ON kv.rowid = kv_fts.rowid
      WHERE kv_fts MATCH ?
        AND kv.key LIKE ? ESCAPE '\\'
      ORDER BY score
      LIMIT ?
    `;
    params = [safeQuery, `${escapedPrefix}%`, limit];
  } else {
    sql = `
      SELECT 
        kv.key,
        snippet(kv_fts, 1, '<mark>', '</mark>', '...', 32) as snippet,
        bm25(kv_fts) as score
      FROM kv_fts
      JOIN kv ON kv.rowid = kv_fts.rowid
      WHERE kv_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `;
    params = [safeQuery, limit];
  }

  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      key: string;
      snippet: string;
      score: number;
    }>;

    return rows.map((r) => ({
      key: r.key,
      snippet: r.snippet,
      score: r.score,
    }));
  } catch (error) {
    // If the query is malformed for FTS5, return empty results
    // This can happen with certain special characters
    if (
      error instanceof Error &&
      error.message.includes("fts5: syntax error")
    ) {
      console.warn(`[KV SQLite] FTS5 syntax error for query "${query}":`, error);
      return [];
    }
    throw error;
  }
};

/**
 * Rebuild the FTS index (useful after bulk operations).
 */
export const rebuildFtsIndex = async (storageDir: string): Promise<void> => {
  await ensureMigration(storageDir);
  const db = getDb(storageDir);
  db.exec("INSERT INTO kv_fts(kv_fts) VALUES('rebuild')");
};
