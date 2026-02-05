import React, { useRef, useCallback } from "react";
import { useHost } from "open-mcp-app/react";
import MilkdownEditor from "./MilkdownEditor";
import { useNotesContext } from "./useNotes";

/**
 * EditorView Component
 *
 * Displays the note editor with title input and Milkdown WYSIWYG editor.
 * Uses context for state management - no props needed.
 *
 * Features:
 * - Auto-save on edit with debouncing
 * - Navigation back to list view
 * - Note deletion with confirmation
 */
export function EditorView() {
  const { updateModelContext } = useHost();
  const {
    note,
    isSaving,
    lastSaved,
    editorRef,
    updateDraft,
    saveNote,
    goToList,
    deleteNote,
  } = useNotesContext();

  const saveTimeoutRef = useRef<NodeJS.Timeout>();

  /**
   * Perform the actual save operation.
   */
  const performSave = useCallback(async () => {
    if (!note) return;
    await saveNote(note.id, note.title.trim() || "Untitled", note.content);
  }, [note, saveNote]);

  /**
   * Debounced save - triggers after 500ms of inactivity.
   */
  const debouncedSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(performSave, 500);
  }, [performSave]);

  /**
   * Handle title input changes.
   */
  const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!note) return;
    updateDraft({ noteId: note.id, title: e.target.value });
    debouncedSave();
  }, [note, updateDraft, debouncedSave]);

  /**
   * Handle content changes from the Milkdown editor.
   */
  const handleContentChange = useCallback((markdown: string) => {
    if (!note) return;
    updateDraft({ noteId: note.id, content: markdown });
    debouncedSave();
  }, [note, updateDraft, debouncedSave]);

  /**
   * Handle note deletion with confirmation.
   */
  const handleDelete = useCallback(async () => {
    if (!note) return;
    if (!confirm("Delete this note? This cannot be undone.")) return;

    try {
      const noteTitle = note.title || "Untitled";
      await deleteNote(note.id);
      updateModelContext([
        {
          type: "text",
          text: `User deleted note: "${noteTitle}"`,
        },
      ]);
    } catch (err) {
      console.error("Failed to delete note:", err);
    }
  }, [note, deleteNote, updateModelContext]);

  /**
   * Handle back navigation - saves pending changes first.
   */
  const handleBack = useCallback(async () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      await performSave();
    }
    await goToList();
  }, [performSave, goToList]);

  // Early return if note is null (should not happen due to app.tsx guard)
  if (!note) {
    return null;
  }

  const lastSavedText = lastSaved
    ? `Saved ${formatRelativeTime(lastSaved)}`
    : "";

  return (
    <div className="h-full flex flex-col bg-bg-primary text-txt-primary overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-bdr-secondary shrink-0">
        <button
          className="bg-transparent border-none text-txt-secondary cursor-pointer p-1 rounded-sm shrink-0 hover:bg-bg-secondary hover:text-txt-primary"
          onClick={handleBack}
          title="Back to list"
          aria-label="Back to list"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <input
          type="text"
          className="note-title flex-1 text-base font-medium"
          value={note.title}
          onChange={handleTitleChange}
          placeholder="Untitled"
          autoComplete="off"
        />
        <div className="text-sm text-txt-secondary shrink-0">
          {isSaving && <span className="text-sm text-txt-tertiary">Saving...</span>}
          {!isSaving && lastSavedText && (
            <span className="text-sm text-txt-tertiary">{lastSavedText}</span>
          )}
        </div>
        <button
          className="bg-transparent border-none text-txt-secondary cursor-pointer py-1 px-2 rounded-sm shrink-0 hover:bg-bg-secondary hover:text-txt-primary"
          onClick={handleDelete}
          title="Delete note"
          aria-label="Delete note"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
          </svg>
        </button>
      </header>

      <div className="note-editor-container flex-1 overflow-hidden flex flex-col">
        <MilkdownEditor
          ref={editorRef}
          key={note.id}
          defaultValue={note.content ?? ""}
          onChange={handleContentChange}
        />
      </div>
    </div>
  );
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
