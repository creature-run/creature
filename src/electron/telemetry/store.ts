/**
 * Telemetry Queue Store
 *
 * SQLite-backed durable queue for telemetry events.
 * Ensures events are not lost if the app crashes or network is unavailable.
 */

import { app } from "electron";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { QueuedEvent } from "./types";

/** Cached database connection */
let db: DatabaseSync | null = null;

/**
 * Get the telemetry storage directory.
 */
const getTelemetryDir = (): string => {
  const dir = path.join(app.getPath("userData"), "telemetry");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

/**
 * Get or create the database connection.
 */
const getDb = (): DatabaseSync => {
  if (db) {
    return db;
  }

  const dbPath = path.join(getTelemetryDir(), "queue.sqlite");
  db = new DatabaseSync(dbPath);

  // Enable WAL mode for better performance
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  // Create the queue table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ts INTEGER NOT NULL,
      props TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  return db;
};

/**
 * Enqueue a telemetry event.
 *
 * @param name - Event name
 * @param ts - Event timestamp (milliseconds)
 * @param props - Optional event properties (will be JSON-stringified)
 */
export const enqueue = (
  name: string,
  ts: number,
  props?: Record<string, unknown>
): void => {
  const database = getDb();
  const stmt = database.prepare(
    "INSERT INTO event_queue (name, ts, props) VALUES (?, ?, ?)"
  );
  stmt.run(name, ts, props ? JSON.stringify(props) : null);
};

/**
 * Peek at events in the queue without removing them.
 *
 * @param limit - Maximum number of events to return
 * @returns Array of queued events with their IDs
 */
export const peek = (limit: number): QueuedEvent[] => {
  const database = getDb();
  const stmt = database.prepare(
    "SELECT id, name, ts, props FROM event_queue ORDER BY id ASC LIMIT ?"
  );
  const rows = stmt.all(limit) as QueuedEvent[];
  return rows;
};

/**
 * Remove events from the queue by ID.
 *
 * @param ids - Array of event IDs to remove
 * @returns Number of events removed
 */
export const remove = (ids: number[]): number => {
  if (ids.length === 0) {
    return 0;
  }

  const database = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const stmt = database.prepare(
    `DELETE FROM event_queue WHERE id IN (${placeholders})`
  );
  const result = stmt.run(...ids);
  return result.changes;
};

/**
 * Get the current queue size.
 */
export const size = (): number => {
  const database = getDb();
  const stmt = database.prepare("SELECT COUNT(*) as count FROM event_queue");
  const row = stmt.get() as { count: number };
  return row.count;
};

/**
 * Clear all events from the queue.
 * Used for testing or emergency cleanup.
 */
export const clear = (): void => {
  const database = getDb();
  database.exec("DELETE FROM event_queue");
};

/**
 * Close the database connection.
 * Should be called on app quit.
 */
export const close = (): void => {
  if (db) {
    db.close();
    db = null;
  }
};
