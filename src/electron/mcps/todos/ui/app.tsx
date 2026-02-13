/**
 * MCP Todos UI
 *
 * A clean, interactive todo list with detail view for editing notes.
 * Built entirely with open-mcp-app-ui components and the SDK theme mapping
 * so the app inherits its look from the host platform.
 */

import { useEffect, useCallback, useState, useRef, type FormEvent } from "react";
import { HostProvider, useHost, type Environment } from "open-mcp-app/react";
import {
  AppLayout,
  Heading,
  Text,
  Button,
  Badge,
  Input,
  Checkbox,
  Card,
} from "open-mcp-app-ui";
import { DetailView } from "./DetailView";
import type { Todo, TodoData, SearchResultData, TodoWidgetState, View } from "./types";
import "open-mcp-app-ui/styles.css";
import "./styles.css";

// =============================================================================
// List View Components
// =============================================================================

/**
 * Single todo item row.
 * Clicking the row opens the detail view; checkbox and delete have separate handlers.
 */
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
  return (
    <Card
      padding="sm"
      className="flex items-center gap-4 cursor-pointer transition-colors hover:bg-bg-secondary pl-[18px]"
      onClick={() => onOpen(todo.id)}
    >
      {/* Wrapper stops click from propagating to the row's onOpen handler */}
      <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={todo.completed}
          onChange={() => onToggle(todo.id)}
        />
      </div>
      <div className="flex-1 flex flex-col gap-0.5 min-w-0">
        <Text
          as="span"
          size="sm"
          variant={todo.completed ? "secondary" : "primary"}
          className={todo.completed ? "line-through" : ""}
        >
          {todo.text}
        </Text>
        {todo.notes && (
          <Text as="span" size="sm" variant="tertiary">Has notes</Text>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(todo.id);
        }}
        title="Delete"
        aria-label="Delete"
      >
        &times;
      </Button>
    </Card>
  );
}

/**
 * Scrollable list of todo items, or an empty state message.
 */
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
      <div className="flex-1 flex flex-col items-center justify-center gap-2">
        <Text variant="secondary">No todos yet</Text>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto flex flex-col gap-2">
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

/**
 * Form for adding a new todo.
 * Uses the library Input and Button for consistent styling.
 */
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
    <form className="flex gap-2 items-center" onSubmit={handleSubmit}>
      <div className="flex-1">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a new todo..."
          autoComplete="off"
          disabled={isSubmitting}
          maxLength={250}
          size="md"
        />
      </div>
      <Button
        type="submit"
        variant="primary"
        size="md"
        disabled={isSubmitting || !text.trim()}
      >
        Add
      </Button>
    </form>
  );
}

/**
 * Debounced search input.
 * Fires onSearch after 300ms of inactivity, or onClear when emptied.
 */
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

  return (
    <Input
      value={query}
      onChange={(e) => handleChange(e.target.value)}
      placeholder="Search todos..."
      autoComplete="off"
      size="md"
    />
  );
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Human-readable label for the current host environment.
 */
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

  const { callTool, isReady, log, exp, exp_widgetState, onToolResult, environment: hostEnvironment, hostContext } = useHost();

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
      setIsSaving(false);
      setLastSaved(new Date());
    }
  }, [updateState.data, updateTodosFromData]);

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
      // Optimistically update selectedTodo so the detail view checkbox
      // reflects the change immediately without waiting for the server.
      setSelectedTodo(prev =>
        prev?.id === id ? { ...prev, completed: !prev.completed } : prev
      );
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

  // -- Loading State --

  if (!isReady) {
    return (
      <AppLayout displayMode={hostContext?.displayMode} className="h-full">
        <div className="flex-1 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-bdr-secondary border-t-txt-primary rounded-full animate-spin" />
        </div>
      </AppLayout>
    );
  }

  // -- Detail View --

  if (view === "detail" && selectedTodo) {
    return (
      <DetailView
        todo={selectedTodo}
        onSave={handleSave}
        onToggle={handleToggle}
        onBack={handleBack}
        isSaving={isSaving}
        lastSaved={lastSaved}
        displayMode={hostContext?.displayMode}
      />
    );
  }

  // -- List View --

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

  const statusLabel = isSearchMode && searchResults
    ? `${searchResults.matches.length} found`
    : todos.length === 0
      ? "No items"
      : `${completedCount}/${todos.length} done`;

  return (
    <AppLayout displayMode={hostContext?.displayMode} className="h-full">
      <header className="flex items-baseline justify-between shrink-0">
        <Heading level={2} size="sm">Todo List</Heading>
        <Badge variant="secondary">{statusLabel}</Badge>
      </header>

      <AddTodoForm onAdd={handleAdd} />

      <div className="inline:-mx-2 pip:-mx-3 fullscreen:-mx-4 border-b border-bdr-secondary">
        <div className="inline:px-2 pip:px-3 fullscreen:px-4 pb-3">
          <SearchBar
            onSearch={handleSearch}
            onClear={handleClearSearch}
            isSearching={searchState.status === "loading"}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {isSearchMode && searchResults && searchResults.matches.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2">
            <Text variant="secondary">No results for &ldquo;{searchResults.query}&rdquo;</Text>
          </div>
        ) : (
          <TodoList
            todos={displayTodos}
            onToggle={handleToggle}
            onDelete={handleDelete}
            onOpen={handleOpen}
          />
        )}
      </div>

      {hostEnvironment === "standalone" && (
        <Badge variant="secondary" className="fixed bottom-2 right-2 opacity-70">
          {getEnvironmentLabel(hostEnvironment)}
        </Badge>
      )}
    </AppLayout>
  );
}
