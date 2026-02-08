#!/usr/bin/env node
/**
 * MCP Terminal Server
 *
 * Terminal emulation with PTY (pseudo-terminal) support.
 * Uses WebSocket for real-time bidirectional communication in pip mode.
 *
 * Key features:
 * - PTY-based terminal instances
 * - Inline mode: wait for command completion, return output
 * - Pip mode: real-time streaming via WebSocket
 * - Instance state tracks PTY process for cleanup
 */

import { createApp } from "open-mcp-app/server";
import { z } from "zod";
import path from "path";
import { TerminalManager, type DisplayMode } from "./terminalManager.js";
import { ICON_SVG, ICON_ALT } from "./icon.js";

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.MCP_PORT || process.env.PORT || "3002", 10);
const BASE_FOLDER = process.env.MCP_WORKING_DIR || process.cwd();
const TERMINAL_UI_RESOURCE_URI = "ui://terminal/terminal";

// =============================================================================
// Types
// =============================================================================

/** Messages sent from server to UI via WebSocket */
type ServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number }
  | { type: "command"; command: string; recentCommands: string[] };

/** Messages sent from UI to server via WebSocket */
type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

/** Instance state stored per terminal */
interface TerminalInstanceState {
  cwd: string;
  command?: string;
  displayMode: DisplayMode;
  /** Send function for this instance's WebSocket (from context.send) */
  send?: (msg: ServerMessage) => void;
  /** Whether a WebSocket client has connected and received the initial buffer */
  clientConnected?: boolean;
}

// =============================================================================
// SDK App & Terminal Manager Setup
// =============================================================================

const terminalManager = new TerminalManager();

const app = createApp({
  name: "terminal",
  version: "0.0.6",
  port: PORT,
});

// =============================================================================
// WebSocket Integration
// =============================================================================

/**
 * Setup WebSocket message handler for a terminal instance.
 * Wires incoming messages from UI to PTY.
 */
const setupMessageHandler = (instanceId: string) => (msg: ClientMessage) => {
  if (msg.type === "input") {
    terminalManager.write({ instanceId, data: msg.data });
  } else if (msg.type === "resize") {
    terminalManager.resize({ instanceId, cols: msg.cols, rows: msg.rows });
  }
};

// =============================================================================
// PTY Event Handlers
// =============================================================================

/**
 * Forward PTY output to the WebSocket for the instance.
 */
terminalManager.on("output", (instanceId: string, data: string) => {
  const state = app.getInstanceState<TerminalInstanceState>(instanceId);
  if (state?.send) {
    state.send({ type: "output", data });
  }
});

/**
 * Forward PTY exit event to the WebSocket.
 */
terminalManager.on("exit", (instanceId: string, exitCode: number) => {
  const state = app.getInstanceState<TerminalInstanceState>(instanceId);
  if (state?.send) {
    state.send({ type: "exit", exitCode });
  }
});

/**
 * Forward command detection to the WebSocket.
 * Includes the command and recent command history for UI state.
 */
terminalManager.on("command", (instanceId: string, command: string) => {
  const state = app.getInstanceState<TerminalInstanceState>(instanceId);
  const terminal = terminalManager.get(instanceId);
  if (state?.send && terminal) {
    state.send({
      type: "command",
      command,
      recentCommands: terminal.recentCommands,
    });
  }
});

/**
 * When PTY closes, destroy the instance.
 */
terminalManager.on("close", (instanceId: string) => {
  app.destroyInstance(instanceId);
});

// =============================================================================
// Instance Cleanup
// =============================================================================

/**
 * Clean up PTY when instance is destroyed.
 */
app.onInstanceDestroy(({ instanceId }) => {
  const pty = terminalManager.get(instanceId);
  if (pty) {
    terminalManager.close({ instanceId });
  }
});

// =============================================================================
// UI Resource
// =============================================================================

app.resource({
  name: "Interactive Terminal",
  uri: TERMINAL_UI_RESOURCE_URI,
  description: "xterm.js-based terminal interface for PTY instances",
  displayModes: ["inline", "pip"],
  html: "terminal/ui/index.html",
  icon: { svg: ICON_SVG, alt: ICON_ALT },
  csp: {
    connectDomains: [`ws://localhost:${PORT}`],
  },
  experimental: {
    multiInstance: true,
    websocket: true,  // SDK manages WebSocket automatically per instance
  },
  // Routing configuration for multiple terminal instances
  instanceMode: "multiple",
  views: {
    // Static view: terminal_create always spawns a new pip
    "/terminal": ["terminal_create"],
    // Parameterized view: routes to existing pip by instanceId
    "/terminal/:instanceId": [
      "terminal_read",
      "terminal_write",
      "terminal_stop",
      "terminal_resize",
      "terminal_get",
      "terminal_close",
    ],
  },
});

