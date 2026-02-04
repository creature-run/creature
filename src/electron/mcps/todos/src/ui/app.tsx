/**
 * MCP Todos UI
 *
 * A clean, interactive todo list with detail view for editing notes.
 * Uses Tailwind 4 with SDK theme mapping for host-provided variables.
 */

import { useEffect, useCallback, useState, useRef, type FormEvent } from "react";
import { HostProvider, useHost, type Environment } from "open-mcp-app/react";
import { DetailView } from "./DetailView";
import type { Todo, TodoData, SearchResultData, TodoWidgetState, View } from "./types";
// Tailwind 4 integration - imports SDK theme mapping for host-provided variables
import "open-mcp-app/styles/tailwind.css";
import "./styles.css";

// =============================================================================
// List View Components
// =============================================================================

function TodoItem({
  todo,
  onToggle,
  onDelete,
  onOpen,
}: {
  todo: Todo;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".todo-checkbox") || target.closest(".todo-delete")) {
        return;
      }
      onOpen(todo.id);
    },
    [todo.id, onOpen]
  );

  return (
    <div
      className={`flex items-center gap-2.5 p-2 px-2.5 bg-bg-secondary border border-bdr-secondary rounded-md cursor-pointer transition-colors hover:bg-bg-tertiary ${todo.completed ? "completed" : ""}`}
      onClick={handleClick}
    >
      <div
        className={`todo-checkbox w-4 h-4 border-[1.5px] border-bdr-primary rounded-sm cursor-pointer flex items-center justify-center shrink-0 transition-all hover:border-ring-primary ${todo.completed ? "bg-bg-inverse border-bg-inverse" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(todo.id);
        }}
      >
        <svg
          viewBox="0 0 24 24"
          className={`w-3.5 h-3.5 stroke-txt-inverse stroke-[3] fill-none ${todo.completed ? "opacity-100" : "opacity-0"}`}
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <div className="flex-1 flex flex-col gap-0.5 min-w-0">
        <span className={`break-words text-sm ${todo.completed ? "line-through text-txt-secondary" : ""}`}>
          {todo.text}
        </span>
        {todo.notes && <span className="text-xs text-txt-tertiary">Has notes</span>}
      </div>
      <button
        className="todo-delete w-6 h-6 border-none bg-transparent text-txt-secondary cursor-pointer rounded-sm flex items-center justify-center transition-all shrink-0 hover:bg-bg-tertiary hover:text-txt-primary"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(todo.id);
        }}
        title="Delete"
        type="button"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

function TodoList({
  todos,
  onToggle,
  onDelete,
  onOpen,
}: {
  todos: Todo[];
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  if (todos.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto flex flex-col gap-1">
        <div className="flex-1 flex flex-col items-center justify-center text-txt-secondary gap-2">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            className="w-12 h-12 opacity-50"
          >
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <span>No todos yet</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto flex flex-col mt-2 gap-2 scrollbar-thin">
      {todos.map((todo) => (
        <TodoItem
          key={todo.id}
          todo={todo}
          onToggle={onToggle}
          onDelete={onDelete}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function AddTodoForm({ onAdd }: { onAdd: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!text.trim() || isSubmitting) return;

      setIsSubmitting(true);
      try {
        await onAdd(text.trim());
        setText("");
      } finally {
        setIsSubmitting(false);
      }
    },
    [text, isSubmitting, onAdd]
  );

  return (
    <form className="flex gap-2 items-stretch" onSubmit={handleSubmit}>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a new todo..."
        autoComplete="off"
        disabled={isSubmitting}
        maxLength={250}
        className="flex-1 py-2 px-3 bg-transparent border border-bdr-primary rounded-md text-txt-primary font-inherit text-base outline-none focus:border-ring-primary placeholder:text-txt-tertiary"
      />
      <button
        type="submit"
        disabled={isSubmitting || !text.trim()}
        className="px-4 bg-bg-inverse border border-transparent rounded-md text-txt-inverse font-inherit text-sm font-medium cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Add
      </button>
    </form>
  );
}

function SearchBar({
  onSearch,
  onClear,
  isSearching,
}: {
  onSearch: (query: string) => void;
  onClear: () => void;
  isSearching: boolean;
}) {
  const [query, setQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleChange = useCallback(
    (value: string) => {
      setQuery(value);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      if (!value.trim()) {
        onClear();
        return;
      }

      debounceRef.current = setTimeout(() => {
        onSearch(value.trim());
      }, 300);
    },
    [onSearch, onClear]
  );

  const handleClear = useCallback(() => {
    setQuery("");
    onClear();
  }, [onClear]);

  return (
    <div className="pt-2 pb-3 mb-2 border-b border-bdr-secondary shrink-0">
      <div className="relative w-full">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 text-txt-tertiary w-3 h-3 pointer-events-none"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Search todos..."
          autoComplete="off"
          className="w-full py-2 pl-8 pr-3 bg-transparent border border-bdr-primary rounded-md text-sm text-txt-primary outline-none focus:border-ring-primary placeholder:text-txt-tertiary"
        />
      </div>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

function getEnvironmentLabel(env: Environment): string {
  switch (env) {
    case "chatgpt":
      return "ChatGPT";
    case "mcp-apps":
      return "MCP Apps";
    case "standalone":
      return "Standalone";
  }
}

export default function App() {
  return (
    <HostProvider name="todos" version="0.1.0">
      <TodoApp />
    </HostProvider>
  );
}

function TodoApp() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [view, setView] = useState<View>("list");
  const [selectedTodo, setSelectedTodo] = useState<Todo | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResultData | null>(null);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const hasInitialized = useRef(false);
  const hasRestoredState = useRef(false);

  const { callTool, isReady, log, exp, exp_widgetState, onToolResult, environment: hostEnvironment } = useHost();

  const [widgetState, setWidgetState] = exp_widgetState<TodoWidgetState>();

  const [listTodos, listState] = callTool<TodoData>("todos_list");
  const [addTodo, addState] = callTool<TodoData>("todos_add");
  const [toggleTodo, toggleState] = callTool<TodoData>("todos_toggle");
  const [removeTodo, removeState] = callTool<TodoData>("todos_remove");
  const [searchTodos, searchState] = callTool<SearchResultData>("todos_search");
  const [updateTodo, updateState] = callTool<TodoData>("todos_update");
  const [getTodo] = callTool<TodoData>("todos_get");

  useEffect(() => {
    if (hasRestoredState.current || !widgetState?.privateContent?.todos) {
      return;
    }
    hasRestoredState.current = true;
    const savedTodos = widgetState.privateContent.todos;
    if (savedTodos.length > 0) {
      log.debug("Restoring todos from widget state", { count: savedTodos.length });
      setTodos(savedTodos);
    }
  }, [widgetState, log]);

  const updateTodosFromData = useCallback(
    (data: TodoData | null) => {
      if (data?.todos) {
        setTodos(data.todos);
        log.debug("Todos updated", { count: data.todos.length });

        const incompleteCount = data.todos.filter((t: Todo) => !t.completed).length;
        setWidgetState({
          modelContent: {
            countTotal: data.todos.length,
            countIncomplete: incompleteCount,
          },
          privateContent: {
            todos: data.todos,
            lastViewedAt: new Date().toISOString(),
          },
        });
      }

      if (data?.todo && data?.view === "detail") {
        setSelectedTodo(data.todo);
        setView("detail");
      }
    },
    [log, setWidgetState]
  );

  useEffect(() => updateTodosFromData(listState.data), [listState.data, updateTodosFromData]);
  useEffect(() => updateTodosFromData(addState.data), [addState.data, updateTodosFromData]);
  useEffect(() => updateTodosFromData(toggleState.data), [toggleState.data, updateTodosFromData]);
  useEffect(() => updateTodosFromData(removeState.data), [removeState.data, updateTodosFromData]);

  useEffect(() => {
    if (updateState.data) {
      updateTodosFromData(updateState.data);
      if (updateState.data.todo && selectedTodo?.id === updateState.data.todo.id) {
        // Update selected todo with full data including notes
        setSelectedTodo(updateState.data.todo);
      }
      setIsSaving(false);
      setLastSaved(new Date());
    }
  }, [updateState.data, updateTodosFromData, selectedTodo?.id]);

  useEffect(() => {
    if (searchState.data) {
      setSearchResults(searchState.data);
      if (searchState.data.todos) {
        setTodos(searchState.data.todos);
      }
    }
  }, [searchState.data]);

  useEffect(() => {
    return onToolResult((result) => {
      if (result.source === "agent") {
        updateTodosFromData(result.structuredContent as unknown as TodoData);
      }
    });
  }, [onToolResult, updateTodosFromData]);

  useEffect(() => {
    if (!isReady || hasInitialized.current) return;
    hasInitialized.current = true;

    log.info("Todo list connected", { environment: hostEnvironment });

    const initialResult = exp.getInitialToolResult();
    if (initialResult) {
      log.debug("Initialized from agent tool result");
      const data = initialResult.structuredContent as unknown as TodoData;
      updateTodosFromData(data);
    } else {
      log.debug("Initialized by user - fetching list");
      listTodos();
    }
  }, [isReady, exp, log, hostEnvironment, updateTodosFromData, listTodos]);

  const handleAdd = useCallback(
    async (text: string) => {
      log.info("Adding todo", { text });
      try {
        await addTodo({ items: [{ text }] });
      } catch (err) {
        log.error("Failed to add todo", { error: String(err) });
      }
    },
    [addTodo, log]
  );

  const handleToggle = useCallback(
    async (id: string) => {
      try {
        await toggleTodo({ ids: [id] });
      } catch (err) {
        log.error("Failed to toggle todo", { id, error: String(err) });
      }
    },
    [toggleTodo, log]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      log.info("Deleting todo", { id });
      try {
        await removeTodo({ ids: [id] });
      } catch (err) {
        log.error("Failed to delete todo", { id, error: String(err) });
      }
    },
    [removeTodo, log]
  );

  const handleOpen = useCallback(
    async (id: string) => {
      log.info("Opening todo", { id });
      // Immediately switch to detail view with local data (if available)
      const localTodo = todos.find(t => t.id === id);
      if (localTodo) {
        setSelectedTodo(localTodo);
        setView("detail");
      }
      // Always fetch fresh data from server to ensure notes are loaded
      try {
        const result = await getTodo({ id });
        if (result?.structuredContent?.todo) {
          setSelectedTodo(result.structuredContent.todo);
          setView("detail");
        }
      } catch (err) {
        log.error("Failed to get todo", { id, error: String(err) });
      }
    },
    [todos, getTodo, log]
  );

  const handleSave = useCallback(
    async (id: string, text: string, notes: string) => {
      setIsSaving(true);
      try {
        await updateTodo({ id, text, notes: notes || "" });
      } catch (err) {
        log.error("Failed to save todo", { id, error: String(err) });
        setIsSaving(false);
      }
    },
    [updateTodo, log]
  );

  const handleBack = useCallback(() => {
    setView("list");
    setSelectedTodo(null);
    setLastSaved(null);
    listTodos();
  }, [listTodos]);

  const handleSearch = useCallback(
    async (query: string) => {
      log.info("Searching todos", { query });
      setIsSearchMode(true);
      try {
        await searchTodos({ query });
      } catch (err) {
        log.error("Failed to search todos", { query, error: String(err) });
      }
    },
    [searchTodos, log]
  );

  const handleClearSearch = useCallback(() => {
    setIsSearchMode(false);
    setSearchResults(null);
  }, []);

  if (!isReady) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-bg-primary text-txt-primary">
        <div className="w-6 h-6 border-2 border-bdr-secondary border-t-txt-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (view === "detail" && selectedTodo) {
    return (
      <DetailView
        todo={selectedTodo}
        onSave={handleSave}
        onToggle={handleToggle}
        onBack={handleBack}
        isSaving={isSaving}
        lastSaved={lastSaved}
      />
    );
  }

  const completedCount = todos.filter((t) => t.completed).length;
  const displayTodos = isSearchMode && searchResults
    ? searchResults.matches.map((m) => ({
        id: m.id,
        text: m.text,
        completed: m.completed,
        createdAt: "",
        updatedAt: "",
      }))
    : todos;

  return (
    <div className="flex flex-col h-full py-3 px-4 gap-1 bg-bg-primary text-txt-primary">
      <header className="flex items-baseline justify-between shrink-0">
        <h1 className="text-lg font-medium m-0 pb-2">Todo List</h1>
        <span className="text-txt-secondary text-xs">
          {isSearchMode && searchResults
            ? `${searchResults.matches.length} found`
            : todos.length === 0
              ? "No items"
              : `${completedCount}/${todos.length} done`}
        </span>
      </header>

      <AddTodoForm onAdd={handleAdd} />

      <SearchBar
        onSearch={handleSearch}
        onClear={handleClearSearch}
        isSearching={searchState.status === "loading"}
      />

      {isSearchMode && searchResults && searchResults.matches.length === 0 ? (
        <div className="flex-1 overflow-y-auto flex flex-col gap-1">
          <div className="flex-1 flex flex-col items-center justify-center text-txt-secondary gap-2">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              className="w-12 h-12 opacity-50"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span>No results for "{searchResults.query}"</span>
          </div>
        </div>
      ) : (
        <TodoList
          todos={displayTodos}
          onToggle={handleToggle}
          onDelete={handleDelete}
          onOpen={handleOpen}
        />
      )}

      {hostEnvironment === "standalone" && (
        <div className="fixed bottom-2 right-2 py-1 px-2 bg-bg-tertiary text-txt-secondary text-xs rounded-sm opacity-70">
          {getEnvironmentLabel(hostEnvironment)}
        </div>
      )}
    </div>
  );
}
