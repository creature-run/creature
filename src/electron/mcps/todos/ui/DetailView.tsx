/**
 * DetailView Component
 *
 * Detail view for editing a single todo's notes with markdown support.
 * Features auto-save with debouncing. Uses the open-mcp-app-ui Editor
 * component for rich markdown editing.
 */

import { useEffect, useCallback, useState, useRef, useMemo } from "react";
import { AppLayout, Button, Input, Text, Checkbox } from "open-mcp-app-ui";
import type { DisplayMode } from "open-mcp-app-ui";
import { Editor } from "open-mcp-app-ui/editor";
import type { Todo } from "./types";

interface EditorRef {
  getMarkdown: () => string;
  setMarkdown: (markdown: string) => void;
  focus: () => void;
}

interface DetailViewProps {
  todo: Todo;
  onSave: (id: string, text: string, notes: string) => Promise<void>;
  onToggle: (id: string) => Promise<void>;
  onBack: () => void;
  isSaving: boolean;
  lastSaved: Date | null;
  displayMode?: DisplayMode;
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
  displayMode,
}: DetailViewProps) {
  const [text, setText] = useState(todo.text ?? "");
  const notesRef = useRef(todo.notes ?? "");
  const textRef = useRef(todo.text ?? "");
  const todoIdRef = useRef(todo.id);
  const lastSavedNotesRef = useRef(todo.notes ?? "");
  const lastDraftNotesRef = useRef(todo.notes ?? "");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<EditorRef>(null);

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
   * Sync state when todo changes (e.g., switching todos or external updates).
   * Detects external changes and updates editor content.
   */
  useEffect(() => {
    const isNewTodo = todo.id !== todoIdRef.current;

    if (isNewTodo) {
      setText(todo.text ?? "");
      textRef.current = todo.text ?? "";
      todoIdRef.current = todo.id;
      notesRef.current = todo.notes ?? "";
      lastSavedNotesRef.current = todo.notes ?? "";
      lastDraftNotesRef.current = todo.notes ?? "";
    } else {
      const hasNotes = todo.notes !== undefined;
      const isDifferentFromDraft = hasNotes && todo.notes !== lastDraftNotesRef.current;
      const isDifferentFromSaved = hasNotes && todo.notes !== lastSavedNotesRef.current;

      if (isDifferentFromDraft && isDifferentFromSaved) {
        setText(todo.text ?? "");
        textRef.current = todo.text ?? "";
        notesRef.current = todo.notes ?? "";
        editorRef.current?.setMarkdown(todo.notes ?? "");
        lastSavedNotesRef.current = todo.notes ?? "";
        lastDraftNotesRef.current = todo.notes ?? "";
      } else if (hasNotes && !isDifferentFromDraft) {
        setText(todo.text ?? "");
        textRef.current = todo.text ?? "";
        lastSavedNotesRef.current = todo.notes ?? "";
      } else {
        setText(todo.text ?? "");
        textRef.current = todo.text ?? "";
      }
    }
  }, [todo.id, todo.text, todo.notes]);

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

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newText = e.target.value;
      setText(newText);
      textRef.current = newText;
      debouncedSave(newText, notesRef.current);
    },
    [debouncedSave]
  );

  const handleNotesChange = useCallback(
    (newNotes: string) => {
      notesRef.current = newNotes;
      lastDraftNotesRef.current = newNotes;
      debouncedSave(textRef.current, newNotes);
    },
    [debouncedSave]
  );

  const handleToggle = useCallback(() => {
    onToggle(todo.id);
  }, [todo.id, onToggle]);

  const lastSavedText = useMemo(() => {
    if (!lastSaved) return null;
    return `Saved ${lastSaved.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }, [lastSaved]);

  return (
    <AppLayout displayMode={displayMode} noPadding className="h-full">
      <header className="flex items-center gap-3 py-3 px-4 border-b border-bdr-secondary shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          title="Back to todo list"
          aria-label="Back to todo list"
          className="shrink-0"
        >
          &larr;
        </Button>
        <Checkbox
          checked={todo.completed}
          onChange={handleToggle}
        />
        <div className="flex-1">
          <Input
            value={text}
            onChange={handleTextChange}
            placeholder="Todo title..."
            autoComplete="off"
            maxLength={250}
          />
        </div>
        <div className="shrink-0">
          {isSaving && <Text as="span" size="sm" variant="secondary">Saving...</Text>}
          {!isSaving && lastSavedText && (
            <Text as="span" size="sm" variant="tertiary">{lastSavedText}</Text>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-hidden flex flex-col">
        <Editor
          ref={editorRef}
          key={todo.id}
          value={todo.notes ?? ""}
          onChange={handleNotesChange}
          placeholder="Add notes (supports markdown)..."
          toolbar={["bold", "italic", "strikethrough", "divider", "heading", "bulletList", "orderedList", "taskList", "divider", "code", "codeBlock", "blockquote", "link"]}
          className="flex-1 min-h-0"
        />
      </div>
    </AppLayout>
  );
}