// =============================================================================
// Tools
// =============================================================================

/**
 * Create a new terminal and run a command.
 * This is a "create" tool - instanceId is generated automatically.
 */
app.tool(
  "terminal_create",
  {
    description:
      "Create a new terminal and run a command. For inline mode, waits for completion and returns output. Use displayMode='pip' for dev servers or long-running processes.",
    input: z.object({
      command: z.string().describe("The command to run"),
      cwd: z.string().describe("Working directory"),
      displayMode: z.enum(["inline", "pip"]).optional().describe("Use 'pip' for long-running processes. Default: inline"),
    }),
    ui: TERMINAL_UI_RESOURCE_URI,
    visibility: ["model", "app"],
    displayModes: ["inline", "pip"],
    experimental: {
      defaultDisplayMode: "inline",
    },
  },
  async ({ command, cwd, displayMode = "inline" }, context) => {
    const { instanceId, setState, send, onMessage, onConnect } = context;
    const resolvedCwd = path.isAbsolute(cwd) ? cwd : path.resolve(BASE_FOLDER, cwd);
    const mode: DisplayMode = displayMode ?? "inline";

    // Initialize instance state with send function for PTY events
    const instanceState: TerminalInstanceState = {
      cwd: resolvedCwd,
      command,
      displayMode: mode,
      send: mode === "pip" ? send : undefined,
      clientConnected: false,
    };

    // Setup WebSocket handlers for pip mode
    if (mode === "pip") {
      onMessage(setupMessageHandler(instanceId));
      
      // When UI client connects, send the buffered output so far
      onConnect(() => {
        const pty = terminalManager.get(instanceId);
        if (pty && pty.outputBuffer) {
          send({ type: "output", data: pty.outputBuffer });
        }
        // Mark client as connected to avoid re-sending buffer
        const currentState = app.getInstanceState<TerminalInstanceState>(instanceId);
        if (currentState) {
          setState({ ...currentState, clientConnected: true });
        }
      });
    }

    setState(instanceState);

    // Spawn PTY using the instance ID
    terminalManager.spawn({
      id: instanceId,
      cwd: resolvedCwd,
      command,
      displayMode: mode,
    });

    if (mode === "inline") {
      // Wait for command to complete
      const result = await terminalManager.waitForExit({ instanceId, timeoutMs: 30000 });

      return {
        data: {
          success: true,
          cwd,
          command,
          displayMode: mode,
          output: result.output,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        },
        text: result.output || `Command completed with exit code ${result.exitCode}`,
        title: command,
        inlineHeight: 300,
      };
    }

    // Pip mode - return immediately (websocketUrl auto-included by SDK)
    return {
      data: {
        success: true,
        cwd,
        command,
        displayMode: mode,
      },
      text: `Terminal started: ${command || "shell"}`,
      title: command || "Terminal",
    };
  }
);

/**
 * Read output from a terminal instance.
 */
