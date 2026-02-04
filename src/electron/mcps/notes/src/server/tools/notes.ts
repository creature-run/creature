/**
 * Notes Tools
 *
 * Separate tools for each note operation:
 * - notes_list: Show list of all notes (has UI, returns summaries without content)
 * - notes_create: Create new note and open editor (has UI, always new pip)
 * - notes_open: Open existing note in editor (has UI, returns full note with content)
 * - notes_save: Update existing note (routes to existing pip, returns minimal data)
 * - notes_delete: Remove a note (no UI)
 * - notes_search: Full-text search across notes (no UI, returns snippets)
 *
 * View Routing (via views on resource):
 * - "/" → notes_list (single instance for root)
 * - "/editor" → notes_create (always creates new pip)
 * - "/editor/:noteId" → notes_open, notes_save, notes_delete (one per noteId)
 */

import { z } from "zod";
import type { App } from "open-mcp-app/server";
import type { DataStore } from "../lib/data.js";
import {
  NOTES_UI_URI,
  type Note,
  type NoteSummary,
  type NoteInstanceState,
  type ToolContext,
  type ToolResult,
} from "../lib/types.js";
import { generateNoteId, getAllNotes, searchNotes, withStore } from "../lib/utils.js";
import type { SearchResult } from "../lib/data.js";

// =============================================================================
// Input Schemas
// =============================================================================

const NotesListSchema = z.object({});

const NotesCreateSchema = z.object({
  title: z.string().optional().describe("Initial title for the note"),
  content: z.string().optional().describe("Initial content (markdown). Do NOT include the title in the content - it is stored and displayed separately."),
});

const NotesOpenSchema = z.object({
  noteId: z.string().describe("The ID of the note to open"),
});

const NotesSaveSchema = z.object({
  noteId: z.string().describe("The ID of the note to save"),
  title: z.string().describe("The note title"),
  content: z.string().describe("The note content (markdown). Do NOT include the title in the content - it is stored and displayed separately."),
});

const NotesDeleteSchema = z.object({
  noteId: z.string().describe("The ID of the note to delete"),
});

const NotesSearchSchema = z.object({
  query: z.string().describe("Search query to find matching notes"),
  limit: z.number().optional().describe("Maximum number of results (default 20)"),
});

// =============================================================================
// Tool Handlers
// =============================================================================

/**
 * List all notes.
 * Returns summaries without content to minimize payload.
 */
const handleList = async (
  store: DataStore<Note>,
  setState: ToolContext["setState"]
): Promise<ToolResult> => {
  const allNotes = await getAllNotes(store);

  setState<NoteInstanceState>({ view: "list" });

  // Return summaries only (no content field) to minimize payload
  const summaries: NoteSummary[] = allNotes.map((n) => ({
    id: n.id,
    title: n.title,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  }));

  if (allNotes.length === 0) {
    return {
      data: { notes: [], view: "list" },
      text: "No notes yet. Use notes_create to make one.",
      title: "All Notes",
    };
  }

  const summary = allNotes.map((n) => `- ${n.title} (${n.id})`).join("\n");

  return {
    data: { notes: summaries, view: "list" },
    text: `${allNotes.length} note(s):\n${summary}`,
    title: "All Notes",
  };
};

/**
 * Create a new note.
 * Opens a new editor pip with the created note.
 * Returns minimal data (no content in response to minimize payload).
 */
