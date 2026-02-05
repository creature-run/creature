import { useState, useCallback, useEffect, useRef } from "react";
import { useHost, useToolResult, useWebSocket } from "open-mcp-app/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
// Tailwind 4 integration - imports SDK theme mapping for host-provided variables
import "open-mcp-app/styles/tailwind.css";
import "./fonts.css";
import "./app.css";

// =============================================================================
// Types
// =============================================================================

/** Instance data from tool results */
interface TerminalData {
  instanceId: string;
  cwd?: string;
  command?: string;
  displayMode?: "inline" | "pip";
  output?: string;
  exitCode?: number;
  websocketUrl?: string;
}

/** Widget state structure for persistence */
interface TerminalWidgetState {
  modelContent: {
    recentOutput: string;
    instanceId?: string;
    /** Most recent command (used as pip title) */
    lastCommand?: string;
    /** Last 5 commands executed in this terminal */
    recentCommands?: string[];
  };
  privateContent: { outputBuffer: string; terminalData: TerminalData | null };
}

/** Messages from server to UI via WebSocket */
type ServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number }
  | { type: "command"; command: string; recentCommands: string[] };

/** Messages from UI to server via WebSocket */
type ClientMessage = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };

// =============================================================================
// Helpers
// =============================================================================

/**
 * Strip ANSI escape codes from terminal output.
 */
const stripAnsiCodes = (text: string): string =>
  text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

/**
 * Get the last N lines from text.
 */
const getLastLines = (text: string, maxLines: number): string => {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join("\n");
};

/**
 * Terminal theme colors.
 * Terminal always uses dark mode regardless of host theme.
 */
const TERMINAL_THEME = {
  background: "#0D0D0B",
  foreground: "#efefef",
  cursor: "#efefef",
  cursorAccent: "#0D0D0B",
  selectionBackground: "#474442",
  black: "#131310",
  red: "#F85149",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#888888",
  brightBlack: "#888888",
  brightRed: "#ff7b72",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#FFFFFF",
};

// =============================================================================
// Component
// =============================================================================