app.tool(
  "terminal_read",
  {
    description: "Read output from a terminal instance. Returns output buffer, exit status, and whether the instance is idle.",
    input: z.object({
      instanceId: z.string().describe("The instance ID from terminal_create"),
      tail: z.number().optional().describe("Only return last N characters"),
    }),
    ui: TERMINAL_UI_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  async ({ instanceId, tail }) => {
    const state = app.getInstanceState<TerminalInstanceState>(instanceId);
    if (!state) {
      return {
        data: { success: false, error: "Instance not found" },
        text: "Error: Instance not found",
        isError: true,
      };
    }

    const result = terminalManager.read({ instanceId });
    if (!result.success) {
      return {
        data: { success: false, error: result.error },
        text: `Error: ${result.error}`,
        isError: true,
      };
    }

    let output = result.output || "";
    if (tail && tail > 0) {
      output = output.slice(-tail);
    }

    return {
      data: { instanceId, success: true, output, exited: result.exited, exitCode: result.exitCode, idle: result.idle },
      text: output || `Terminal idle: ${result.idle}, exited: ${result.exited}`,
    };
  }
);

/**
 * Stop a running process with SIGINT.
 */
app.tool(
  "terminal_stop",
  {
    description: "Stop a running process by sending SIGINT (Ctrl+C). The terminal remains alive for new commands.",
    input: z.object({
      instanceId: z.string().describe("The instance ID"),
    }),
    ui: TERMINAL_UI_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  async ({ instanceId }) => {
    const state = app.getInstanceState<TerminalInstanceState>(instanceId);
    if (!state) {
      return {
        data: { success: false, error: "Instance not found" },
        text: "Error: Instance not found",
        isError: true,
      };
    }

    const result = terminalManager.interrupt({ instanceId });
    return {
      data: { instanceId, success: result.success, idle: result.idle, error: result.error },
      text: result.success ? "Process interrupted" : `Error: ${result.error}`,
      isError: !result.success,
    };
  }
);

/**
 * Write input to a terminal instance.
 */
app.tool(
  "terminal_write",
  {
    description: "Write input to a terminal instance (keyboard input)",
    input: z.object({
      instanceId: z.string().describe("The instance ID"),
      data: z.string().describe("Data to write (keyboard input)"),
    }),
    ui: TERMINAL_UI_RESOURCE_URI,
    visibility: ["app"],
  },
  async ({ instanceId, data }) => {
    const state = app.getInstanceState<TerminalInstanceState>(instanceId);
    if (!state) {
      return {
        data: { success: false, error: "Instance not found" },
        text: "Error: Instance not found",
        isError: true,
      };
    }

    const result = terminalManager.write({ instanceId, data });
    return {
      data: { success: result.success, error: result.error },
      text: result.success ? "Input written" : `Error: ${result.error}`,
      isError: !result.success,
    };
  }
);

/**
 * Resize the terminal.
 */
app.tool(
  "terminal_resize",
  {
    description: "Resize the terminal",
    input: z.object({
      instanceId: z.string().describe("The instance ID"),
      cols: z.number().describe("Number of columns"),
      rows: z.number().describe("Number of rows"),
    }),
    ui: TERMINAL_UI_RESOURCE_URI,
    visibility: ["app"],
  },
  async ({ instanceId, cols, rows }) => {
    const state = app.getInstanceState<TerminalInstanceState>(instanceId);
    if (!state) {
      return {
        data: { success: false, error: "Instance not found" },
        text: "Error: Instance not found",
        isError: true,
      };
    }

    const result = terminalManager.resize({ instanceId, cols, rows });
    return {
      data: { success: result.success, error: result.error },
      text: result.success ? "Terminal resized" : `Error: ${result.error}`,
      isError: !result.success,
    };
  }
);

/**
 * Get instance details for UI restoration.
 */
app.tool(
  "terminal_get",
  {
    description: "Get terminal instance details for UI restoration",
    input: z.object({
      instanceId: z.string().describe("The instance ID"),
      displayMode: z.enum(["inline", "pip"]).optional(),
    }),
    ui: TERMINAL_UI_RESOURCE_URI,
    visibility: ["app"],
  },
  async ({ instanceId, displayMode = "pip" }) => {
    const state = app.getInstanceState<TerminalInstanceState>(instanceId);
    if (!state) {
      return {
        data: { success: false, error: "Instance not found" },
        text: "Error: Instance not found",
        isError: true,
      };
    }

    const pty = terminalManager.get(instanceId);
    if (!pty) {
      return {
        data: { success: false, error: "PTY not found" },
        text: "Error: PTY not found",
        isError: true,
      };
    }

    return {
      data: {
        success: true,
        cwd: pty.cwd,
        command: pty.command,
        displayMode,
        output: pty.outputBuffer,
        exited: pty.exited,
        exitCode: pty.exitCode,
      },
      text: `Terminal: ${pty.command || "idle"}`,
      title: pty.command || "Terminal",
    };
  }
);

/**
 * Close a terminal instance.
 */
app.tool(
  "terminal_close",
  {
    description: "Close a terminal instance",
    input: z.object({
      instanceId: z.string().describe("The instance ID"),
    }),
    visibility: ["app"],
  },
  async ({ instanceId }) => {
    const state = app.getInstanceState<TerminalInstanceState>(instanceId);
    if (!state) {
      return {
        data: { success: false, error: "Instance not found" },
        text: "Error: Instance not found",
        isError: true,
      };
    }

    // Close PTY and instance - cleanup happens via onInstanceDestroy
    const result = terminalManager.close({ instanceId });
    app.destroyInstance(instanceId);

    return {
      data: { instanceId, success: result.success, error: result.error },
      text: result.success ? "Terminal closed" : `Error: ${result.error}`,
      isError: !result.success,
    };
  }
);

// =============================================================================
// Server Lifecycle
// =============================================================================

const main = async () => {
  console.log("[Terminal] Starting MCP server");
  await app.start();
  console.log("[Terminal] MCP server ready on port", PORT);
};

const handleShutdown = (signal: string) => {
  console.log(`[Terminal] Received ${signal}, shutting down...`);
  terminalManager.closeAll();
  process.exit(0);
};

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

main().catch((error) => {
  console.error("[Terminal] Failed to start server", error);
  process.exit(1);
});
