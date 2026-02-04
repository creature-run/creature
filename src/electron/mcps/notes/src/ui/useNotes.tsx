/**
 * useNotes Hook
 *
 * Encapsulates all notes state management, tool calls, and side effects.
 * Separates data/logic concerns from rendering in NotesApp.
 *
 * Responsibilities:
 * - State management (note, notes, saving status)
 * - Tool call setup and execution
 * - Widget state persistence and restoration
 * - View routing via useViews hook
 *
 * View Routing:
 * Uses the useViews hook for automatic view management based on tool results.
 * Views are defined in the server config and automatically switch based on
 * which tool was called.
 */

import { useEffect, useCallback, useState, useRef, useMemo, createContext, useContext, type ReactNode } from "react";
import { useHost, useViews, type Views } from "open-mcp-app/react";
import type { MilkdownEditorRef } from "./MilkdownEditor";
import type { Note, NoteSummary, NoteData, NoteWidgetState, ViewType } from "./types";

/**
 * Views configuration matching server-side definition.
 */
const VIEWS: Views = {
  "/": ["notes_list"],
  "/editor": ["notes_create"],
  "/editor/:noteId": ["notes_open", "notes_save", "notes_delete"],
};

/**
 * Return type for the useNotes hook.
 * Provides everything needed to render the notes UI.
 */
export interface UseNotesReturn {
  /** Whether the hook is ready (host connected and initialized) */
  isReady: boolean;
  /** Current view mode */
  view: ViewType;
  /** Currently loaded note (for editor view) */
  note: Note | null;
  /** List of note summaries (for list view) */
  notes: NoteSummary[];
  /** Whether a save operation is in progress */
  isSaving: boolean;
  /** Timestamp of last successful save */
  lastSaved: Date | null;
  /** Ref to Milkdown editor for imperative updates */
  editorRef: React.RefObject<MilkdownEditorRef | null>;
  /** Update local draft state for the current note */
  updateDraft: (args: { noteId: string; title?: string; content?: string }) => void;
  /** Save a note with new title and content */
  saveNote: (noteId: string, title: string, content: string) => Promise<void>;
  /** Open a note by ID */
  openNote: (noteId: string) => Promise<void>;
  /** Create a new note */
  createNote: () => Promise<void>;
  /** Refresh the notes list (for polling) */
  refreshList: () => Promise<void>;
  /** Navigate back to the list view */
  goToList: () => Promise<void>;
}

/**
 * Convert view path to ViewType.
 * "/" -> "list", anything else -> "editor"
 */
const viewPathToViewType = (viewPath: string): ViewType => {
  return viewPath === "/" ? "list" : "editor";
};

/**
 * Custom hook for notes state management and tool interactions.
 *
 * Uses useViews for automatic view routing based on tool results.
 * View state is managed by the SDK - no manual view switching needed.
 */
