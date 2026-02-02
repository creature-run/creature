import { useState, useCallback, useEffect, useRef } from "react";
import Editor, { OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useHost, useToolResult } from "open-mcp-app/react";
import { FileTree, FileItem } from "./components/FileTree";
import { TabBar, TabInfo } from "./components/TabBar";
import { DiffViewer } from "./components/DiffViewer";

/**
 * Configure @monaco-editor/react to use the bundled Monaco instance.
 * This avoids CDN dependency and works offline in the Electron app.
 * The monaco-editor package is bundled via Vite.
 */
loader.config({ monaco });

/**
 * Custom Monaco theme name.
 * IDE editor always uses dark mode regardless of host theme.
 */
const CUSTOM_DARK_THEME = "creature-dark";

/**
 * Flag to track if Monaco language settings have been initialized.
 */
let monacoLanguagesInitialized = false;

/**
 * Initialize Monaco language settings.
 * Called once when editor first mounts.
 */
const initializeMonacoLanguages = (monacoInstance: typeof monaco) => {
  if (monacoLanguagesInitialized) return;
  monacoLanguagesInitialized = true;

  // Configure TypeScript compiler options for syntax highlighting and basic validation.
  // We disable module resolution since Monaco runs in the browser without access to node_modules.
  monacoInstance.languages.typescript.typescriptDefaults.setCompilerOptions({
    jsx: monacoInstance.languages.typescript.JsxEmit.React,
    jsxFactory: "React.createElement",
    reactNamespace: "React",
    allowNonTsExtensions: true,
    allowJs: true,
    target: monacoInstance.languages.typescript.ScriptTarget.ESNext,
    module: monacoInstance.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monacoInstance.languages.typescript.ModuleResolutionKind.NodeJs,
    noResolve: true,
    isolatedModules: true,
    esModuleInterop: true,
    skipLibCheck: true,
  });

  // Disable semantic validation for TypeScript (keeps syntax errors, removes type/import errors)
  monacoInstance.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  });

  // Configure JavaScript defaults for JSX support as well
  monacoInstance.languages.typescript.javascriptDefaults.setCompilerOptions({
    jsx: monacoInstance.languages.typescript.JsxEmit.React,
    jsxFactory: "React.createElement",
    reactNamespace: "React",
    allowNonTsExtensions: true,
    allowJs: true,
    target: monacoInstance.languages.typescript.ScriptTarget.ESNext,
    module: monacoInstance.languages.typescript.ModuleKind.ESNext,
    noResolve: true,
    isolatedModules: true,
    esModuleInterop: true,
  });

  // Disable semantic validation for JavaScript as well
  monacoInstance.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  });
};

/**
 * Monaco editor theme colors.
 * IDE editor always uses dark mode regardless of host theme.
 * These are hardcoded to ensure consistent dark appearance.
 */
const MONACO_THEME_COLORS = {
  "editor.background": "#0D0D0B",
  "editor.foreground": "#ABABAB",
  "editorLineNumber.foreground": "#666666",
  "editorLineNumber.activeForeground": "#ABABAB",
  "editor.lineHighlightBackground": "#1A1917",
  "editor.selectionBackground": "#3A383680",
  "editorCursor.foreground": "#ABABAB",
  "editorWidget.background": "#1A1917",
  "editorWidget.border": "#3A3836",
  "editorGutter.background": "#0D0D0B",
};

/**
 * Initialize Monaco dark theme.
 */
const initializeMonacoTheme = (monacoInstance: typeof monaco) => {
  monacoInstance.editor.defineTheme(CUSTOM_DARK_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: MONACO_THEME_COLORS,
  });
};

/**
 * Open file state with content tracking.
 */
interface OpenFile {
  path: string;
  content: string;
  originalContent: string;
  language: string;
}

/**
 * Widget state structure for persistence across refresh/popout.
 * - modelContent: Concise summary for the agent
 * - privateContent: UI-only data for restoration (not visible to agent)
 */
interface IdeWidgetState {
  modelContent: {
    activeFile: string | null;
    openFileCount: number;
  };
  privateContent: {
    activeFilePath: string | null;
    openFiles: Array<{ path: string; language: string }>;
    wsUrl: string | null;
  };
}

