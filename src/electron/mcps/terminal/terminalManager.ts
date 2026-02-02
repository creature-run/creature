import * as pty from "node-pty";
import { EventEmitter } from "events";

// =============================================================================
// Environment Configuration
// =============================================================================

/** Prefixes to exclude from child process environment */
const ENV_EXCLUDE_PREFIXES = [
  "ELECTRON_",
  "VITE_",
  "npm_",
  "MCP_",
];

/** Exact keys to exclude from child process environment */
const ENV_EXCLUDE_EXACT = [
  "NODE_ENV",
  "NODE_OPTIONS",
  "TS_NODE_PROJECT",
  "TS_NODE_COMPILER",
  "ELECTRON_RUN_AS_NODE",
  "ATOM_SHELL_INTERNAL_RUN_AS_NODE",
  "ORIGINAL_XDG_CURRENT_DESKTOP",
];

/**
 * Build a clean environment for PTY processes.
 * Removes Electron/Vite-specific variables that could interfere.
 */
const buildCleanEnvironment = ({
  additionalEnv = {},
}: {
  additionalEnv?: Record<string, string>;
} = {}): Record<string, string> => {
  const cleanEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const excludeByPrefix = ENV_EXCLUDE_PREFIXES.some((prefix) =>
      key.startsWith(prefix)
    );
    if (excludeByPrefix) continue;
    if (ENV_EXCLUDE_EXACT.includes(key)) continue;
    cleanEnv[key] = value;
  }

  Object.assign(cleanEnv, additionalEnv);

  cleanEnv.TERM = "xterm-256color";
  cleanEnv.COLORTERM = "truecolor";
  cleanEnv.FORCE_COLOR = "1";
  cleanEnv.NODE_NO_WARNINGS = "1";
  cleanEnv.PROMPT_EOL_MARK = "";

  return cleanEnv;
};

// =============================================================================
// Types
// =============================================================================

export type DisplayMode = "inline" | "pip";
export type TerminalState = "idle" | "running";

/** Internal PTY terminal data */
export interface Terminal {
  id: string;
  pty: pty.IPty;
  outputBuffer: string;
  cwd: string;
  command?: string;
  createdAt: Date;
  displayMode: DisplayMode;
  state: TerminalState;
  exited: boolean;
  exitCode?: number;
  lastCommandStarted?: Date;
  lastOutputAt?: Date;
  /** Buffer for accumulating input until Enter is pressed */
  inputBuffer: string;
  /** Recent commands executed in this terminal (last 5) */
  recentCommands: string[];
}

// =============================================================================
// TerminalManager
// =============================================================================

/**
 * Manages PTY terminal instances.
 * 
 * Each terminal is identified by an `instanceId` which matches the MCP instanceId.
 * Emits events for output, exit, and close.
 */
export class TerminalManager extends EventEmitter {
  private terminals: Map<string, Terminal> = new Map();

  constructor() {
    super();
  }

  /**
   * Get a terminal by instance ID.
   */
  get(instanceId: string): Terminal | undefined {
    return this.terminals.get(instanceId);
  }

