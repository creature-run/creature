/**
 * DetailView Component
 *
 * Detail view for editing a single todo's notes with markdown support.
 * Features auto-save with debouncing.
 */

import { useEffect, useCallback, useState, useRef, useMemo } from "react";
import MilkdownEditor, { type MilkdownEditorRef } from "./MilkdownEditor";
import type { Todo } from "./types";

interface DetailViewProps {
  todo: Todo;
  onSave: (id: string, text: string, notes: string) => Promise<void>;
  onToggle: (id: string) => Promise<void>;
  onBack: () => void;
  isSaving: boolean;
  lastSaved: Date | null;
}

/**
 * Detail view for editing a single todo.
 * Auto-saves changes with 800ms debounce.
 */
export function DetailView({
  todo,
  onSave,
  onToggle,
  onBack,
  isSaving,
  lastSaved,
}: DetailViewProps) {
  const [text, setText] = useState(todo.text ?? "");
  const notesRef = useRef(todo.notes ?? "");
  const textRef = useRef(todo.text ?? "");
  const todoIdRef = useRef(todo.id);
  const lastSavedNotesRef = useRef(todo.notes ?? "");
  const lastDraftNotesRef = useRef(todo.notes ?? "");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<MilkdownEditorRef>(null);

  /**
   * Sync state when todo changes (e.g., switching todos or external updates).
   * Detects external changes and updates editor content.
   */
  useEffect(() => {
    const isNewTodo = todo.id !== todoIdRef.current;
    
    if (isNewTodo) {
      // New todo - reset all state
      setText(todo.text ?? "");
      textRef.current = todo.text ?? "";
      todoIdRef.current = todo.id;
      notesRef.current = todo.notes ?? "";
      lastSavedNotesRef.current = todo.notes ?? "";
      lastDraftNotesRef.current = todo.notes ?? "";
    } else {
      // Same todo - check for external updates
      const hasNotes = todo.notes !== undefined;
      const isDifferentFromDraft = hasNotes && todo.notes !== lastDraftNotesRef.current;
      const isDifferentFromSaved = hasNotes && todo.notes !== lastSavedNotesRef.current;
      
      if (isDifferentFromDraft && isDifferentFromSaved) {
        // External change detected - update editor
        setText(todo.text ?? "");
        textRef.current = todo.text ?? "";
        notesRef.current = todo.notes ?? "";
        editorRef.current?.setContent(todo.notes ?? "");
        lastSavedNotesRef.current = todo.notes ?? "";
        lastDraftNotesRef.current = todo.notes ?? "";
      } else if (hasNotes && !isDifferentFromDraft) {
        // This is our own save result - update saved ref to match current draft
        setText(todo.text ?? "");
        textRef.current = todo.text ?? "";
        lastSavedNotesRef.current = todo.notes ?? "";
      } else {
        // Update text but preserve local draft notes
        setText(todo.text ?? "");
        textRef.current = todo.text ?? "";
      }
    }
  }, [todo.id, todo.text, todo.notes]);

  /**
   * Debounced save function.
   */
  const debouncedSave = useCallback(
    (newText: string, newNotes: string) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(() => {
        onSave(todo.id, newText, newNotes);
        saveTimerRef.current = null;
      }, 800);
    },
    [todo.id, onSave]
  );

  /**
   * Handle text input changes.
   */
  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newText = e.target.value;
      setText(newText);
      textRef.current = newText;
      debouncedSave(newText, notesRef.current);
    },
    [debouncedSave]
  );

  /**
   * Handle notes changes from Milkdown editor.
   */
  const handleNotesChange = useCallback(
    (newNotes: string) => {
      notesRef.current = newNotes;
      lastDraftNotesRef.current = newNotes;
      debouncedSave(textRef.current, newNotes);
    },
    [debouncedSave]
  );

  /**
   * Handle toggle click.
   */
  const handleToggle = useCallback(() => {
    onToggle(todo.id);
  }, [todo.id, onToggle]);

  /**
   * Format last saved time for display.
   */
  const lastSavedText = useMemo(() => {
    if (!lastSaved) return null;
    return `Saved ${lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }, [lastSaved]);

  return (
    <div className="detail-container flex flex-col h-full overflow-hidden bg-bg-primary text-txt-primary">
      <header className="flex items-center gap-3 py-3 px-4 border-b border-bdr-secondary shrink-0">
        <button
          className="bg-transparent border-none text-txt-primary cursor-pointer py-1 px-2 rounded-sm shrink-0 flex items-center justify-center hover:bg-bg-secondary"
          onClick={onBack}
          title="Back to todo list"
          aria-label="Back to todo list"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <div
          className={`detail-checkbox w-[18px] h-[18px] border-[1.5px] border-bdr-primary rounded-sm cursor-pointer flex items-center justify-center shrink-0 transition-all hover:border-ring-primary ${todo.completed ? "bg-bg-inverse border-bg-inverse" : ""}`}
          onClick={handleToggle}
        >
          <svg
            viewBox="0 0 24 24"
            className={`w-4 h-4 stroke-txt-inverse stroke-[3] fill-none ${todo.completed ? "opacity-100" : "opacity-0"}`}
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <input
          type="text"
          className="flex-1 text-base font-medium bg-transparent border border-bdr-primary rounded-md py-1.5 px-2.5 text-txt-primary outline-none focus:border-ring-primary"
          value={text}
          onChange={handleTextChange}
          placeholder="Todo title..."
          autoComplete="off"
          maxLength={250}
        />
        <div className="text-xs text-txt-secondary shrink-0">
          {isSaving && <span className="text-txt-secondary">Saving...</span>}
          {!isSaving && lastSavedText && (
            <span className="text-txt-tertiary">{lastSavedText}</span>
          )}
        </div>
      </header>

      <div className="detail-editor-container flex-1 overflow-hidden flex flex-col">
        <MilkdownEditor
          ref={editorRef}
          key={todo.id}
          defaultValue={todo.notes ?? ""}
          onChange={handleNotesChange}
          placeholder="Add notes (supports markdown)..."
        />
      </div>
    </div>
  );
}