/**
 * Pending diff from agent file changes.
 */
interface PendingDiff {
  path: string;
  originalContent: string;
  modifiedContent: string;
  language: string;
}

/**
 * MCP IDE App
 *
 * Main application component providing:
 * - File tree browser on the left
 * - Tab bar for open files
 * - Monaco editor for code editing
 * - Real-time file watching via WebSocket
 *
 * All file operations go through MCP tools so both agent
 * and user actions are tracked in conversation history.
 */
export const App = () => {
  const [fileTree, setFileTree] = useState<FileItem[]>([]);
  const [openFiles, setOpenFiles] = useState<Map<string, OpenFile>>(new Map());
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [currentTheme, setCurrentTheme] = useState<"light" | "dark">("dark");
  const [monacoTheme, setMonacoTheme] = useState<string>(CUSTOM_DARK_THEME);
  const [pendingDiffs, setPendingDiffs] = useState<Map<string, PendingDiff>>(new Map());
  
  // Refs to access current state without causing re-renders/reconnections
  const openFilesRef = useRef<Map<string, OpenFile>>(openFiles);
  const activeFilePathRef = useRef<string | null>(activeFilePath);
  const wsRef = useRef<WebSocket | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const callToolRef = useRef<((name: string, args: Record<string, unknown>) => Promise<unknown>) | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);
  const hasFetchedInitialData = useRef(false);

  // Initialize Monaco theme early (before any editor mounts)
  // This ensures the dark theme is available for both main editor and diff viewer
  useEffect(() => {
    initializeMonacoTheme(monaco);
  }, []);

  // Keep refs in sync with state
  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
  }, [activeFilePath]);

  /**
   * Tool result data from useToolResult hook.
   */
  interface IdeToolData {
    websocketUrl?: string;
    path?: string;
    content?: string;
    language?: string;
    items?: FileItem[];
    openFile?: { path: string; content: string; language: string };
  }

  /**
   * Handle tool results from the MCP server.
   * Updates UI state based on the structured content.
   * 
   * IMPORTANT: Only updates UI state for UI-initiated tool calls.
   * Agent-initiated calls are ignored to prevent disrupting the user's workflow.
   */
  const handleToolResult = useCallback((result: {
    structuredContent?: Record<string, unknown>;
    source?: "agent" | "ui";
  }) => {
    // Ignore agent-initiated tool calls to prevent disrupting user's view
    if (result.source === "agent") {
      console.log("[MCP IDE] Ignoring agent-initiated tool result");
      return;
    }

    const sc = result.structuredContent;
    if (!sc) {
      console.log("[MCP IDE] handleToolResult: no structuredContent");
      return;
    }
    console.log("[MCP IDE] handleToolResult: processing UI-initiated result", Object.keys(sc));

    // Handle ide_open result - store WebSocket URL for file change notifications
    if (sc.websocketUrl && typeof sc.websocketUrl === "string") {
      console.debug("[MCP IDE] Setting websocketUrl:", sc.websocketUrl);
      setWsUrl(sc.websocketUrl);
    }

    // Handle file open/read/write/edit result
    if (sc.path && typeof sc.path === "string" && sc.content !== undefined) {
      const filePath = sc.path as string;
      const content = sc.content as string;
      const language = (sc.language as string) || "plaintext";

      setOpenFiles((prev) => {
        const newMap = new Map(prev);
        newMap.set(filePath, {
          path: filePath,
          content,
          originalContent: content,
          language,
        });
        return newMap;
      });
      setActiveFilePath(filePath);
    }

    // Handle directory listing result
    if (sc.items && Array.isArray(sc.items)) {
      setFileTree(sc.items as FileItem[]);
    }

    // Handle file open with openFile in structuredContent
    if (sc.openFile && typeof sc.openFile === "object") {
      const openFile = sc.openFile as { path: string; content: string; language: string };
      if (openFile.content !== null) {
        setOpenFiles((prev) => {
          const newMap = new Map(prev);
          newMap.set(openFile.path, {
            path: openFile.path,
            content: openFile.content,
            originalContent: openFile.content,
            language: openFile.language,
          });
          return newMap;
        });
        setActiveFilePath(openFile.path);
      }
    }
  }, []);

  // Use SDK's useToolResult hook
  const { onToolResult } = useToolResult<IdeToolData>();

  const { callTool, isReady, exp, exp_widgetState } = useHost({
    name: "MCP IDE",
    version: "0.0.1",
    onToolResult: (result) => {
      // Forward to onToolResult for useToolResult hook
      onToolResult(result);
      // Process the result for UI updates
      handleToolResult(result);
    },
    onThemeChange: useCallback((theme: "light" | "dark") => setCurrentTheme(theme), []),
    onTeardown: useCallback(async () => {
      console.debug("[MCP IDE] Teardown requested, closing WebSocket...");
      if (wsRef.current) {
        wsRef.current.close(1000, "Panel closing");
        wsRef.current = null;
      }
    }, []),
  });

  // Get widget state tuple for reading and updating
  const [widgetState, setWidgetState] = exp_widgetState<IdeWidgetState>();

  // Get tool callers
  const [ideOpen] = callTool<IdeToolData>("ide_open");
  const [ideDirList] = callTool<IdeToolData>("ide_dir_list");
  const [ideFileRead] = callTool<IdeToolData>("ide_file_read");
  const [ideFileWrite] = callTool<IdeToolData>("ide_file_write");
  const [ideExternalChange] = callTool<IdeToolData>("ide_external_change");
  const [terminalClose] = callTool("terminal_close");

  // Create a wrapper function for legacy ref-based tool calling
  const callToolWrapper = useCallback(
    async (toolName: string, args: Record<string, unknown>) => {
      switch (toolName) {
        case "ide_open": return ideOpen(args);
        case "ide_dir_list": return ideDirList(args);
        case "ide_file_read": return ideFileRead(args);
        case "ide_file_write": return ideFileWrite(args);
        case "ide_external_change": return ideExternalChange(args);
        case "terminal_close": return terminalClose(args);
        default: throw new Error(`Unknown tool: ${toolName}`);
      }
    },
    [ideOpen, ideDirList, ideFileRead, ideFileWrite, ideExternalChange, terminalClose]
  );

  // Keep callTool ref in sync for use in callbacks
  useEffect(() => {
    callToolRef.current = callToolWrapper;
  }, [callToolWrapper]);

  /**
   * Load initial data when host connection is ready.
   *
   * This is essential for maintaining state consistency across panel refreshes.
   * The MCP server holds the authoritative state, so whenever the UI loads
   * (or reloads after a refresh), it must sync with the server. We call both:
   * - ide_open: Gets the wsUrl for WebSocket connection
   * - ide_dir_list: Gets the file tree
   */
  useEffect(() => {
    if (isReady && !hasFetchedInitialData.current) {
      hasFetchedInitialData.current = true;
      // Call ide_open to get wsUrl for WebSocket connection
      ideOpen({});
      // Also load the file tree
      ideDirList({ path: ".", recursive: true });
    }
  }, [isReady, ideOpen, ideDirList]);

  /**
   * Restore state from widget state on refresh/popout.
   * Restores the active file path and opens saved files.
   */
  const hasRestoredFromWidgetState = useRef(false);
  useEffect(() => {
    if (hasRestoredFromWidgetState.current) return;
    if (!widgetState?.privateContent) return;
    
    const { activeFilePath: savedActivePath, openFiles: savedOpenFiles, wsUrl: savedWsUrl } = widgetState.privateContent;
    
    hasRestoredFromWidgetState.current = true;
    
    // Restore wsUrl if we have it
    if (savedWsUrl) {
      setWsUrl(savedWsUrl);
    }
    
    // Restore active file path
    if (savedActivePath) {
      setActiveFilePath(savedActivePath);
    }
    
    // Re-open saved files by calling the tool for each
    if (savedOpenFiles && savedOpenFiles.length > 0 && callToolRef.current) {
      savedOpenFiles.forEach((file) => {
        callToolRef.current?.("ide_file_read", { path: file.path });
      });
    }
  }, [widgetState]);

  /**
   * Persist state to widget state when relevant state changes.
   */
  useEffect(() => {
    if (!isReady) return;
    
    const openFilesArray = Array.from(openFiles.values()).map((f) => ({
      path: f.path,
      language: f.language,
    }));
    
    setWidgetState({
      modelContent: {
        activeFile: activeFilePath,
        openFileCount: openFilesArray.length,
      },
      privateContent: {
        activeFilePath,
        openFiles: openFilesArray,
        wsUrl,
      },
    } satisfies IdeWidgetState);
  }, [isReady, activeFilePath, openFiles, wsUrl, setWidgetState]);

  /**
   * Update pip title when active file changes.
   * This ensures the title updates when switching between tabs without making a tool call.
   */
  useEffect(() => {
    if (!isReady) return;
    
    if (activeFilePath) {
      // Extract filename from path for the title
      const fileName = activeFilePath.split("/").pop() || activeFilePath;
      exp.setTitle(fileName);
    } else {
      // No file open - show default IDE title
      exp.setTitle("IDE");
    }
  }, [isReady, activeFilePath, exp]);

  /**
   * Connect to WebSocket for file change notifications.
   * Uses refs to avoid reconnecting on state changes.
   */
  useEffect(() => {
    if (!wsUrl) {
      console.debug("[MCP IDE] No wsUrl provided");
      return;
    }

    // Don't reconnect if already connected to the same URL
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      console.debug("[MCP IDE] WebSocket already connected");
      return;
    }

    console.debug("[MCP IDE] Connecting to WebSocket:", wsUrl);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.debug("[MCP IDE] WebSocket connected to:", wsUrl);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.debug("[MCP IDE] WebSocket message:", data.type, data.path);
        const currentOpenFiles = openFilesRef.current;
        const currentCallTool = callToolRef.current;
        
        if (!currentCallTool) return;

        // Handle external file changes
        if (data.type === "file-changed" && data.external) {
          const filePath = data.path as string;
          console.debug("[MCP IDE] External file change:", filePath);
          
          // If file is open, reload it
          if (currentOpenFiles.has(filePath)) {
            currentCallTool("ide_file_read", { path: filePath });
          }
          
          // Notify agent about external change
          currentCallTool("ide_external_change", { 
            path: filePath, 
            type: "modified" 
          });
        }

        // Handle file updates - show diff view only for agent-initiated changes
        if (data.type === "file-updated" && data.path) {
          const filePath = data.path as string;
          const content = data.content as string;
          const originalContent = data.originalContent as string | null;
          const source = data.source as "agent" | "ui";

          // Detect language from extension
          const ext = filePath.split(".").pop()?.toLowerCase() || "";
          const langMap: Record<string, string> = {
            ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
            json: "json", md: "markdown", css: "css", html: "html", py: "python",
            rs: "rust", go: "go", java: "java", c: "c", cpp: "cpp", yaml: "yaml", yml: "yaml",
          };
          const language = langMap[ext] || "plaintext";

          // UI-initiated changes - update file directly without diff view
          if (source === "ui") {
            setOpenFiles((prev) => {
              const newMap = new Map(prev);
              newMap.set(filePath, {
                path: filePath,
                content,
                originalContent: content,
                language,
              });
              return newMap;
            });
            return;
          }

          // Agent-initiated changes - show diff view if we have original content
          if (originalContent !== null && originalContent !== undefined) {
            setPendingDiffs((prev) => {
              const newMap = new Map(prev);
              newMap.set(filePath, { path: filePath, originalContent, modifiedContent: content, language });
              return newMap;
            });
            setActiveFilePath(filePath);
          } else {
            // New file - just open it directly
            setOpenFiles((prev) => {
              const newMap = new Map(prev);
              newMap.set(filePath, {
                path: filePath,
                content,
                originalContent: content,
                language,
              });
              return newMap;
            });
            setActiveFilePath(filePath);
          }
        }

        // Handle file tree updates
        if (data.type === "file-added") {
          const filePath = data.path as string;
          console.debug("[MCP IDE] File added:", filePath);
          currentCallTool("ide_dir_list", { path: ".", recursive: true });
          currentCallTool("ide_external_change", { 
            path: filePath, 
            type: "created" 
          });
        }
        
        if (data.type === "file-deleted") {
          const filePath = data.path as string;
          console.debug("[MCP IDE] File deleted:", filePath);
          currentCallTool("ide_dir_list", { path: ".", recursive: true });
          currentCallTool("ide_external_change", { 
            path: filePath, 
            type: "deleted" 
          });
        }
      } catch (err) {
        console.error("WebSocket message error:", err);
      }
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
    };

    ws.onclose = () => {
      console.debug("[MCP IDE] WebSocket disconnected");
      wsRef.current = null;
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [wsUrl]); // Only depend on wsUrl, use refs for everything else

  /**
   * Open a file in the editor.
   */
  const handleFileSelect = useCallback(
    async (path: string) => {
      // If already open, just switch to it
      if (openFilesRef.current.has(path)) {
        setActiveFilePath(path);
        return;
      }

      // Otherwise, load the file
      await ideFileRead({ path });
    },
    [ideFileRead]
  );

  /**
   * Refresh the file tree.
   */
  const handleRefresh = useCallback(() => {
    ideDirList({ path: ".", recursive: true });
  }, [ideDirList]);

  /**
   * Handle tab selection.
   */
  const handleTabSelect = useCallback((path: string) => {
    setActiveFilePath(path);
  }, []);

  /**
   * Accept a pending diff - apply the change and open the file.
   */
  const handleAcceptDiff = useCallback((diff: PendingDiff) => {
    setOpenFiles((prev) => {
      const newMap = new Map(prev);
      newMap.set(diff.path, {
        path: diff.path,
        content: diff.modifiedContent,
        originalContent: diff.modifiedContent,
        language: diff.language,
      });
      return newMap;
    });
    setPendingDiffs((prev) => {
      const newMap = new Map(prev);
      newMap.delete(diff.path);
      return newMap;
    });
  }, []);

  /**
   * Reject a pending diff - revert to original content.
   */
  const handleRejectDiff = useCallback(
    async (diff: PendingDiff) => {
      // Write original content back to file
      await ideFileWrite({
        path: diff.path,
        content: diff.originalContent,
      });
      
      // Update open files with original content
      setOpenFiles((prev) => {
        const newMap = new Map(prev);
        newMap.set(diff.path, {
          path: diff.path,
          content: diff.originalContent,
          originalContent: diff.originalContent,
          language: diff.language,
        });
        return newMap;
      });
      setPendingDiffs((prev) => {
        const newMap = new Map(prev);
        newMap.delete(diff.path);
        return newMap;
      });
    },
    [ideFileWrite]
  );

  /**
   * Handle tab close.
   */
  const handleTabClose = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const newMap = new Map(prev);
      newMap.delete(path);
      return newMap;
    });

    // If closing active tab, switch to another
    setActiveFilePath((currentActive) => {
      if (path !== currentActive) return currentActive;
      const remaining = Array.from(openFilesRef.current.keys()).filter((p) => p !== path);
      return remaining.length > 0 ? remaining[remaining.length - 1] : null;
    });
  }, []);

  /**
   * Handle editor content changes.
   */
  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      const currentPath = activeFilePathRef.current;
      if (!currentPath || value === undefined) return;

      setOpenFiles((prev) => {
        const existing = prev.get(currentPath);
        if (!existing) return prev;

        const newMap = new Map(prev);
        newMap.set(currentPath, {
          ...existing,
          content: value,
        });
        return newMap;
      });
    },
    []
  );

  /**
   * Save the current file.
   * Uses ide_file_write to persist changes via MCP tool call.
   * Uses refs to always access current state.
   */
  const handleSave = useCallback(async () => {
    const currentPath = activeFilePathRef.current;
    if (!currentPath) return;

    const currentOpenFiles = openFilesRef.current;
    const file = currentOpenFiles.get(currentPath);
    if (!file) return;

    // Don't save if not modified
    if (file.content === file.originalContent) {
      console.debug("[MCP IDE] File not modified, skipping save");
      return;
    }

    console.debug("[MCP IDE] Saving file:", currentPath);
    
    const currentCallTool = callToolRef.current;
    if (!currentCallTool) return;

    await currentCallTool("ide_file_write", {
      path: currentPath,
      content: file.content,
    });

    // Mark as saved
    setOpenFiles((prev) => {
      const newMap = new Map(prev);
      const existing = prev.get(currentPath);
      if (existing) {
        newMap.set(currentPath, {
          ...existing,
          originalContent: existing.content,
        });
      }
      return newMap;
    });
  }, []);

  /**
   * Handle editor mount - set up keyboard shortcuts and capture Monaco instance.
   * Initializes Monaco language settings and dark theme.
   */
  const handleEditorMount: OnMount = useCallback(
    (editor, monacoInstance) => {
      editorRef.current = editor;
      monacoRef.current = monacoInstance;

      // Initialize language settings on first mount
      initializeMonacoLanguages(monacoInstance);

      // Initialize dark theme (editor always uses dark mode)
      initializeMonacoTheme(monacoInstance);
      setMonacoTheme(CUSTOM_DARK_THEME);

      // Add Cmd/Ctrl+S to save using Monaco's KeyMod and KeyCode
      editor.addCommand(
        monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
        () => {
          handleSave();
        }
      );
    },
    [handleSave]
  );

  // Get active file for editor
  const activeFile = activeFilePath ? openFiles.get(activeFilePath) : null;

  // Build tabs list - include files with pending diffs even if not open
  const tabs: TabInfo[] = [];
  const addedPaths = new Set<string>();
  
  // Add open files
  for (const file of openFiles.values()) {
    tabs.push({
      path: file.path,
      name: file.path.split("/").pop() || file.path,
      isModified: file.content !== file.originalContent,
      hasPendingDiff: pendingDiffs.has(file.path),
    });
    addedPaths.add(file.path);
  }
  
  // Add files with pending diffs that aren't already open
  for (const diff of pendingDiffs.values()) {
    if (!addedPaths.has(diff.path)) {
      tabs.push({
        path: diff.path,
        name: diff.path.split("/").pop() || diff.path,
        isModified: false,
        hasPendingDiff: true,
      });
    }
  }

  if (!isReady) {
    return (
      <div className="ide-loading">
        <span>Connecting...</span>
      </div>
    );
  }

  // Get pending diff for active file (if any)
  const currentDiff = activeFilePath ? pendingDiffs.get(activeFilePath) : null;

  return (
    <div className="ide-container" data-theme={currentTheme}>
      <div className="ide-sidebar">
        <FileTree
          items={fileTree}
          onFileSelect={handleFileSelect}
          onRefresh={handleRefresh}
          selectedPath={activeFilePath || undefined}
        />
      </div>
      <div className="ide-main">
        <TabBar
          tabs={tabs}
          activeTab={activeFilePath}
          onTabSelect={handleTabSelect}
          onTabClose={handleTabClose}
        />
        <div className="ide-editor">
          {currentDiff ? (
            <DiffViewer
              originalContent={currentDiff.originalContent}
              modifiedContent={currentDiff.modifiedContent}
              language={currentDiff.language}
              filePath={currentDiff.path}
              theme={monacoTheme}
              onAccept={() => handleAcceptDiff(currentDiff)}
              onReject={() => handleRejectDiff(currentDiff)}
            />
          ) : activeFile ? (
            <Editor
              height="100%"
              path={activeFile.path}
              language={activeFile.language}
              value={activeFile.content}
              theme={monacoTheme}
              onChange={handleEditorChange}
              onMount={handleEditorMount}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: "on",
                lineNumbersMinChars: 3,
                glyphMargin: false,
                folding: true,
                foldingHighlight: false,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                wordWrap: "on",
                renderWhitespace: "selection",
                padding: { top: 10, bottom: 0 },
                matchBrackets: "never",
                bracketPairColorization: { enabled: false },
              }}
            />
          ) : (
            <div className="ide-empty">
              <div className="ide-empty-message">
                <p>Select a file to open</p>
                <p className="ide-empty-hint">
                  Use the file tree on the left, or ask the agent to open a file
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default App;