  /**
   * Spawn a new PTY terminal.
   */
  spawn(options: {
    id?: string;
    cwd?: string;
    shell?: string;
    command?: string;
    env?: Record<string, string>;
    displayMode?: DisplayMode;
  } = {}): Terminal {
    const id = options.id ?? this.generateId();
    const shell = options.shell || process.env.SHELL || "/bin/bash";
    const cwd = options.cwd || process.cwd();
    const displayMode = options.displayMode || "pip";

    const isInline = displayMode === "inline";
    const shellArgs = isInline && options.command ? ["-c", options.command] : [];

    const cleanEnv = buildCleanEnvironment({ additionalEnv: options.env });

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: cleanEnv,
    });

    const terminal: Terminal = {
      id,
      pty: ptyProcess,
      outputBuffer: "",
      cwd,
      command: options.command,
      createdAt: new Date(),
      displayMode,
      state: options.command ? "running" : "idle",
      exited: false,
      lastCommandStarted: options.command ? new Date() : undefined,
      inputBuffer: "",
      recentCommands: options.command ? [options.command] : [],
    };

    ptyProcess.onData((data) => {
      terminal.outputBuffer += data;
      terminal.lastOutputAt = new Date();

      if (terminal.outputBuffer.length > 100000) {
        terminal.outputBuffer = terminal.outputBuffer.slice(-100000);
      }

      this.emit("output", id, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      terminal.exited = true;
      terminal.exitCode = exitCode;
      terminal.state = "idle";
      this.emit("exit", id, exitCode);
    });

    this.terminals.set(id, terminal);
    this.emit("spawn", id, terminal);

    if (options.command && !isInline) {
      setTimeout(() => {
        ptyProcess.write(options.command + "\n");
      }, 100);
    }

    return terminal;
  }

  /**
   * Write data to a terminal.
   * Tracks input to detect commands when Enter is pressed.
   */
  write(params: { instanceId: string; data: string }): { success: boolean; error?: string; command?: string } {
    const terminal = this.terminals.get(params.instanceId);

    if (!terminal) {
      return { success: false, error: "Terminal not found" };
    }

    if (terminal.exited) {
      return { success: false, error: "Terminal has exited" };
    }

    // Track input for command detection
    let detectedCommand: string | undefined;
    for (const char of params.data) {
      if (char === "\r" || char === "\n") {
        // Enter pressed - capture command if buffer has content
        const command = terminal.inputBuffer.trim();
        if (command) {
          detectedCommand = command;
          terminal.recentCommands.push(command);
          // Keep only last 5 commands
          if (terminal.recentCommands.length > 5) {
            terminal.recentCommands.shift();
          }
          this.emit("command", terminal.id, command);
        }
        terminal.inputBuffer = "";
      } else if (char === "\x7f" || char === "\b") {
        // Backspace - remove last character
        terminal.inputBuffer = terminal.inputBuffer.slice(0, -1);
      } else if (char === "\x03") {
        // Ctrl+C - clear input buffer
        terminal.inputBuffer = "";
      } else if (char >= " " || char === "\t") {
        // Printable character or tab - accumulate
        terminal.inputBuffer += char;
      }
    }

    terminal.pty.write(params.data);
    return { success: true, command: detectedCommand };
  }

  /**
   * Resize a terminal.
   */
  resize(params: { instanceId: string; cols: number; rows: number }): { success: boolean; error?: string } {
    const terminal = this.terminals.get(params.instanceId);

    if (!terminal) {
      return { success: false, error: "Terminal not found" };
    }

    if (terminal.exited) {
      return { success: false, error: "Terminal has exited" };
    }

    terminal.pty.resize(params.cols, params.rows);
    return { success: true };
  }

  /**
   * Read output from a terminal.
   */
  read(params: { instanceId: string }): {
    success: boolean;
    output?: string;
    exited?: boolean;
    exitCode?: number;
    idle?: boolean;
    error?: string;
  } {
    const terminal = this.terminals.get(params.instanceId);

    if (!terminal) {
      return { success: false, error: "Terminal not found" };
    }

    if (terminal.state === "running" && terminal.lastOutputAt) {
      const timeSinceOutput = Date.now() - terminal.lastOutputAt.getTime();
      if (timeSinceOutput > 300) {
        terminal.state = "idle";
      }
    }

    return {
      success: true,
      output: terminal.outputBuffer,
      exited: terminal.exited,
      exitCode: terminal.exited ? terminal.exitCode : undefined,
      idle: terminal.state === "idle",
    };
  }

  /**
   * Wait for a terminal to exit.
   */
  waitForExit(params: { instanceId: string; timeoutMs?: number }): Promise<{
    success: boolean;
    output: string;
    exitCode?: number;
    timedOut?: boolean;
    error?: string;
  }> {
    return new Promise((resolve) => {
      const terminal = this.terminals.get(params.instanceId);

      if (!terminal) {
        resolve({ success: false, output: "", error: "Terminal not found" });
        return;
      }

      if (terminal.exited) {
        resolve({
          success: true,
          output: terminal.outputBuffer,
          exitCode: terminal.exitCode,
        });
        return;
      }

      const timeoutMs = params.timeoutMs ?? 30000;
      let resolved = false;

      const cleanup = () => {
        this.off("exit", onExit);
        clearTimeout(timeout);
      };

      const onExit = (id: string, exitCode: number) => {
        if (id !== params.instanceId || resolved) return;
        resolved = true;
        cleanup();
        resolve({
          success: true,
          output: terminal.outputBuffer,
          exitCode,
        });
      };

      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({
          success: true,
          output: terminal.outputBuffer,
          timedOut: true,
        });
      }, timeoutMs);

      this.on("exit", onExit);
    });
  }

  /**
   * Send SIGINT to a terminal.
   */
  interrupt(params: { instanceId: string }): { success: boolean; error?: string; idle?: boolean } {
    const terminal = this.terminals.get(params.instanceId);

    if (!terminal) {
      return { success: false, error: "Terminal not found" };
    }

    if (terminal.exited) {
      return { success: false, error: "Terminal has exited" };
    }

    terminal.pty.write("\x03");
    terminal.state = "idle";

    return { success: true, idle: true };
  }

  /**
   * Close a terminal.
   */
  close(params: { instanceId: string }): { success: boolean; error?: string } {
    const terminal = this.terminals.get(params.instanceId);

    if (!terminal) {
      return { success: false, error: "Terminal not found" };
    }

    terminal.pty.kill();
    this.terminals.delete(params.instanceId);
    this.emit("close", params.instanceId);

    return { success: true };
  }

  /**
   * List all terminals.
   */
  list(): Array<{
    instanceId: string;
    cwd: string;
    command?: string;
    displayMode: DisplayMode;
    state: TerminalState;
    exited: boolean;
    createdAt: Date;
    outputLength: number;
  }> {
    return Array.from(this.terminals.values()).map((terminal) => ({
      instanceId: terminal.id,
      cwd: terminal.cwd,
      command: terminal.command,
      displayMode: terminal.displayMode,
      state: terminal.state,
      exited: terminal.exited,
      createdAt: terminal.createdAt,
      outputLength: terminal.outputBuffer.length,
    }));
  }

  /**
   * Close all terminals.
   */
  closeAll(): void {
    const ids = Array.from(this.terminals.keys());
    for (const instanceId of ids) {
      this.close({ instanceId });
    }
  }

  /**
   * Generate a unique ID.
   */
  private generateId(): string {
    return `term-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }
}
