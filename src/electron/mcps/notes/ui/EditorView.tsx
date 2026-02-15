import React, { useRef, useCallback, useState, useEffect } from "react";
import { useHost } from "open-mcp-app/react";
import { ArrowLeft, Trash } from "@phosphor-icons/react";
import { AppLayout, Button, Text } from "open-mcp-app-ui";
import { Editor } from "open-mcp-app-ui/editor";
import { useNotesContext } from "./useNotes";

/**
 * Local ref type matching the sdk-ui Editor's imperative handle.
 */
interface EditorRefHandle {
  getMarkdown: () => string;
  setMarkdown: (markdown: string) => void;
  focus: () => void;
}

/**
 * EditorView Component
 *
 * Displays the note editor with title input and the sdk-ui Editor component.
 * Uses refs to track the latest title and content values, avoiding stale
 * closures in the debounced save callback (same pattern as Todos DetailView).
 *
 * Features:
 * - Auto-save on edit with debouncing
 * - Navigation back to list view
 * - Note deletion
 */
export function EditorView() {
  const { updateModelContext, hostContext } = useHost();
  const {
    note,
    isSaving,
    lastSaved,
    editorRef,
    saveNote,
    goToList,
    deleteNote,
  } = useNotesContext();

  /**
   * Local state for the title input.
   * Kept separate from context so typing doesn't depend on context re-renders.
   */
  const [title, setTitle] = useState(note?.title ?? "");

  /**
   * Refs track the latest values for the debounced save callback.
   * This avoids stale closures where performSave captures an old `note` object.
   */
  const titleRef = useRef(note?.title ?? "");
  const contentRef = useRef(note?.content ?? "");
  const noteIdRef = useRef(note?.id ?? "");
  const lastSavedContentRef = useRef(note?.content ?? "");
  const lastDraftContentRef = useRef(note?.content ?? "");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localEditorRef = useRef<EditorRefHandle>(null);

  /**
   * Cancel any pending debounced save on unmount.
   */
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  /**
   * Sync local state when note changes from context (e.g., external update, new note).
   * Mirrors the Todos DetailView pattern: detect new notes vs. external updates.
   */
  useEffect(() => {
    if (!note) return;

    const isNewNote = note.id !== noteIdRef.current;

    if (isNewNote) {
      setTitle(note.title ?? "");
      titleRef.current = note.title ?? "";
      contentRef.current = note.content ?? "";
      noteIdRef.current = note.id;
      lastSavedContentRef.current = note.content ?? "";
      lastDraftContentRef.current = note.content ?? "";
    } else {
      // Same note — check for external content updates
      const hasContent = note.content !== undefined;
      const isDifferentFromDraft = hasContent && note.content !== lastDraftContentRef.current;
      const isDifferentFromSaved = hasContent && note.content !== lastSavedContentRef.current;

      if (isDifferentFromDraft && isDifferentFromSaved) {
        // External change — update everything
        setTitle(note.title ?? "");
        titleRef.current = note.title ?? "";
        contentRef.current = note.content ?? "";
        localEditorRef.current?.setMarkdown(note.content ?? "");
        lastSavedContentRef.current = note.content ?? "";
        lastDraftContentRef.current = note.content ?? "";
      } else if (hasContent && !isDifferentFromDraft) {
        // Our own save echoed back — just sync title
        setTitle(note.title ?? "");
        titleRef.current = note.title ?? "";
        lastSavedContentRef.current = note.content ?? "";
      } else {
        // No content change — sync title only
        setTitle(note.title ?? "");
        titleRef.current = note.title ?? "";
      }
    }
  }, [note?.id, note?.title, note?.content]);

  /**
   * Debounced save — takes explicit values to avoid stale closures.
   * Captures the note ID at call time so a late-firing timeout won't
   * accidentally save old content to a different note.
   */
  const debouncedSave = useCallback(
    (newTitle: string, newContent: string) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      const targetNoteId = noteIdRef.current;
      saveTimerRef.current = setTimeout(() => {
        if (!targetNoteId) return;
        saveNote(targetNoteId, newTitle.trim() || "Untitled", newContent);
        saveTimerRef.current = null;
      }, 500);
    },
    [saveNote]
  );

  /**
   * Handle title input changes.
   * Updates local state + ref and triggers debounced save.
   */
  const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    titleRef.current = newTitle;
    debouncedSave(newTitle, contentRef.current);
  }, [debouncedSave]);

  /**
   * Handle content changes from the Editor component.
   * Stores to ref and triggers debounced save with explicit values.
   */
  const handleContentChange = useCallback((markdown: string) => {
    contentRef.current = markdown;
    lastDraftContentRef.current = markdown;
    debouncedSave(titleRef.current, markdown);
  }, [debouncedSave]);

  /**
   * Handle note deletion.
   */
  const handleDelete = useCallback(async () => {
    if (!note) return;

    try {
      const noteTitle = note.title || "Untitled";
      await deleteNote(note.id);
      updateModelContext([
        {
          type: "text",
          text: `User deleted note: "${noteTitle}"`,
        },
      ]);
      await goToList();
    } catch (err) {
      console.error("Failed to delete note:", err);
    }
  }, [note, deleteNote, updateModelContext, goToList]);

  /**
   * Handle back navigation — flush any pending save first.
   */
  const handleBack = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      if (noteIdRef.current) {
        await saveNote(noteIdRef.current, titleRef.current.trim() || "Untitled", contentRef.current);
      }
    }
    await goToList();
  }, [saveNote, goToList]);

  // Early return if note is null (should not happen due to app.tsx guard)
  if (!note) {
    return null;
  }

  const lastSavedText = lastSaved
    ? `Saved ${formatRelativeTime(lastSaved)}`
    : "";

  return (
    <AppLayout displayMode={hostContext?.displayMode} noPadding className="h-full">
      <div className="h-full flex flex-col overflow-hidden">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-bdr-secondary shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBack}
            title="Back to list"
            aria-label="Back to list"
          >
            <ArrowLeft size={16} />
          </Button>
          <input
            type="text"
            className="note-title flex-1 text-base font-medium"
            value={title}
            onChange={handleTitleChange}
            placeholder="Untitled"
            autoComplete="off"
          />
          <div className="shrink-0">
            {isSaving && <Text as="span" size="sm" variant="tertiary">Saving...</Text>}
            {!isSaving && lastSavedText && (
              <Text as="span" size="sm" variant="tertiary">{lastSavedText}</Text>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            title="Delete note"
            aria-label="Delete note"
          >
            <Trash size={16} />
          </Button>
        </header>

        <div className="flex-1 overflow-hidden flex flex-col">
          <Editor
            ref={(r) => {
              // Forward to both the local ref and the context ref
              localEditorRef.current = r;
              (editorRef as React.MutableRefObject<EditorRefHandle | null>).current = r;
            }}
            key={note.id}
            value={note.content ?? ""}
            onChange={handleContentChange}
            placeholder="Start writing..."
            toolbar={[
              "bold", "italic", "strikethrough",
              "divider",
              "heading", "bulletList", "orderedList", "taskList",
              "divider",
              "code", "codeBlock", "blockquote", "link",
              "divider",
              "undo", "redo",
            ]}
            className="flex-1 min-h-0"
          />
        </div>
      </div>
    </AppLayout>
  );
}

/**
 * Format a Date object as relative time (e.g., "just now", "5s ago").
 */
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
