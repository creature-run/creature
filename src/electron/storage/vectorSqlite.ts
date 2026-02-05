import { DatabaseSync, StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface VectorSearchResult {
  key: string;
  score: number;
  metadata?: unknown;
}

export interface VectorSearchOptions {
  prefix?: string;
  limit?: number;
}

const dbCache = new Map<string, DatabaseSync>();

const getDb = (storageDir: string): DatabaseSync => {
  const cached = dbCache.get(storageDir);
  if (cached) {
    return cached;
  }

  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  const dbPath = path.join(storageDir, "vector.sqlite");
  const db = new DatabaseSync(dbPath);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS vectors (
      key TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      dims INTEGER NOT NULL,
      metadata TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  dbCache.set(storageDir, db);
  return db;
};

const normalizeVector = (vector: Float32Array): Float32Array => {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i];
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error("Embedding vector has zero magnitude");
  }
  const normalized = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    normalized[i] = vector[i] / norm;
  }
  return normalized;
};

const toFloat32Array = (embedding: number[] | Float32Array): Float32Array => {
  if (embedding instanceof Float32Array) {
    return embedding;
  }
  return Float32Array.from(embedding);
};

const parseMetadata = (value: string | null): unknown | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const vectorUpsert = async (
  storageDir: string,
  key: string,
  embedding: number[] | Float32Array,
  metadata?: unknown
): Promise<void> => {
  const db = getDb(storageDir);
  const normalized = normalizeVector(toFloat32Array(embedding));
  const buffer = Buffer.from(
    normalized.buffer,
    normalized.byteOffset,
    normalized.byteLength
  );
  const metadataValue = metadata === undefined ? null : JSON.stringify(metadata);

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO vectors (key, embedding, dims, metadata, updated_at) VALUES (?, ?, ?, ?, unixepoch())"
  );
  stmt.run(key, buffer, normalized.length, metadataValue);
};

export const vectorDelete = async (storageDir: string, key: string): Promise<boolean> => {
  const db = getDb(storageDir);
  const stmt = db.prepare("DELETE FROM vectors WHERE key = ?");
  const result = stmt.run(key);
  return result.changes > 0;
};

export const vectorSearch = async (
  storageDir: string,
  embedding: number[] | Float32Array,
  options: VectorSearchOptions = {}
): Promise<VectorSearchResult[]> => {
  const db = getDb(storageDir);
  const normalized = normalizeVector(toFloat32Array(embedding));
  const limit = Math.min(options.limit ?? 50, 100);

  let stmt: StatementSync;
  let rows: Array<{ key: string; embedding: Buffer; dims: number; metadata: string | null }>;

  if (options.prefix) {
    const escapedPrefix = options.prefix.replace(/[%_]/g, "\\$&");
    stmt = db.prepare("SELECT key, embedding, dims, metadata FROM vectors WHERE key LIKE ? ESCAPE '\\'");
    rows = stmt.all(`${escapedPrefix}%`) as Array<{ key: string; embedding: Buffer; dims: number; metadata: string | null }>;
  } else {
    stmt = db.prepare("SELECT key, embedding, dims, metadata FROM vectors");
    rows = stmt.all() as Array<{ key: string; embedding: Buffer; dims: number; metadata: string | null }>;
  }

  const results: VectorSearchResult[] = [];

  for (const row of rows) {
    if (row.dims !== normalized.length) {
      continue;
    }
    const rowEmbedding = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4
    );
    let score = 0;
    for (let i = 0; i < normalized.length; i += 1) {
      score += normalized[i] * rowEmbedding[i];
    }
    results.push({
      key: row.key,
      score,
      metadata: parseMetadata(row.metadata),
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
};
