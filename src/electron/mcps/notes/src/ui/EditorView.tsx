/**
 * EditorView Component
 *
 * WYSIWYG markdown editor for a single note.
 * Features auto-save with debouncing and external update detection.
 *
 * Uses NotesContext to access state and actions directly,
 * eliminating the need for prop drilling.
 */

import { useEffect, useCallback, useState, useRef, useMemo } from "react";
import MilkdownEditor from "./MilkdownEditor";
import { useNotesContext } from "./useNotes";

/**
 * Editor view for editing a single note.
 * Auto-saves changes with 800ms debounce.
 *
 * Note: This component expects `note` to be non-null when rendered.
 * The parent (NotesApp) only renders EditorView when a note is loaded.
 */
export function EditorView() {
  const { note, saveNote, isSaving, lastSaved, editorRef, goToList, updateDraft } = useNotesContext();

  // Initialize with empty strings - will be synced via effect when note is available
  const [title, setTitle] = useState(note?.title ?? "");
  const contentRef = useRef(note?.content ?? "");
  const titleRef = useRef(note?.title ?? ""); // Ref for stable callback access
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Sync title state and refs when note changes (e.g., switching notes).
   */
  useEffect(() => {
    if (note) {
      setTitle(note.title ?? "");
      titleRef.current = note.title ?? "";
      contentRef.current = note.content ?? "";
    }
  }, [note?.id, note?.title, note?.content]);

  /**
   * Debounced save function.
   * Waits 800ms after last change before saving.
   */
  const debouncedSave = useCallback(
    (newTitle: string, newContent: string) => {
      if (!note) return;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(() => {
        saveNote(note.id, newTitle, newContent);
        saveTimerRef.current = null;
      }, 800);
    },
    [note, saveNote]
  );

  /**
   * Handle title input changes.
   */
  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!note) return;
      const newTitle = e.target.value;
      setTitle(newTitle);
      titleRef.current = newTitle; // Keep ref in sync for content changes
      updateDraft({ noteId: note.id, title: newTitle });
      debouncedSave(newTitle, contentRef.current);
    },
    [debouncedSave, note, updateDraft]
  );

  /**
   * Handle content changes from Milkdown editor.
   * Uses titleRef instead of title state to avoid stale closure issues
   * with MilkdownEditor's internal callback handling.
   */
  const handleContentChange = useCallback(
    (newContent: string) => {
      if (!note) return;
      contentRef.current = newContent;
      updateDraft({ noteId: note.id, content: newContent });
      debouncedSave(titleRef.current, newContent);
    },
    [debouncedSave, note, updateDraft]
  );

  /**
   * Format last saved time for display.
   */
  const lastSavedText = useMemo(() => {
    if (!lastSaved) return null;
    return `Saved ${lastSaved.toLocaleTimeString()}`;
  }, [lastSaved]);

  // Early return if no note (shouldn't happen - parent checks this)
  if (!note) {
    return null;
  }

  return (
    <div className="note-container flex flex-col h-full overflow-hidden bg-bg-primary text-txt-primary">
      <header className="flex items-center justify-between gap-4 py-2 px-4 border-b border-bdr-secondary shrink-0">
        <button
          className="bg-transparent border-none text-txt-primary text-base cursor-pointer py-1 px-2 mr-2 rounded-sm shrink-0 hover:bg-bg-secondary"
          onClick={goToList}
          title="Back to notes list"
          aria-label="Back to notes list"
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
          value={title}
          onChange={handleTitleChange}
          placeholder="Untitled"
          autoComplete="off"
        />
        <div className="text-sm text-txt-secondary shrink-0">
          {isSaving && <span className="text-txt-tertiary">Saving...</span>}
          {!isSaving && lastSavedText && (
            <span className="text-txt-tertiary">{lastSavedText}</span>
          )}
        </div>
      </header>

      <div className="note-editor-container flex-1 overflow-hidden flex flex-col">
        <MilkdownEditor
          ref={editorRef}
          key={note.id}
          defaultValue={note.content ?? ""}
          onChange={handleContentChange}
          placeholder="Write your note in markdown..."
        />
      </div>
    </div>
  );
}
