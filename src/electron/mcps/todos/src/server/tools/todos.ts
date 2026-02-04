/**
 * Todos Tools
 *
 * Separate tools for each todo operation. All tools route to the same UI.
 * Batch tools support multiple items per call.
 *
 * Tools:
 * - todos_list: Show all todos in interactive list (returns summaries without notes)
 * - todos_get: Get a single todo with full details including notes
 * - todos_add: Create one or more todo items (text max 250 chars, optional notes)
 * - todos_toggle: Toggle completed status (sets/clears completedAt timestamp)
 * - todos_update: Edit a todo's text and/or notes
 * - todos_remove: Delete one or more todo items
 * - todos_search: Full-text search across todos (uses SQLite FTS5)
 *
 * Todos are stored globally within a project and persist across sessions.
 */

import { z } from "zod";
import type { App } from "open-mcp-app/server";
import type { DataStore } from "../lib/data.js";
import {
  TODOS_UI_URI,
  type Todo,
  type TodoSummary,
  type ToolContext,
  type ToolResult,
} from "../lib/types.js";
import {
  generateTodoId,
  getAllTodos,
  getTodoCounts,
  searchTodos,
  withStore,
} from "../lib/utils.js";
import type { SearchResult } from "../lib/data.js";

// =============================================================================
// Constants
// =============================================================================

const MAX_TEXT_LENGTH = 250;

// =============================================================================
// Input Schemas
// =============================================================================

const TodosListSchema = z.object({});

const TodosGetSchema = z.object({
  id: z.string().describe("The ID of the todo to retrieve"),
});

const TodosOpenSchema = z.object({
  id: z.string().describe("The ID of the todo to open in detail view"),
});

const TodoItemSchema = z.object({
  text: z.string().max(MAX_TEXT_LENGTH).describe(`Short task description (max ${MAX_TEXT_LENGTH} characters)`),
  notes: z.string().optional().describe("Optional longer description or notes"),
});

const TodosAddSchema = z.object({
  items: z.array(TodoItemSchema).describe("Array of todo items to add, each with text (max 250 chars) and optional notes"),
});

const TodosToggleSchema = z.object({
  ids: z.array(z.string()).describe("Array of todo IDs to toggle"),
});

const TodosUpdateSchema = z.object({
  id: z.string().describe("The ID of the todo to update"),
  text: z.string().max(MAX_TEXT_LENGTH).optional().describe(`New task description (max ${MAX_TEXT_LENGTH} characters)`),
  notes: z.string().optional().describe("New notes content (set to empty string to clear)"),
});

const TodosRemoveSchema = z.object({
  ids: z.array(z.string()).describe("Array of todo IDs to remove"),
});

