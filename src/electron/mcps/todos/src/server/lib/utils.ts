/**
 * Tool Utilities
 *
 * Shared helper functions used by todo tools.
 * Handles ID generation and store creation.
 *
 * Todos are stored globally within a project (not per-instance).
 */

import { createDataStore, type DataStore, type SearchResult } from "./data.js";
import type { Todo, ToolContext, ToolResult } from "./types.js";

// =============================================================================
// ID Generation
// =============================================================================

/**
 * Generate a unique todo ID.
 * Format: todo_<timestamp>_<random>
 */
export const generateTodoId = () =>
  `todo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

// =============================================================================
// Data Helpers
// =============================================================================

/**
 * Get all todos from a store, sorted by:
 * 1. Completion status (incomplete first)
 * 2. Creation date within each group (newest first)
 */
export const getAllTodos = async (store: DataStore<Todo>): Promise<Todo[]> => {
  const all = await store.list();
  return all.sort((a, b) => {
    // First: sort by completion status (incomplete first)
    if (a.completed !== b.completed) {
      return a.completed ? 1 : -1;
    }
    // Then: sort by creation date (newest first)
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
};

/**
 * Search todos using full-text search.
 * Returns matching todos with optional snippets showing matched context.
 */
export const searchTodos = async (
  store: DataStore<Todo>,
  query: string,
  limit?: number
): Promise<SearchResult<Todo>[]> => {
  return store.search(query, limit);
};

/**
 * Get summary counts for todos.
 */
export const getTodoCounts = (todos: Todo[]) => ({
  total: todos.length,
  open: todos.filter((t) => !t.completed).length,
  completed: todos.filter((t) => t.completed).length,
});

// =============================================================================
// Store Creation
// =============================================================================

/**
 * Create a todo store scoped by localId.
 */
export const createTodoStore = (localId: string): DataStore<Todo> => {
  return createDataStore<Todo>({
    collection: "todos",
    localId,
  });
};

/**
 * Wrap tool handlers with store creation.
 *
 * For todos (a singleton app), data is global - NOT scoped by instanceId.
 * All tool calls share the same data store so todos persist across calls.
 *
 * Multi-instance apps (like notes) would scope by instanceId for isolation.
 * 
 * For persistent storage (KV), we use "global" as the localId so todos
 * persist across sessions within the same project. The project-level
 * scoping is handled by the storage directory itself.
 * 
 * For in-memory storage (fallback), we also use "global" for consistency.
 * If per-instance isolation is needed in the future, this could be made
 * configurable.
 */
export const withStore = async (
  context: ToolContext,
  handler: (store: DataStore<Todo>) => Promise<ToolResult>
): Promise<ToolResult> => {
  // Use fixed "global" scope - todos is a singleton app
  // Use "global" for project-wide todos that persist across sessions.
  // The storage is already scoped by projectId + serverName at the directory level.
  const store = createTodoStore("global");
  return handler(store);
};
