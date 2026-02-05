/**
 * Tool Utilities
 *
 * Shared helper functions used by note tools.
 * Handles ID generation and store creation.
 *
 * Notes are stored globally within a project and persist across sessions.
 */

import { createDataStore, type DataStore, type SearchResult } from "./data.js";
import type { Note, ToolContext, ToolResult } from "./types.js";

// =============================================================================
// ID Generation
// =============================================================================

/**
 * Generate a unique note ID.
 * Format: note_<timestamp>_<random>
 */
export const generateNoteId = () =>
  `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

// =============================================================================
// Data Helpers
// =============================================================================

/**
 * Get all notes from a store, sorted by most recently updated.
 */
export const getAllNotes = async (store: DataStore<Note>): Promise<Note[]> => {
  const all = await store.list();
  return all.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
};

/**
 * Search notes using full-text search.
 * Returns matching notes with optional snippets showing matched context.
 */
export const searchNotes = async (
  store: DataStore<Note>,
  query: string,
  limit?: number
): Promise<SearchResult<Note>[]> => {
  return store.search(query, limit);
};

// =============================================================================
// Store Creation
// =============================================================================

/**
 * Shared localId for all note instances.
 * Notes are shared across all instances since they're user data,
 * not instance-specific data.
 */
const SHARED_LOCAL_ID = "shared";

/**
 * Create a note store with shared scope.
 * All instances share the same notes data.
 */
export const createNoteStore = (): DataStore<Note> => {
  return createDataStore<Note>({
    collection: "notes",
    localId: SHARED_LOCAL_ID,
  });
};

/**
 * Wrap tool handlers with store creation.
 * Creates a shared store for all note operations.
 */
export const withStore = async (
  _context: ToolContext,
  handler: (store: DataStore<Note>) => Promise<ToolResult>
): Promise<ToolResult> => {
  const store = createNoteStore();
  return handler(store);
};