const TodosSearchSchema = z.object({
  query: z.string().describe("Search query to find matching todos"),
  limit: z.number().optional().describe("Maximum number of results (default 20)"),
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert a full Todo to a TodoSummary (excludes notes field).
 */
const toSummary = (todo: Todo): TodoSummary => ({
  id: todo.id,
  text: todo.text,
  completed: todo.completed,
  createdAt: todo.createdAt,
  updatedAt: todo.updatedAt,
  ...(todo.completedAt && { completedAt: todo.completedAt }),
});

// =============================================================================
// Tool Handlers
// =============================================================================

/**
 * List all todos (returns summaries without notes to minimize payload).
 */
const handleList = async (store: DataStore<Todo>): Promise<ToolResult> => {
  const todos = await getAllTodos(store);
  const { total, open } = getTodoCounts(todos);

  if (total === 0) {
    return {
      data: { todos: [] },
      title: "Todos (0)",
      text: "No todos yet. Use todos_add to create one.",
    };
  }

  // Return summaries only (no notes field) to minimize payload
  const summaries = todos.map(toSummary);

  return {
    data: { todos: summaries },
    title: `Todos (${open})`,
    text: `${total} todo(s), ${open} remaining`,
  };
};

/**
 * Get a single todo with full details (including notes).
 * Does NOT open UI - just returns data.
 */
const handleGet = async (
  id: string,
  store: DataStore<Todo>
): Promise<ToolResult> => {
  const todo = await store.get(id);

  if (!todo) {
    return {
      data: { error: "Todo not found" },
      text: `Todo not found: ${id}`,
      isError: true,
    };
  }

  return {
    data: { todo, view: "detail" },
    text: `Todo: ${todo.text}${todo.notes ? " (has notes)" : ""}`,
  };
};

/**
 * Open a todo in detail view for editing notes.
 * Opens the detail view UI.
 */
const handleOpen = async (
  id: string,
  store: DataStore<Todo>
): Promise<ToolResult> => {
  const todo = await store.get(id);

  if (!todo) {
    return {
      data: { error: "Todo not found" },
      text: `Todo not found: ${id}`,
      isError: true,
    };
  }

  return {
    data: { todo, view: "detail" },
    title: todo.text,
    text: `Opened todo: ${todo.text}`,
  };
};

/**
 * Add one or more todo items.
 */
const handleAdd = async (
  items: z.infer<typeof TodoItemSchema>[],
  store: DataStore<Todo>
): Promise<ToolResult> => {
  const now = new Date().toISOString();
  const addedTodos: TodoSummary[] = [];

  for (const item of items) {
    const todo: Todo = {
      id: generateTodoId(),
      text: item.text,
      ...(item.notes && { notes: item.notes }),
      completed: false,
      createdAt: now,
      updatedAt: now,
    };
    await store.set(todo.id, todo);
    // Return summary only (no notes) for payload efficiency
    addedTodos.push(toSummary(todo));
  }

  const todos = await getAllTodos(store);
  const summaries = todos.map(toSummary);
  const { open } = getTodoCounts(todos);

  const itemCount = addedTodos.length;
  const textSummary = itemCount === 1
    ? `Added todo: ${addedTodos[0].text}`
    : `Added ${itemCount} todos`;

  return {
    data: { success: true, added: addedTodos, todos: summaries },
    text: textSummary,
    title: `Todos (${open})`,
  };
};

/**
 * Toggle one or more todos' completed status.
 * Sets completedAt when completing, clears it when uncompleting.
 */
const handleToggle = async (
  ids: string[],
  store: DataStore<Todo>
): Promise<ToolResult> => {
  const now = new Date().toISOString();
  const toggled: TodoSummary[] = [];
  const notFound: string[] = [];

  for (const id of ids) {
    const todo = await store.get(id);
    if (!todo) {
      notFound.push(id);
      continue;
    }

    todo.completed = !todo.completed;
    todo.updatedAt = now;

    // Set or clear completedAt based on new status
    if (todo.completed) {
      todo.completedAt = now;
    } else {
      delete todo.completedAt;
    }

    await store.set(id, todo);
    toggled.push(toSummary(todo));
  }

  if (toggled.length === 0 && notFound.length > 0) {
    return {
      data: { error: "No todos found", notFound },
      text: `No todos found for IDs: ${notFound.join(", ")}`,
      isError: true,
    };
  }

  const todos = await getAllTodos(store);
  const summaries = todos.map(toSummary);
  const { open } = getTodoCounts(todos);

  let textSummary: string;
  if (toggled.length === 1) {
    const status = toggled[0].completed ? "completed" : "uncompleted";
    textSummary = `Marked "${toggled[0].text}" as ${status}`;
  } else {
    textSummary = `Toggled ${toggled.length} todos`;
  }

  if (notFound.length > 0) {
    textSummary += ` (${notFound.length} not found)`;
  }

  return {
    data: { success: true, toggled, notFound, todos: summaries },
    text: textSummary,
    title: `Todos (${open})`,
  };
};

/**
 * Update a todo's text and/or notes.
 */
const handleUpdate = async (
  { id, text, notes }: z.infer<typeof TodosUpdateSchema>,
  store: DataStore<Todo>
): Promise<ToolResult> => {
  const todo = await store.get(id);
  if (!todo) {
    return {
      data: { error: "Todo not found" },
      text: `Todo not found: ${id}`,
      isError: true,
    };
  }

  const now = new Date().toISOString();

  if (text !== undefined) {
    todo.text = text;
  }

  if (notes !== undefined) {
    if (notes === "") {
      delete todo.notes;
    } else {
      todo.notes = notes;
    }
  }

  todo.updatedAt = now;
  await store.set(id, todo);

  const todos = await getAllTodos(store);
  const summaries = todos.map(toSummary);
  const { open } = getTodoCounts(todos);

  return {
    data: { 
      success: true, 
      updated: toSummary(todo), 
      todo: todo, // Return full todo with notes for editor
      todos: summaries, 
      view: "detail" 
    },
    text: `Updated todo: ${todo.text}`,
    title: `Todos (${open})`,
  };
};

/**
 * Remove one or more todo items.
 */
const handleRemove = async (
  ids: string[],
  store: DataStore<Todo>
): Promise<ToolResult> => {
  const deleted: { id: string; text: string }[] = [];
  const notFound: string[] = [];

  for (const id of ids) {
    const todo = await store.get(id);
    if (!todo) {
      notFound.push(id);
      continue;
    }

    deleted.push({ id, text: todo.text });
    await store.delete(id);
  }

  if (deleted.length === 0 && notFound.length > 0) {
    return {
      data: { error: "No todos found", notFound },
      text: `No todos found for IDs: ${notFound.join(", ")}`,
      isError: true,
    };
  }

  const todos = await getAllTodos(store);
  const summaries = todos.map(toSummary);
  const { open } = getTodoCounts(todos);

  let textSummary: string;
  if (deleted.length === 1) {
    textSummary = `Removed todo: ${deleted[0].text}`;
  } else {
    textSummary = `Removed ${deleted.length} todos`;
  }

  if (notFound.length > 0) {
    textSummary += ` (${notFound.length} not found)`;
  }

  return {
    data: { success: true, deleted, notFound, todos: summaries },
    text: textSummary,
    title: `Todos (${open})`,
  };
};

/**
 * Search todos using full-text search.
 */
const handleSearch = async (
  query: string,
  limit: number | undefined,
  store: DataStore<Todo>
): Promise<ToolResult> => {
  const results = await searchTodos(store, query, limit ?? 20);

  if (results.length === 0) {
    return {
      data: { query, matches: [] },
      text: `No todos found matching "${query}"`,
    };
  }

  // Format results with snippets (no notes field for payload efficiency)
  const matches = results.map((r: SearchResult<Todo>) => ({
    id: r.item.id,
    text: r.item.text,
    completed: r.item.completed,
    snippet: r.snippet,
    score: r.score,
  }));

  // Get full todo list for display (summaries only)
  const todos = await getAllTodos(store);
  const summaries = todos.map(toSummary);
  const { open } = getTodoCounts(todos);

  return {
    data: { query, matches, todos: summaries },
    text: `Found ${results.length} todo(s) matching "${query}"`,
    title: `Todos (${open})`,
  };
};

// =============================================================================
// Tool Registration
// =============================================================================

/**
 * Register all todos tools.
 *
 * Separate tools for each operation. Results are routed to the pip
 * for UI updates.
 */
export const registerTodosTools = (app: App) => {
  // List todos
  app.tool(
    "todos_list",
    {
      description: "List all todos and display them in the interactive todo list UI. Returns summaries without notes field for efficiency.",
      input: TodosListSchema,
      ui: TODOS_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (_input: z.infer<typeof TodosListSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleList(store));
    }
  );

  // Get a single todo with full details (no UI)
  app.tool(
    "todos_get",
    {
      description: "Get a single todo with full details including notes. Does not open UI.",
      input: TodosGetSchema,
      visibility: ["model", "app"],
    },
    async (input: z.infer<typeof TodosGetSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleGet(input.id, store));
    }
  );

  // Open a todo in detail view
  app.tool(
    "todos_open",
    {
      description: "Open a todo in detail view for viewing and editing notes. Opens the detail UI.",
      input: TodosOpenSchema,
      ui: TODOS_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof TodosOpenSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleOpen(input.id, store));
    }
  );

  // Add todos
  app.tool(
    "todos_add",
    {
      description: `Add one or more todo items. Each item has a text field (max ${MAX_TEXT_LENGTH} chars) and an optional notes field for longer descriptions.`,
      input: TodosAddSchema,
      ui: TODOS_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof TodosAddSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleAdd(input.items, store));
    }
  );

  // Toggle todos
  app.tool(
    "todos_toggle",
    {
      description: "Toggle one or more todos' completed status. Sets completedAt timestamp when completing, clears it when uncompleting.",
      input: TodosToggleSchema,
      ui: TODOS_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof TodosToggleSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleToggle(input.ids, store));
    }
  );

  // Update todo
  app.tool(
    "todos_update",
    {
      description: `Update a todo's text (max ${MAX_TEXT_LENGTH} chars) and/or notes. Set notes to empty string to clear it.`,
      input: TodosUpdateSchema,
      ui: TODOS_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof TodosUpdateSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleUpdate(input, store));
    }
  );

  // Remove todos
  app.tool(
    "todos_remove",
    {
      description: "Remove one or more todo items from the list",
      input: TodosRemoveSchema,
      ui: TODOS_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof TodosRemoveSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleRemove(input.ids, store));
    }
  );

  // Search todos (full-text search)
  app.tool(
    "todos_search",
    {
      description: "Search todos using full-text search. Finds todos containing the search query and returns matching snippets with relevance scores.",
      input: TodosSearchSchema,
      ui: TODOS_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof TodosSearchSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleSearch(input.query, input.limit, store));
    }
  );
};