export const App = () => {
  const [terminalData, setTerminalData] = useState<TerminalData | null>(null);
  const [currentTheme, setCurrentTheme] = useState<"dark" | "light">("dark");
  const [terminalReady, setTerminalReady] = useState(false);
  const [recentCommands, setRecentCommands] = useState<string[]>([]);

  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalDataRef = useRef<TerminalData | null>(null);
  const outputBufferRef = useRef("");
  const recentCommandsRef = useRef<string[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callToolRef = useRef<(name: string, args: Record<string, unknown>) => Promise<unknown>>(async () => ({}));

  const { data, instanceId: toolInstanceId, onToolResult } = useToolResult<TerminalData>();

  // ---------------------------------------------------------------------------
  // SDK Connection
  // ---------------------------------------------------------------------------

  const { callTool, isReady, exp_widgetState, exp } = useHost({
    name: "Terminal",
    version: "1.0.0",
    onToolResult,
    onThemeChange: useCallback((theme: "light" | "dark") => setCurrentTheme(theme), []),
    onTeardown: useCallback(async () => {
      xtermRef.current?.dispose();
      xtermRef.current = null;
      if (terminalDataRef.current?.instanceId) {
        try {
          await callToolRef.current("terminal_close", { instanceId: terminalDataRef.current.instanceId });
        } catch {
          // Ignore cleanup errors
        }
      }
      terminalDataRef.current = null;
    }, []),
  });

  // Get widget state tuple for reading and updating
  const [widgetState, setWidgetState] = exp_widgetState<TerminalWidgetState>();

  // Get tool callers
  const [terminalCreate] = callTool<TerminalData>("terminal_create");
  const [terminalClose] = callTool("terminal_close");

  // Create a wrapper function for legacy ref-based tool calling
  const callToolWrapper = useCallback(
    async (toolName: string, args: Record<string, unknown>) => {
      switch (toolName) {
        case "terminal_create": return terminalCreate(args);
        case "terminal_close": return terminalClose(args);
        default: throw new Error(`Unknown tool: ${toolName}`);
      }
    },
    [terminalCreate, terminalClose]
  );

  // Keep callTool ref in sync for use in callbacks
  useEffect(() => {
    callToolRef.current = callToolWrapper;
  }, [callToolWrapper]);

  // ---------------------------------------------------------------------------
  // Widget State Persistence (debounced)
  // ---------------------------------------------------------------------------

  /**
   * Save widget state for persistence (debounced to avoid excessive saves).
   */
  const saveWidgetState = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    saveTimerRef.current = setTimeout(() => {
      if (!terminalDataRef.current) return;

      const output = outputBufferRef.current;
      const commands = recentCommandsRef.current;
      const lastCommand = commands.length > 0 ? commands[commands.length - 1] : undefined;

      setWidgetState({
        modelContent: {
          recentOutput: getLastLines(stripAnsiCodes(output), 25),
          instanceId: terminalDataRef.current.instanceId,
          lastCommand,
          recentCommands: commands.length > 0 ? [...commands] : undefined,
        },
        privateContent: {
          outputBuffer: getLastLines(output, 100),
          terminalData: terminalDataRef.current,
        },
      } satisfies TerminalWidgetState);

      saveTimerRef.current = null;
    }, 500);
  }, [setWidgetState]);

  // ---------------------------------------------------------------------------
  // Instance Management
  // ---------------------------------------------------------------------------

  /**
   * Restore terminal data from tool result or widget state (refresh scenario).
   * Note: useToolResult extracts instanceId separately from data, so we merge them back.
   */
  useEffect(() => {
    // Merge instanceId back into data since useToolResult extracts it separately
    const mergedData = (toolInstanceId && data?.displayMode)
      ? { ...data, instanceId: toolInstanceId }
      : null;

    const dataToUse = mergedData ?? widgetState?.privateContent?.terminalData;

    if (dataToUse && dataToUse.instanceId !== terminalDataRef.current?.instanceId) {
      setTerminalData(dataToUse);
      terminalDataRef.current = dataToUse;

      // Initialize title and recent commands from initial command or restored state
      const initialCommand = dataToUse.command;
      const restoredCommands = widgetState?.modelContent?.recentCommands;

      if (restoredCommands && restoredCommands.length > 0) {
        // Restore from widget state
        recentCommandsRef.current = restoredCommands;
        setRecentCommands(restoredCommands);
        if (exp?.setTitle) {
          exp.setTitle(restoredCommands[restoredCommands.length - 1]);
        }
      } else if (initialCommand) {
        // Set initial command as first entry
        recentCommandsRef.current = [initialCommand];
        setRecentCommands([initialCommand]);
        if (exp?.setTitle) {
          exp.setTitle(initialCommand);
        }
      }
    }
  }, [data, toolInstanceId, widgetState, exp]);

  /**
   * Auto-initialize terminal when opened without tool data (e.g., from sidebar).
   * Creates a new terminal in pip mode with the base folder as cwd.
   */
  const autoInitAttemptedRef = useRef(false);
  useEffect(() => {
    if (!isReady || terminalData || autoInitAttemptedRef.current) return;
    
    // Mark as attempted to prevent multiple calls
    autoInitAttemptedRef.current = true;
    
    // Small delay to allow tool-input to arrive first if this was a tool-initiated open
    const timer = setTimeout(async () => {
      // Double-check we still don't have data
      if (terminalDataRef.current) return;
      
      try {
        await terminalCreate({
          command: "",
          cwd: ".",
          displayMode: "pip",
        });
      } catch (error) {
        console.error("[Terminal] Auto-init failed:", error);
      }
    }, 200);
    
    return () => clearTimeout(timer);
  }, [isReady, terminalData, terminalCreate]);

  // ---------------------------------------------------------------------------
  // WebSocket (pip mode)
  // ---------------------------------------------------------------------------

  /**
   * Handle messages from the WebSocket.
   */
  const handleWebSocketMessage = useCallback((msg: ServerMessage) => {
    if (msg.type === "output") {
      if (!xtermRef.current) return;
      xtermRef.current.write(msg.data);
      outputBufferRef.current += msg.data;
      saveWidgetState();
    } else if (msg.type === "exit") {
      if (!xtermRef.current) return;
      const exitMsg = `\r\n\x1b[90m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`;
      xtermRef.current.write(exitMsg);
      outputBufferRef.current += exitMsg;
      saveWidgetState();
    } else if (msg.type === "command") {
      // Update recent commands and pip title
      recentCommandsRef.current = msg.recentCommands;
      setRecentCommands(msg.recentCommands);

      // Update pip title with the latest command
      if (exp?.setTitle && msg.command) {
        exp.setTitle(msg.command);
      }

      saveWidgetState();
    }
  }, [saveWidgetState, exp]);

  const isPipMode = terminalData?.displayMode === "pip";
  const websocket = useWebSocket<ClientMessage, ServerMessage>(
    isPipMode ? terminalData?.websocketUrl : undefined,
    { onMessage: handleWebSocketMessage, enabled: isPipMode && terminalReady }
  );

  // ---------------------------------------------------------------------------
  // Terminal Initialization
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!terminalRef.current || xtermRef.current || !terminalData?.instanceId || !terminalData?.displayMode) return;

    const isPip = terminalData.displayMode === "pip";

    // Create terminal instance
    const terminal = new Terminal({
      theme: TERMINAL_THEME,
      fontSize: 13,
      fontFamily: '"SF Mono", Monaco, Consolas, "Liberation Mono", monospace',
      cursorBlink: isPip,
      cursorStyle: "block",
      scrollback: 10000,
      allowProposedApi: true,
      disableStdin: !isPip,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(terminalRef.current);

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Fit terminal to container (retry for layout settling)
    let fitCount = 0;
    const doFit = () => {
      if (fitCount++ < 30 && fitAddonRef.current) {
        fitAddonRef.current.fit();
        requestAnimationFrame(() => setTimeout(doFit, 50));
      }
    };
    doFit();

    // Clear buffer for pip mode - WebSocket will replay output
    if (isPip) {
      outputBufferRef.current = "";
    }

    setTerminalReady(true);
  }, [terminalData?.instanceId, terminalData?.displayMode]);

  /**
   * Write initial output for inline mode.
   */
  useEffect(() => {
    if (!terminalReady || !xtermRef.current || !terminalData?.output || isPipMode) return;

    xtermRef.current.write(terminalData.output);
    outputBufferRef.current = terminalData.output;

    if (terminalData.exitCode !== undefined) {
      const exitMsg = `\r\n\x1b[90m[Exit code: ${terminalData.exitCode}]\x1b[0m`;
      xtermRef.current.write(exitMsg);
      outputBufferRef.current += exitMsg;
    }

    saveWidgetState();
  }, [terminalReady, terminalData?.output, terminalData?.exitCode, isPipMode, saveWidgetState]);

  // ---------------------------------------------------------------------------
  // Input & Resize Handling (pip mode)
  // ---------------------------------------------------------------------------

  /**
   * Handle keyboard input in pip mode.
   */
  useEffect(() => {
    if (!terminalReady || !xtermRef.current || !isPipMode) return;

    const terminal = xtermRef.current;
    const disposable = terminal.onData((input) => websocket.send({ type: "input", data: input }));
    terminal.focus();

    return () => disposable.dispose();
  }, [terminalReady, isPipMode, websocket]);

  /**
   * Handle terminal resize in pip mode.
   */
  useEffect(() => {
    if (!terminalReady || !fitAddonRef.current || !terminalRef.current) return;

    const observer = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
      if (isPipMode && xtermRef.current) {
        websocket.send({ type: "resize", cols: xtermRef.current.cols, rows: xtermRef.current.rows });
      }
    });
    observer.observe(terminalRef.current);

    return () => observer.disconnect();
  }, [terminalReady, isPipMode, websocket]);

  // ---------------------------------------------------------------------------
  // Theme Updates
  // ---------------------------------------------------------------------------

  /**
   * Terminal always uses dark mode - theme stays constant.
   */
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = TERMINAL_THEME;
    }
  }, [currentTheme]);

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      xtermRef.current?.dispose();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="container">
      <div ref={terminalRef} className="terminal" />
      {!terminalData && (
        <div className="status">
          {isReady ? "Waiting for terminal..." : "Connecting..."}
        </div>
      )}
    </div>
  );
};

export default App;