const handleCreate = async (
  { title, content }: z.infer<typeof NotesCreateSchema>,
  store: DataStore<Note>,
  setState: ToolContext["setState"]
): Promise<ToolResult> => {
  const note: Note = {
    id: generateNoteId(),
    title: title || "Untitled",
    content: content || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await store.set(note.id, note);

  setState<NoteInstanceState>({ noteId: note.id, view: "editor" });

  // Return full note for UI (needed to populate editor), but text response is minimal
  return {
    data: { note, view: "editor" },
    title: note.title,
    text: `Created note: ${note.title} (${note.id})`,
  };
};

/**
 * Open an existing note.
 * Creates a new window only if the note isn't already open.
 */
const handleOpen = async (
  { noteId }: z.infer<typeof NotesOpenSchema>,
  store: DataStore<Note>,
  setState: ToolContext["setState"]
): Promise<ToolResult> => {
  const note = await store.get(noteId);
  if (!note) {
    return {
      data: { error: "Note not found" },
      text: "Note not found",
      isError: true,
    };
  }

  setState<NoteInstanceState>({ noteId: note.id, view: "editor" });

  return {
    data: { note, view: "editor" },
    title: note.title,
    text: `Opened note: ${note.title}`,
  };
};

/**
 * Save changes to a note.
 * Routes result to existing editor pip for that noteId.
 * Returns minimal data in text response to minimize payload.
 */
const handleSave = async (
  { noteId, title, content }: z.infer<typeof NotesSaveSchema>,
  store: DataStore<Note>
): Promise<ToolResult> => {
  const note = await store.get(noteId);
  if (!note) {
    return {
      data: { error: "Note not found" },
      text: "Note not found",
      isError: true,
    };
  }

  note.title = title;
  note.content = content;
  note.updatedAt = new Date().toISOString();
  await store.set(noteId, note);

  // Return only summary info in data to minimize payload
  return {
    data: {
      note: { id: note.id, title: note.title, updatedAt: note.updatedAt },
      view: "editor"
    },
    title: note.title,
    text: `Saved note: ${note.title} (${note.id})`,
  };
};

/**
 * Delete a note.
 * Does NOT open or change windows.
 */
const handleDelete = async (
  { noteId }: z.infer<typeof NotesDeleteSchema>,
  store: DataStore<Note>
): Promise<ToolResult> => {
  const note = await store.get(noteId);
  if (!note) {
    return {
      data: { error: "Note not found" },
      text: "Note not found",
      isError: true,
    };
  }

  const title = note.title;
  await store.delete(noteId);

  return {
    data: { success: true, deletedId: noteId, title },
    text: `Deleted note: ${title}`,
  };
};

/**
 * Search notes using full-text search.
 * Returns matching notes with snippets (no full content to minimize payload).
 */
const handleSearch = async (
  query: string,
  limit: number | undefined,
  store: DataStore<Note>
): Promise<ToolResult> => {
  const results = await searchNotes(store, query, limit ?? 20);

  if (results.length === 0) {
    return {
      data: { query, matches: [] },
      text: `No notes found matching "${query}"`,
    };
  }

  // Format results with snippets (no content field for payload efficiency)
  const matches = results.map((r: SearchResult<Note>) => ({
    id: r.item.id,
    title: r.item.title,
    snippet: r.snippet,
    score: r.score,
  }));

  return {
    data: { query, matches },
    text: `Found ${results.length} note(s) matching "${query}":\n${matches.map(m => `- ${m.title} (${m.id})`).join("\n")}`,
  };
};

// =============================================================================
// Tool Registration
// =============================================================================

/**
 * Register all notes tools.
 *
 * Pip routing is handled by the views config on the resource. The control plane
 * finds the correct pip by matching path parameters (e.g., noteId) from tool args.
 */
export const registerNotesTools = (app: App) => {
  /**
   * List all notes in a searchable view.
   * Uses singleton instance - only one list view at a time.
   */
  app.tool(
    "notes_list",
    {
      description: "Show all notes in a searchable list view",
      input: NotesListSchema,
      ui: NOTES_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (_input: z.infer<typeof NotesListSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleList(store, context.setState));
    }
  );

  /**
   * Create a new note.
   * Opens a new editor pip with the created note.
   */
  app.tool(
    "notes_create",
    {
      description: "Create a new note and open it in an editor",
      input: NotesCreateSchema,
      ui: NOTES_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof NotesCreateSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleCreate(input, store, context.setState));
    }
  );

  /**
   * Open an existing note.
   * Opens in a new editor window.
   */
  app.tool(
    "notes_open",
    {
      description: "Open an existing note in an editor",
      input: NotesOpenSchema,
      ui: NOTES_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof NotesOpenSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleOpen(input, store, context.setState));
    }
  );

  /**
   * Save changes to a note.
   * Routes result to existing editor pip for that noteId.
   */
  app.tool(
    "notes_save",
    {
      description: "Save changes to an existing note",
      input: NotesSaveSchema,
      ui: NOTES_UI_URI,
      visibility: ["model", "app"],
    },
    async (input: z.infer<typeof NotesSaveSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleSave(input, store));
    }
  );

  /**
   * Delete a note.
   * No UI - doesn't open or change windows.
   */
  app.tool(
    "notes_delete",
    {
      description: "Delete a note",
      input: NotesDeleteSchema,
      visibility: ["model", "app"],
    },
    async (input: z.infer<typeof NotesDeleteSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleDelete(input, store));
    }
  );

  /**
   * Search notes using full-text search.
   */
  app.tool(
    "notes_search",
    {
      description: "Search notes using full-text search. Finds notes containing the search query and returns matching snippets with relevance scores.",
      input: NotesSearchSchema,
      visibility: ["model", "app"],
    },
    async (input: z.infer<typeof NotesSearchSchema>, context: ToolContext) => {
      return withStore(context, async (store) => handleSearch(input.query, input.limit, store));
    }
  );
};