export const useNotes = (): UseNotesReturn => {
  // Use views hook for automatic view routing
  const { view: viewPath, data: viewData, isInitialized } = useViews<NoteData>(VIEWS);

  // Derive ViewType from path
  const view = useMemo(() => viewPathToViewType(viewPath), [viewPath]);

  // Data state
  const [note, setNote] = useState<Note | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  // Refs
  const lastSavedContentRef = useRef<string | null>(null);
  const lastDraftContentRef = useRef<string | null>(null);
  const lastSaveSourceRef = useRef<"local" | null>(null);
  const lastOpenRefreshKeyRef = useRef<string | null>(null);
  const hasRestoredState = useRef(false);
  const editorRef = useRef<MilkdownEditorRef>(null);

  // Get host APIs from context
  const {
    callTool,
    isReady: hostReady,
    log,
    exp_widgetState,
    environment: hostEnvironment,
  } = useHost();

  // Combined ready state
  const isReady = hostReady && isInitialized;

  // Widget state for persistence
  const [widgetState, setWidgetState] = exp_widgetState<NoteWidgetState>();

  // Tool callers
  const [listTool] = callTool<NoteData>("notes_list");
  const [createTool] = callTool<NoteData>("notes_create");
  const [openTool] = callTool<NoteData>("notes_open");
  const [saveTool] = callTool<NoteData>("notes_save");

  // ===========================================================================
  // Data Processing (from useViews)
  // ===========================================================================

  /**
   * Process data from useViews when it changes.
   * Updates local state for notes list and current note.
   */
  useEffect(() => {
    if (!viewData) return;

    // List view data
    if (viewData.notes) {
      setNotes(viewData.notes);
      log.debug("Notes list updated", { count: viewData.notes.length });
    }

    // Editor view data
    if (viewData.note) {
      const noteData = viewData.note;
      const isNewNote = note?.id !== noteData.id;

      if (isNewNote) {
        setNote(noteData);
        lastSavedContentRef.current = noteData.content;
        lastDraftContentRef.current = noteData.content;
        log.debug("Note loaded", { id: noteData.id, title: noteData.title });
      } else {
        // Same note - check for external update
        const hasContent = noteData.content !== undefined;
        const isExternalUpdate = hasContent && noteData.content !== lastSavedContentRef.current;

        if (isExternalUpdate) {
          // External change - update editor
          setNote(noteData);
          editorRef.current?.setContent(noteData.content);
          lastSavedContentRef.current = noteData.content;
          lastDraftContentRef.current = noteData.content;
          log.debug("Note updated externally", { id: noteData.id });
        } else if (hasContent) {
          // Content present - use server data and update editor
          setNote(noteData);
          editorRef.current?.setContent(noteData.content);
          lastSavedContentRef.current = noteData.content;
          lastDraftContentRef.current = noteData.content;
        } else {
          // No content in response (e.g., save result) - preserve local content
          const fallbackContent = lastDraftContentRef.current ?? lastSavedContentRef.current ?? note?.content;
          setNote((prev) => prev ? { ...prev, ...noteData, content: fallbackContent ?? prev.content } : noteData);

          const refreshKey = noteData.updatedAt ? `${noteData.id}:${noteData.updatedAt}` : null;
          const shouldRefreshFromOpen = !lastSaveSourceRef.current
            && refreshKey
            && lastOpenRefreshKeyRef.current !== refreshKey;

          if (shouldRefreshFromOpen) {
            lastOpenRefreshKeyRef.current = refreshKey;
            openTool({ noteId: noteData.id })
              .then(() => {
                log.debug("Refreshed note content after external save", { id: noteData.id });
              })
              .catch((err) => {
                log.error("Failed to refresh note after external save", { error: String(err) });
              });
          }

          lastSaveSourceRef.current = null;
        }
      }
    }
  }, [viewData, note?.id, log, openTool]);

  // ===========================================================================
  // Action Callbacks
  // ===========================================================================

  /**
   * Save a note via tool call.
   */
  const saveNote = useCallback(
    async (noteId: string, newTitle: string, newContent: string) => {
      setIsSaving(true);
      lastSaveSourceRef.current = "local";
      lastSavedContentRef.current = newContent;
      lastDraftContentRef.current = newContent;
      try {
        await saveTool({
          noteId,
          title: newTitle,
          content: newContent,
        });
        setLastSaved(new Date());
        log.debug("Note saved", { noteId, title: newTitle });
      } catch (err) {
        log.error("Failed to save note", { error: String(err) });
      } finally {
        setIsSaving(false);
      }
    },
    [saveTool, log]
  );

  /**
   * Update local draft state while the user is editing.
   * Keeps editor state consistent when navigating between views before save.
   */
  const updateDraft = useCallback(
    ({ noteId, title, content }: { noteId: string; title?: string; content?: string }) => {
      if (content !== undefined) {
        lastDraftContentRef.current = content;
      }
      setNote((prev) => {
        if (!prev || prev.id !== noteId) return prev;
        return {
          ...prev,
          ...(title !== undefined ? { title } : {}),
          ...(content !== undefined ? { content } : {}),
        };
      });
    },
    []
  );

  /**
   * Open a note by ID via tool call.
   */
  const openNote = useCallback(
    async (noteId: string) => {
      try {
        await openTool({ noteId });
        log.debug("Opening note", { noteId });
      } catch (err) {
        log.error("Failed to open note", { error: String(err) });
      }
    },
    [openTool, log]
  );

  /**
   * Create a new note via tool call.
   */
  const createNote = useCallback(async () => {
    try {
      await createTool({});
      log.debug("Creating new note");
    } catch (err) {
      log.error("Failed to create note", { error: String(err) });
    }
  }, [createTool, log]);

  /**
   * Refresh the notes list (for polling).
   * Silent - no logging to keep console clean.
   * Only runs while in list view.
   */
  const refreshList = useCallback(async () => {
    if (view !== "list") {
      return;
    }
    try {
      await listTool({});
    } catch {
      // Silent failure for polling
    }
  }, [listTool, view]);

  /**
   * Navigate back to the list view.
   * Calls notes_list which triggers useViews to switch to "/" view.
   */
  const goToList = useCallback(async () => {
    try {
      await listTool({});
      log.debug("Navigating to list view");
    } catch (err) {
      log.error("Failed to navigate to list", { error: String(err) });
    }
  }, [listTool, log]);

  // ===========================================================================
  // Effects
  // ===========================================================================

  /**
   * Log connection on ready.
   */
  useEffect(() => {
    if (isReady) {
      log.info("Notes app connected", { environment: hostEnvironment });
    }
  }, [isReady, log, hostEnvironment]);

  /**
   * Fetch list on user-initiated open (when no initial data).
   */
  useEffect(() => {
    if (isReady && viewPath === "/" && !viewData?.notes && notes.length === 0) {
      listTool({});
    }
  }, [isReady, viewPath, viewData?.notes, notes.length, listTool]);

  /**
   * Restore from widget state on mount (before initialization completes).
   * Shows previous state immediately while fresh data loads.
   */
  useEffect(() => {
    if (hasRestoredState.current || !widgetState?.privateContent) {
      return;
    }
    hasRestoredState.current = true;

    const { lastNote, lastNotes } = widgetState.privateContent;

    if (lastNotes) {
      setNotes(lastNotes);
      log.debug("List restored from widget state");
    }
    if (lastNote) {
      setNote(lastNote);
      log.debug("Note restored from widget state", { id: lastNote.id });
    }
  }, [widgetState, log]);

  /**
   * Persist state to widget state for session continuity.
   */
  useEffect(() => {
    if (view === "list") {
      setWidgetState({
        modelContent: {
          view: "list",
          noteCount: notes.length,
        },
        privateContent: {
          lastNote: null,
          lastNotes: notes,
          lastView: "list",
        },
      });
    } else if (view === "editor" && note) {
      const wordCount = (note.content ?? "").trim().split(/\s+/).filter(Boolean).length;
      setWidgetState({
        modelContent: {
          view: "editor",
          noteId: note.id,
          noteTitle: note.title,
          wordCount,
        },
        privateContent: {
          lastNote: note,
          lastNotes: notes,
          lastView: "editor",
        },
      });
    }
  }, [view, viewPath, note, notes, setWidgetState]);

  return {
    isReady,
    view,
    note,
    notes,
    isSaving,
    lastSaved,
    editorRef,
    updateDraft,
    saveNote,
    openNote,
    createNote,
    refreshList,
    goToList,
  };
};

// =============================================================================
// Context
// =============================================================================

/**
 * Notes context for sharing state across components without prop drilling.
 * Provides all the state and actions from useNotes to any descendant component.
 */
const NotesContext = createContext<UseNotesReturn | null>(null);

/**
 * Provider component that wraps the app and provides notes state via context.
 * Must be used inside a HostProvider since useNotes depends on useHost.
 */
export function NotesProvider({ children }: { children: ReactNode }) {
  const notesState = useNotes();
  return (
    <NotesContext.Provider value={notesState}>
      {children}
    </NotesContext.Provider>
  );
}

/**
 * Hook to access notes state from context.
 * Must be used inside a NotesProvider.
 *
 * @throws Error if used outside NotesProvider
 */
export function useNotesContext(): UseNotesReturn {
  const context = useContext(NotesContext);
  if (!context) {
    throw new Error("useNotesContext must be used within a NotesProvider");
  }
  return context;
}
