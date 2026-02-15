/**
 * Control Plane
 *
 * Manages Pip Instances and routes MCP Apps protocol notifications.
 *
 * ## View-Based Routing
 *
 * Routing is determined by the `views` configuration on UI resources.
 * Views maps URL-like path patterns to tool names:
 *
 * ```typescript
 * views: {
 *   "/": ["notes_list"],                    // Root view, single instance
 *   "/editor": ["notes_create"],            // Creates new, gets identity from response
 *   "/editor/:noteId": ["notes_open", ...]  // One instance per unique noteId
 * }
 * ```
 *
 * Routing priority:
 * 1. Explicit instanceId in args → route to that pip directly
 * 2. Find view path for tool → derive routing behavior from path pattern
 *    - `/` (root) → single instance for root
 *    - `/path` (no params) → creates new instance
 *    - `/path/:param` → one instance per unique param value
 *
 * MCP App developers must set routing params in widgetState.modelContent
 * via setState() (e.g., `modelContent: { noteId: "note_123" }`).
 *
 * IPC Events (main → renderer):
 * - pip:created - Renderer should create iframe and establish AppBridge
 * - pip:closed - Renderer should tear down pip
 * - pip:tool-input - Renderer forwards to iframe as ui/notifications/tool-input
 * - pip:tool-result - Renderer forwards to iframe as ui/notifications/tool-result
 *
 * IPC Events (renderer → main):
 * - pip:ready - Guest UI has completed initialization (sent ui/notifications/initialized)
 *
 * The Control Plane waits for pip:ready before sending tool-input and tool-result.
 * Per MCP Apps spec, Host must send ui/notifications/tool-input after initialization completes.
 */

import { BrowserWindow, app } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readResource, callTool, getTool, getToolsForResourceUri, getResourceUrisForMcp, clearResourceCache, getResourceMetadata, restartMcp, getAllDevMcpInfo, bufferUiError, type ResourceIcon, type Views } from "./client";
import { getPopoutWindow } from "../window/popoutWindows";
import { logAggregator } from "../logging";
import * as browserManager from "../browser";
import type { WidgetState } from "../../shared/types";
import { resolveInstanceIdForTool, type RoutingResult } from "./routing";
import { getCurrentConversation } from "../ipc/chat.handlers";
import { getCurrentSystemPrompt } from "../agent";
import { isPlainObject, normalizePersistedPipState, stripLargeImageData } from "../../lib/utils";

export type { WidgetState };

export interface PersistedPipSnapshot {
  instanceId: string;
  serverName: string;
  resourceUri: string;
  toolName: string;
  title: string;
  createdAt: number;
  triggeredByTool?: boolean;
  openInBackground?: boolean;
  widgetState?: WidgetState;
}

export interface PersistedPipState {
  pips: PersistedPipSnapshot[];
  pipOrder: string[];
  activePipId: string | null;
}

/**
 * BROWSER MCP SPECIAL HANDLING
 *
 * The mcp-browser MCP server is handled specially by the Host.
 * Instead of the MCP server managing the browser, the Host renders
 * a native webview for perfect quality.
 *
 * When browser_create is called:
 * 1. Host creates an instance in browserManager
 * 2. Host returns instanceId to the agent
 * 3. Pip is created with the MCP App (navigation bar only)
 * 4. PipBrowser renders the native webview
 *
 * For other browser tools (navigate, click, etc.):
 * 1. Host forwards the command to the renderer (PipBrowser)
 * 2. PipBrowser executes on the native webview
 * 3. Host returns success to the agent
 */
const BROWSER_MCP_NAME = "browser";

/**
 * DEVKIT MCP SPECIAL HANDLING
 *
 * The devkit MCP server declares tools but their handlers are no-ops.
 * The Host intercepts all devkit tool calls and executes them directly
 * because they require access to Electron APIs (LogAggregator, restartMcp,
 * filesystem) that are unavailable to MCP server child processes.
 */
const DEVKIT_MCP_NAME = "devkit";

/**
 * Parsed TypeScript error from tsc output.
 */
interface TscError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

/**
 * Run `npx tsc --noEmit` in a directory and parse the output into structured errors.
 *
 * Uses `--pretty false` for machine-readable output format:
 *   src/server/tools/items.ts(16,3): error TS2353: Object literal may only specify known properties...
 *
 * Returns an empty errors array when type checking passes.
 * Rejects only on spawn/execution failures, not on type errors (those are returned as data).
 */
const runTypecheck = ({ cwd }: { cwd: string }): Promise<{ errors: TscError[] }> => {
  return new Promise((resolve, reject) => {
    execFile(
      "npx",
      ["tsc", "--noEmit", "--pretty", "false"],
      { cwd, timeout: 30_000, shell: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        // tsc exits with code 2 when there are type errors — that's not a failure
        const output = (stdout || "") + (stderr || "");

        if (err && err.killed) {
          reject(new Error("Typecheck timed out after 30 seconds"));
          return;
        }

        // Parse tsc output lines into structured errors
        // Format: file(line,col): error TSxxxx: message
        const errorPattern = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
        const errors: TscError[] = [];

        for (const line of output.split("\n")) {
          const match = line.trim().match(errorPattern);
          if (match) {
            errors.push({
              file: match[1],
              line: parseInt(match[2], 10),
              col: parseInt(match[3], 10),
              code: match[4],
              message: match[5],
            });
          }
        }

        resolve({ errors });
      }
    );
  });
};

/**
 * Handle devkit tool calls.
 *
 * All devkit tools are executed by the Host, not the MCP server.
 * The MCP server just declares the tools for the protocol.
 *
 * Tools:
 * - devkit_get_logs: Read from LogAggregator
 * - devkit_reload_mcp_app: Restart an MCP App via restartMcp()
 * - devkit_typecheck: Run tsc --noEmit on a dev MCP App
 * - devkit_get_mcp_app_sdk_docs: Read SDK reference from disk
 */
const handleDevkitToolCall = async ({
  toolName,
  args,
}: {
  toolName: string;
  args: Record<string, unknown>;
}): Promise<unknown> => {
  const action = toolName.replace("devkit_", "");

  if (action === "get_logs") {
    const filter = (args.filter as string) || "all";
    const mcpName = args.mcpName as string | undefined;
    const recentCount = 50;

    let logs = logAggregator.getRecent(recentCount);

    // Filter out devkit's own tool call/result logs to prevent infinite loop noise
    logs = logs.filter(
      (entry) => !entry.message.startsWith(`[Tool Call] ${DEVKIT_MCP_NAME}/`) &&
                 !entry.message.startsWith(`[Tool Result] ${DEVKIT_MCP_NAME}/`)
    );

    if (filter === "current_mcp_app" && mcpName) {
      logs = logs.filter((entry) => entry.sourceName === mcpName);
    } else if (filter === "errors") {
      const errorLevels = new Set(["error", "critical", "alert", "emergency"]);
      logs = logs.filter((entry) => errorLevels.has(entry.level));
    }

    const errorCount = logs.filter((entry) => entry.level === "error" || entry.level === "critical").length;
    const summary = `Fetched ${logs.length} log entries (${errorCount} errors)`;

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        type: "logs",
        logs,
        filter,
        mcpName,
        total: logs.length,
      },
    };
  }

  if (action === "reload_mcp_app") {
    const mcpName = args.mcpName as string;
    if (!mcpName) {
      return {
        content: [{ type: "text", text: "Error: mcpName is required" }],
        structuredContent: { type: "refresh", success: false, mcpName: "", error: "mcpName is required" },
        isError: true,
      };
    }

    try {
      await restartMcp({ name: mcpName });
      return {
        content: [{ type: "text", text: `MCP App "${mcpName}" restarted successfully` }],
        structuredContent: { type: "refresh", success: true, mcpName },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{ type: "text", text: `Failed to restart MCP App "${mcpName}": ${errorMessage}` }],
        structuredContent: { type: "refresh", success: false, mcpName, error: errorMessage },
        isError: true,
      };
    }
  }

  if (action === "typecheck") {
    const mcpName = args.mcpName as string;
    if (!mcpName) {
      return {
        content: [{ type: "text", text: "Error: mcpName is required" }],
        structuredContent: { type: "typecheck", success: false, mcpName: "", error: "mcpName is required" },
        isError: true,
      };
    }

    // Find the dev MCP's project directory
    const devMcps = getAllDevMcpInfo();
    const target = devMcps.find((d) => d.name === mcpName);
    if (!target) {
      return {
        content: [{ type: "text", text: `Error: "${mcpName}" is not a development MCP App (available: ${devMcps.map((d) => d.name).join(", ") || "none"})` }],
        structuredContent: { type: "typecheck", success: false, mcpName, error: "Not a dev MCP" },
        isError: true,
      };
    }

    try {
      const result = await runTypecheck({ cwd: target.path });
      if (result.errors.length === 0) {
        return {
          content: [{ type: "text", text: `TypeScript type check passed — no errors in "${mcpName}"` }],
          structuredContent: { type: "typecheck", success: true, mcpName, errors: [] },
        };
      }

      const summary = result.errors
        .map((e) => `${e.file}(${e.line},${e.col}): ${e.code} — ${e.message}`)
        .join("\n");

      return {
        content: [{ type: "text", text: `TypeScript found ${result.errors.length} error(s) in "${mcpName}":\n\n${summary}` }],
        structuredContent: { type: "typecheck", success: false, mcpName, errors: result.errors },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{ type: "text", text: `Failed to run typecheck on "${mcpName}": ${errorMessage}` }],
        structuredContent: { type: "typecheck", success: false, mcpName, error: errorMessage },
        isError: true,
      };
    }
  }

  if (action === "get_mcp_app_sdk_docs") {
    const topics = args.topics as string[] | undefined;
    if (!topics || topics.length === 0) {
      return {
        content: [{ type: "text", text: "Error: topics array is required. Available topics: server, tools, ui-entry, views, callTool, widgetState, styling, storage, onToolResult, development" }],
        structuredContent: { type: "sdk_docs", error: "topics is required" },
        isError: true,
      };
    }

    /**
     * Resolve per-topic SDK doc files from sdk/docs/topics/.
     * Reads all requested topics and concatenates them with headers.
     * Any topic not found is reported inline without failing the whole batch.
     */
    const topicsDir = app.isPackaged
      ? path.join(process.resourcesPath, "docs", "topics")
      : path.join(app.getAppPath(), "artifacts", "sdk", "docs", "topics");

    const sections: string[] = [];
    const results: { topic: string; found: boolean }[] = [];

    for (const topic of topics) {
      const docPath = path.join(topicsDir, `${topic}.md`);
      try {
        const content = fs.readFileSync(docPath, "utf-8");
        sections.push(topics.length > 1 ? `--- ${topic} ---\n\n${content}` : content);
        results.push({ topic, found: true });
      } catch {
        sections.push(`--- ${topic} ---\n\nNo docs found for topic "${topic}".`);
        results.push({ topic, found: false });
      }
    }

    const hasErrors = results.some((r) => !r.found);
    if (hasErrors) {
      let available: string[] = [];
      try {
        available = fs.readdirSync(topicsDir)
          .filter((f: string) => f.endsWith(".md"))
          .map((f: string) => f.replace(".md", ""));
      } catch {
        // Ignore — directory might not exist in packaged builds
      }
      if (available.length > 0) {
        sections.push(`\nAvailable topics: ${available.join(", ")}`);
      }
    }

    return {
      content: [{ type: "text", text: sections.join("\n\n") }],
      structuredContent: { type: "sdk_docs", results },
      ...(hasErrors && results.every((r) => !r.found) ? { isError: true } : {}),
    };
  }

  if (action === "get_component_docs") {
    const components = args.components as string[] | undefined;
    if (!components || components.length === 0) {
      return {
        content: [{ type: "text", text: "Error: components array is required" }],
        structuredContent: { type: "component_docs", error: "components is required" },
        isError: true,
      };
    }

    /**
     * Resolve per-component doc files from sdk-ui/docs/components/.
     * Reads all requested components and concatenates them with headers.
     * Any component not found is reported inline without failing the whole batch.
     */
    const componentDocsDir = app.isPackaged
      ? path.join(process.resourcesPath, "docs", "components")
      : path.join(app.getAppPath(), "artifacts", "sdk-ui", "docs", "components");

    const sections: string[] = [];
    const results: { component: string; found: boolean }[] = [];

    for (const name of components) {
      const docPath = path.join(componentDocsDir, `${name}.md`);
      try {
        const content = fs.readFileSync(docPath, "utf-8");
        sections.push(components.length > 1 ? `--- ${name} ---\n\n${content}` : content);
        results.push({ component: name, found: true });
      } catch {
        sections.push(`--- ${name} ---\n\nNo docs found for component "${name}".`);
        results.push({ component: name, found: false });
      }
    }

    const hasErrors = results.some((r) => !r.found);
    if (hasErrors) {
      let available: string[] = [];
      try {
        available = fs.readdirSync(componentDocsDir)
          .filter((f: string) => f.endsWith(".md"))
          .map((f: string) => f.replace(".md", ""));
      } catch {
        // Ignore — directory might not exist in packaged builds
      }
      if (available.length > 0) {
        sections.push(`\nAvailable components: ${available.join(", ")}`);
      }
    }

    return {
      content: [{ type: "text", text: sections.join("\n\n") }],
      structuredContent: { type: "component_docs", results },
      ...(hasErrors && results.every((r) => !r.found) ? { isError: true } : {}),
    };
  }

  if (action === "get_conversation") {
    const conversation = getCurrentConversation();
    return {
      content: [{ type: "text", text: `Conversation has ${conversation.length} messages` }],
      structuredContent: {
        type: "conversation",
        messages: conversation,
      },
    };
  }

  if (action === "get_system_prompt") {
    const prompt = getCurrentSystemPrompt();
    return {
      content: [{ type: "text", text: prompt }],
      structuredContent: {
        type: "system_prompt",
        prompt,
      },
    };
  }

  return {
    content: [{ type: "text", text: `Unknown devkit tool: ${toolName}` }],
    isError: true,
  };
};

/**
 * Pip Instance represents a rendered UI Resource in pip (picture-in-picture) mode.
 * instanceId is the single identifier for the pip.
 */
export interface PipInstance {
  /** Instance ID - the single identifier for this pip */
  instanceId: string;
  resourceUri: string;
  serverName: string;
  toolName: string;
  title: string;
  htmlContent: string;
  /** Custom icon from resource metadata (_meta.ui.icon) */
  icon?: ResourceIcon;
  createdAt: number;
  ready: boolean;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  /** Widget state set by the Guest UI via setWidgetState() */
  widgetState?: WidgetState;
  /** Cached tool-result for resend on popout/reinit */
  lastToolResult?: {
    toolName: string;
    result: unknown;
    isError: boolean;
    source: "agent" | "ui";
  };
  /** Cached tool-input for resend on popout/reinit */
  lastToolInput?: {
    toolName: string;
    arguments: Record<string, unknown>;
  };
  /**
   * Whether the pip's UI has reported a runtime error.
   * Tracked so the agent can see error state; cleared on reload.
   */
  hasUiError?: boolean;
}

// Pip Instance registry
const pipInstances = new Map<string, PipInstance>();

/**
 * Tracks in-flight pip creation for single-instance resources.
 * Prevents duplicate pips when concurrent tool calls target the same resource.
 *
 * Key: "serverName:resourceUri"
 * Value: The instanceId being created by the first call
 *
 * Set before the tool call executes, cleared after createPipInstance completes.
 * Concurrent calls find the reservation and reuse the instanceId instead of
 * generating a new one, so only one pip is ever created per resource.
 */
const pendingSingleModePips = new Map<string, string>();

/**
 * Event emitted when a new Pip Instance is created.
 * Used to inject into the agent's conversation history so it knows about new pips.
 */
export interface PipCreatedEvent {
  /** Instance ID - the single identifier for this pip */
  instanceId: string;
  /** The resource URI of the pip */
  resourceUri: string;
  /** The MCP server (app) name that provides this tool */
  serverName: string;
  /** The tool that triggered pip creation */
  toolName: string;
  /** Timestamp of creation */
  timestamp: number;
}

// Reference to main window for IPC
let mainWindowRef: BrowserWindow | null = null;

/**
 * Set the main window reference for IPC.
 */
export const setMainWindow = (window: BrowserWindow | null) => {
  mainWindowRef = window;
};

/**
 * Send IPC message to renderer (main window).
 */
const sendToRenderer = (channel: string, data: unknown) => {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, data);
  }
};

/**
 * Send IPC message to the appropriate window for a pip.
 * If the pip is in a popout, sends ONLY to the popout window.
 * Otherwise sends to the main window.
 *
 * IMPORTANT: We don't send to both windows simultaneously because:
 * 1. It causes duplicate processing (e.g., double navigation)
 * 2. The React state for poppedOutPipIds hasn't updated when the popout
 *    calls pipReady, so renderer-side checks fail due to race condition
 *
 * When a pip returns from popout (popout window closes), the popout
 * is removed from the map, so messages go to main window correctly.
 */
const sendToPipWindow = (instanceId: string, channel: string, data: unknown) => {
  const popoutWindow = getPopoutWindow(instanceId);
  
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.webContents.send(channel, data);
  } else {
    sendToRenderer(channel, data);
  }
};


/**
 * Create a new Pip Instance for a UI Resource.
 * Fetches HTML content and notifies the renderer to create iframe.
 * The pip is not ready until the renderer sends pip:ready.
 *
 * @param resourceUri - URI of the UI resource
 * @param serverName - Name of the MCP server
 * @param toolName - Name of the tool that created this pip
 * @param instanceId - Instance ID from SDK (required - SDK generates before handler runs)
 * @param creatureAuth - Creature auth configuration from tool metadata
 * @param triggeredByTool - Whether pip was opened by a tool call (vs user action)
 * @param openInBackground - Whether pip should open in background when another pip is active
 * @param restored - Whether pip is being restored from persisted session state
 * @param initialTitle - Optional initial title for restored pips
 * @param initialWidgetState - Optional initial widget state for restored pips
 * @param createdAt - Optional creation timestamp for restored pips
 */
export const createPipInstance = async ({
  resourceUri,
  serverName,
  toolName,
  instanceId,
  title,
  creatureAuth,
  triggeredByTool = true,
  openInBackground = false,
  restored = false,
  initialTitle = "",
  initialWidgetState,
  createdAt,
}: {
  resourceUri: string;
  serverName: string;
  toolName: string;
  instanceId: string;
  title?: string;
  creatureAuth?: { managed?: boolean };
  triggeredByTool?: boolean;
  openInBackground?: boolean;
  restored?: boolean;
  initialTitle?: string;
  initialWidgetState?: WidgetState;
  createdAt?: number;
}): Promise<PipInstance> => {
  // Fetch HTML content and icon from MCP server
  const { html: htmlContent, icon } = await readResource({
    serverName,
    uri: resourceUri,
  });

  // Create a promise that resolves when the pip is ready
  let resolveReady: () => void = () => {};
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const pip: PipInstance = {
    instanceId,
    resourceUri,
    serverName,
    toolName,
    title: title || deriveResourceTitle(resourceUri),
    htmlContent,
    icon,
    createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? Number(createdAt) : Date.now(),
    ready: false,
    readyPromise,
    resolveReady,
    ...(initialWidgetState ? { widgetState: initialWidgetState } : {}),
  };

  pipInstances.set(pip.instanceId, pip);

  // Tell renderer to create iframe and perform ui/initialize
  sendToRenderer("pip:created", {
    instanceId: pip.instanceId,
    resourceUri: pip.resourceUri,
    htmlContent: pip.htmlContent,
    icon: pip.icon,
    mcpServer: pip.serverName,
    toolName: pip.toolName,
    title: pip.title,
    createdAt: pip.createdAt,
    creatureAuth,
    triggeredByTool,
    openInBackground,
    restored,
  });

  return pip;
};

/**
 * Reconcile pips for an MCP server after reconnection.
 *
 * Structural cleanup only — closes pips whose resourceUri no longer exists
 * (e.g., the MCP app was rewritten with different resources). Does NOT
 * fetch new HTML or touch pip readiness. The caller handles pip reloads
 * separately via refreshAllPipsForMcp after the build completes.
 */
export const reconcilePipsForMcp = async ({ mcpName }: { mcpName: string }): Promise<void> => {
  const pipsForMcp = Array.from(pipInstances.values()).filter(
    (p) => p.serverName === mcpName
  );

  if (pipsForMcp.length === 0) {
    return;
  }

  const validUris = getResourceUrisForMcp(mcpName);
  console.debug(`[PipLifecycle] reconcile ${mcpName}: ${pipsForMcp.length} pip(s), ${validUris.size} valid URI(s)`);

  for (const pip of pipsForMcp) {
    if (!validUris.has(pip.resourceUri)) {
      console.log(`[Control Plane] Closing stale pip (resource no longer exists)`, {
        instanceId: pip.instanceId,
        resourceUri: pip.resourceUri
      });
      pipInstances.delete(pip.instanceId);
      sendToRenderer("pip:closed", pip.instanceId);
    } else {
      console.debug(`[PipLifecycle] reconcile kept pip ${pip.instanceId} (ready=${pip.ready})`);
    }
  }
};

/**
 * Force-reload all pips belonging to a specific MCP server.
 *
 * Unconditionally clears caches and reloads every pip iframe.
 * Called after a dev MCP rebuild completes (detected via "App UI reloaded"
 * in stdout) and after successful MCP reconnection.
 */
export const refreshAllPipsForMcp = async ({ mcpName }: { mcpName: string }): Promise<void> => {
  const pipsForMcp = Array.from(pipInstances.values()).filter(
    (p) => p.serverName === mcpName
  );

  console.debug(`[PipLifecycle] reloadAll ${mcpName}: ${pipsForMcp.length} pip(s)`);

  for (const pip of pipsForMcp) {
    await refreshSinglePip({ instanceId: pip.instanceId });
  }
};

/**
 * Force-reload a single pip's HTML content and icon.
 *
 * Clears the resource cache, re-fetches fresh HTML from the MCP server,
 * and unconditionally sends it to the renderer. No diffing, no size
 * guards — every call produces a clean iframe reload. This eliminates
 * stale-state bugs caused by conditional refresh logic.
 */
export const refreshSinglePip = async ({
  instanceId,
}: {
  instanceId: string;
}): Promise<{ success: boolean; error?: string }> => {
  const pip = pipInstances.get(instanceId);
  if (!pip) {
    return { success: false, error: `Pip not found: ${instanceId}` };
  }

  try {
    clearResourceCache({
      serverName: pip.serverName,
      uri: pip.resourceUri,
    });

    const { html: htmlContent, icon } = await readResource({
      serverName: pip.serverName,
      uri: pip.resourceUri,
    });

    pip.htmlContent = htmlContent;
    pip.icon = icon;
    pip.ready = false;
    pip.hasUiError = false;

    let resolveReady: () => void = () => {};
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    pip.readyPromise = readyPromise;
    pip.resolveReady = resolveReady;

    sendToRenderer("pip:refresh", {
      instanceId: pip.instanceId,
      htmlContent: pip.htmlContent,
      icon: pip.icon,
    });

    console.debug(`[PipLifecycle] Pip reloaded`, { instanceId: pip.instanceId, htmlLength: pip.htmlContent?.length });
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[PipLifecycle] Pip reload failed`, { instanceId, error: errorMessage });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
};

/**
 * Mark a Pip Instance as ready.
 * Called when the renderer notifies that ui/initialize completed.
 *
 * Always resends lastToolInput and lastToolResult when they exist.
 * This handles both initial creation (data set after pip ready) and
 * refresh/popout return (data exists from before reinit).
 */
export const markPipReady = (instanceId: string): boolean => {
  const pip = pipInstances.get(instanceId);
  if (!pip) {
    console.debug(`[PipLifecycle] markReady IGNORED — pip ${instanceId} not found`);
    return false;
  }

  console.debug(`[PipLifecycle] markReady ${instanceId} (wasReady=${pip.ready})`);

  if (!pip.ready) {
    pip.ready = true;
    pip.resolveReady();
  }

  // Resend tool data if it exists (for refresh/popout return scenarios)
  // For initial creation, this data won't exist yet - it gets sent after tool execution
  if (pip.lastToolInput) {
    sendToPipWindow(instanceId, "pip:tool-input", {
      instanceId,
      toolName: pip.lastToolInput.toolName,
      arguments: pip.lastToolInput.arguments,
    });
  }

  if (pip.lastToolResult) {
    sendToPipWindow(instanceId, "pip:tool-result", {
      instanceId,
      toolName: pip.lastToolResult.toolName,
      result: pip.lastToolResult.result,
      isError: pip.lastToolResult.isError,
      source: pip.lastToolResult.source,
    });
  }

  return true;
};

/**
 * Wait for a Pip Instance to be ready.
 *
 * If the pip doesn't exist yet in the registry, polls briefly for it to
 * appear. This handles the race where a concurrent tool call is still
 * creating the pip (see pendingSingleModePips). Once the pip exists,
 * waits for its readyPromise to resolve (renderer sends pip:ready).
 *
 * Non-fatal: returns false on timeout instead of throwing, so callers
 * don't produce unhandled rejections that crash the agent stream.
 * The pip may still become ready later (e.g. after a server restart
 * delivers correct HTML).
 */
const waitForPipReady = async (instanceId: string): Promise<boolean> => {
  let pip = pipInstances.get(instanceId);

  // Pip may not exist yet if a concurrent call is still creating it.
  // Poll briefly for it to appear.
  if (!pip) {
    const MAX_APPEAR_WAIT = 15000;
    const POLL_MS = 50;
    const start = Date.now();
    while (!pip && Date.now() - start < MAX_APPEAR_WAIT) {
      await new Promise(r => setTimeout(r, POLL_MS));
      pip = pipInstances.get(instanceId);
    }
    if (!pip) {
      console.warn(`[PipLifecycle] waitForReady ${instanceId} — pip never appeared`);
      return false;
    }
  }

  if (pip.ready) {
    console.debug(`[PipLifecycle] waitForReady ${instanceId} — already ready`);
    return true;
  }

  console.debug(`[PipLifecycle] waitForReady ${instanceId} — waiting (htmlLength=${pip.htmlContent?.length})`);

  const TIMEOUT = 15000;
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), TIMEOUT);
  });

  try {
    const result = await Promise.race([
      pip.readyPromise.then(() => "ready" as const),
      timeoutPromise,
    ]);

    if (result === "timeout") {
      console.warn(`[PipLifecycle] waitForReady ${instanceId} — timed out (${TIMEOUT}ms), pip may recover later`);
      return false;
    }

    console.debug(`[PipLifecycle] waitForReady ${instanceId} — resolved`);
    return true;
  } finally {
    clearTimeout(timeoutId!);
  }
};

/**
 * Event emitted when a pip is destroyed.
 * Used to inject a message into the conversation history so the agent
 * knows the pip is no longer valid.
 */
export interface PipDestroyedEvent {
  /** Instance ID of the pip that was destroyed */
  instanceId: string;
  /** The resource URI of the pip */
  resourceUri: string;
  /** The MCP server (app) name that provided this tool */
  serverName: string;
  /** The tool that created the pip */
  toolName: string;
  /** Timestamp of destruction */
  timestamp: number;
}

/**
 * Close a Pip Instance.
 *
 * Per MCP Apps spec (SEP-1865), the proper cleanup flow is:
 * 1. Send ui/resource-teardown request to the UI iframe
 * 2. Wait for the iframe to respond (graceful termination)
 * 3. Then tear down the pip
 *
 * The renderer handles sending ui/resource-teardown to the iframe.
 * We send pip:teardown to initiate this, then pip:closed after confirmation.
 */
export const closePipInstance = async (instanceId: string): Promise<boolean> => {
  const pip = pipInstances.get(instanceId);
  if (!pip) {
    return false;
  }

  console.debug(`[Control Plane] Closing pip`, { instanceId });

  // Request teardown - renderer will send ui/resource-teardown to iframe
  // and call pip:teardown-complete when done
  sendToPipWindow(instanceId, "pip:teardown", {
    instanceId,
    reason: "Pip closed by user",
  });

  // Wait for teardown confirmation with timeout
  try {
    await waitForTeardownComplete(instanceId);
  } catch (_error) {
    // Timeout is acceptable - proceed with closure
  }

  // Capture pip info before deletion for the destroyed event
  const destroyedEvent: PipDestroyedEvent = {
    instanceId: pip.instanceId,
    resourceUri: pip.resourceUri,
    serverName: pip.serverName,
    toolName: pip.toolName,
    timestamp: Date.now(),
  };

  pipInstances.delete(instanceId);
  console.debug(`[Control Plane] Pip closed`, { instanceId });

  // Tell renderer to tear down the pip UI
  sendToRenderer("pip:closed", instanceId);

  // Emit destroyed event for conversation history injection
  // This tells the agent that this pip is no longer valid
  sendToRenderer("pip:destroyed", destroyedEvent);

  return true;
};

// Track pending teardown completions
const teardownPromises = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

/**
 * Wait for a pip teardown to complete.
 * Times out after 5 seconds to prevent hanging.
 */
const waitForTeardownComplete = (instanceId: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const TIMEOUT = 5000;

    teardownPromises.set(instanceId, { resolve, reject });

    setTimeout(() => {
      if (teardownPromises.has(instanceId)) {
        teardownPromises.delete(instanceId);
        reject(new Error(`Teardown timeout: ${instanceId}`));
      }
    }, TIMEOUT);
  });
};

/**
 * Mark a pip teardown as complete.
 * Called by the renderer after the iframe responds to ui/resource-teardown.
 */
export const markTeardownComplete = (instanceId: string): void => {
  const pending = teardownPromises.get(instanceId);
  if (pending) {
    teardownPromises.delete(instanceId);
    pending.resolve();
  }
};

/**
 * Get all active Pip Instances.
 */
export const getPipInstances = (): PipInstance[] => {
  return Array.from(pipInstances.values());
};

/**
 * Get a Pip Instance by ID.
 */
export const getPipInstance = (instanceId: string): PipInstance | undefined => {
  return pipInstances.get(instanceId);
};

/**
 * Mark all pips for a given MCP server as having a UI error.
 * Called when the renderer reports a runtime error from the iframe.
 * Tracked for visibility; the next reload clears the flag.
 */
export const markPipUiError = ({ serverName }: { serverName: string }): void => {
  for (const pip of pipInstances.values()) {
    if (pip.serverName === serverName) {
      pip.hasUiError = true;
    }
  }
};

/**
 * Update a pip's title.
 * Used by browser pips to sync the webpage title to the pip tab.
 */
export const updatePipTitle = ({
  instanceId,
  title,
}: {
  instanceId: string;
  title: string;
}): boolean => {
  const pip = pipInstances.get(instanceId);
  if (!pip) return false;

  if (pip.title !== title) {
    pip.title = title;
    sendToPipWindow(instanceId, "pip:title-changed", { instanceId, title });
  }

  return true;
};

/**
 * Update a pip's widget state.
 * Called when the Guest UI sends a widget-state-changed notification.
 * The modelContent is included in the system prompt for AI continuity.
 *
 * @param instanceId - The pip instanceId to update
 * @param widgetState - The new widget state (or null to clear)
 * @returns true if the pip was found and updated
 */
export const updatePipWidgetState = ({
  instanceId,
  widgetState,
}: {
  instanceId: string;
  widgetState: WidgetState | null;
}): boolean => {
  const pip = pipInstances.get(instanceId);
  if (!pip) return false;

  if (widgetState) {
    pip.widgetState = widgetState;
  } else {
    delete pip.widgetState;
  }

  return true;
};

/**
 * Get a pip's widget state.
 * Used to pass widget state to popout windows for reinstantiation.
 *
 * @param instanceId - The pip instanceId to query
 * @returns The widget state or null if not found
 */
export const getPipWidgetState = ({
  instanceId,
}: {
  instanceId: string;
}): WidgetState | null => {
  const pip = pipInstances.get(instanceId);
  return pip?.widgetState ?? null;
};

/**
 * Find all Pip Instances by serverName.
 * Used for broadcasting state changes to all pips from the same MCP server.
 * For example, when an inline todo_add action happens, all pips
 * for that MCP server should receive the update.
 */
export const findPipsByServerName = (serverName: string): PipInstance[] => {
  const pips: PipInstance[] = [];
  for (const pip of pipInstances.values()) {
    if (pip.serverName === serverName) {
      pips.push(pip);
    }
  }
  return pips;
};

/**
 * Launch a pip for a UI resource directly (without a tool call).
 * If a pip already exists for this resource, returns its instanceId to focus it.
 * Otherwise creates a new pip.
 *
 * This is used by the sidebar to open MCP App pips without going through a tool call.
 */
export const launchResourcePip = async ({
  serverName,
  resourceUri,
}: {
  serverName: string;
  resourceUri: string;
}): Promise<{ success: boolean; instanceId?: string; isExisting?: boolean; error?: string }> => {
  // Check if a pip already exists for this resourceUri
  for (const pip of pipInstances.values()) {
    if (pip.resourceUri === resourceUri && pip.serverName === serverName) {
      // Found existing pip - return it to be focused
      return { success: true, instanceId: pip.instanceId, isExisting: true };
    }
  }

  // No existing pip - create a new one
  // Generate instanceId (matches SDK format for consistency)
  const instanceId = `inst_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  try {
    const resourceName = resourceUri.split("/").pop() || "App";

    const pip = await createPipInstance({
      resourceUri,
      serverName,
      toolName: resourceName,
      instanceId,
      triggeredByTool: false,
    });

    return { success: true, instanceId: pip.instanceId, isExisting: false };
  } catch (error) {
    console.error(`[Control Plane] Failed to launch resource pip:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
};

/**
 * Close all Pip Instances.
 * Called when project closes to clean up all pips.
 * This prevents stale pips from being reused when a new project loads.
 */
export const closeAllPips = async (): Promise<void> => {
  const pipsToClose = Array.from(pipInstances.values());
  if (pipsToClose.length === 0) return;

  console.debug(`[Control Plane] Closing all pips (${pipsToClose.length} total)`);
  
  // Close all pips in parallel with timeout
  const closePromises = pipsToClose.map(async (pip) => {
    try {
      await closePipInstance(pip.instanceId);
    } catch (e) {
      // Force remove from map if close fails
      console.warn(`[Control Plane] Failed to close pip ${pip.instanceId}, force removing`);
      pipInstances.delete(pip.instanceId);
    }
  });

  // Wait for all with a timeout
  await Promise.race([
    Promise.all(closePromises),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);

  // Force clear any remaining pips
  if (pipInstances.size > 0) {
    console.warn(`[Control Plane] Force clearing ${pipInstances.size} remaining pips`);
    pipInstances.clear();
  }
};

export interface RestorePipsResult {
  restoredInstanceIds: string[];
  skipped: Array<{ instanceId: string; reason: string }>;
  activePipId: string | null;
}

/**
 * Restore PIP tabs from persisted session state.
 * Restores tabs as docked (not popped out), preserving instance IDs and widget state.
 */
export const restorePips = async ({
  pipState,
}: {
  pipState: PersistedPipState;
}): Promise<RestorePipsResult> => {
  const normalized = normalizePersistedPipState({ value: pipState });
  if (normalized.pips.length === 0) {
    return {
      restoredInstanceIds: [],
      skipped: [],
      activePipId: null,
    };
  }

  const snapshotByInstanceId = new Map(
    normalized.pips.map((snapshot) => [snapshot.instanceId, snapshot])
  );

  const orderedSnapshots: PersistedPipSnapshot[] = [];
  for (const instanceId of normalized.pipOrder) {
    const snapshot = snapshotByInstanceId.get(instanceId);
    if (snapshot) {
      orderedSnapshots.push(snapshot);
      snapshotByInstanceId.delete(instanceId);
    }
  }
  for (const snapshot of snapshotByInstanceId.values()) {
    orderedSnapshots.push(snapshot);
  }

  const restoredInstanceIds: string[] = [];
  const skipped: Array<{ instanceId: string; reason: string }> = [];

  for (const snapshot of orderedSnapshots) {
    const existing = pipInstances.get(snapshot.instanceId);
    if (existing) {
      try {
        const { html: htmlContent, icon } = await readResource({
          serverName: snapshot.serverName,
          uri: snapshot.resourceUri,
        });

        let resolveReady: () => void = () => {};
        const readyPromise = new Promise<void>((resolve) => {
          resolveReady = resolve;
        });

        existing.resourceUri = snapshot.resourceUri;
        existing.serverName = snapshot.serverName;
        existing.toolName = snapshot.toolName;
        existing.title = snapshot.title;
        existing.htmlContent = htmlContent;
        existing.icon = icon;
        existing.createdAt = snapshot.createdAt;
        existing.ready = false;
        existing.readyPromise = readyPromise;
        existing.resolveReady = resolveReady;

        if (snapshot.widgetState) {
          existing.widgetState = snapshot.widgetState;
        } else {
          delete existing.widgetState;
        }

        sendToRenderer("pip:created", {
          instanceId: existing.instanceId,
          resourceUri: existing.resourceUri,
          htmlContent: existing.htmlContent,
          icon: existing.icon,
          mcpServer: existing.serverName,
          toolName: existing.toolName,
          title: existing.title,
          createdAt: existing.createdAt,
          triggeredByTool: snapshot.triggeredByTool ?? false,
          openInBackground: snapshot.openInBackground ?? false,
          restored: true,
        });

        restoredInstanceIds.push(existing.instanceId);
      } catch (error) {
        skipped.push({
          instanceId: snapshot.instanceId,
          reason:
            error instanceof Error
              ? error.message
              : "Failed to restore pip",
        });
      }
      continue;
    }

    try {
      await createPipInstance({
        resourceUri: snapshot.resourceUri,
        serverName: snapshot.serverName,
        toolName: snapshot.toolName,
        instanceId: snapshot.instanceId,
        triggeredByTool: snapshot.triggeredByTool ?? false,
        openInBackground: snapshot.openInBackground ?? false,
        restored: true,
        initialTitle: snapshot.title,
        initialWidgetState: snapshot.widgetState,
        createdAt: snapshot.createdAt,
      });
      restoredInstanceIds.push(snapshot.instanceId);
    } catch (error) {
      skipped.push({
        instanceId: snapshot.instanceId,
        reason: error instanceof Error ? error.message : "Failed to restore pip",
      });
    }
  }

  const activePipId =
    normalized.activePipId && restoredInstanceIds.includes(normalized.activePipId)
      ? normalized.activePipId
      : restoredInstanceIds[0] || null;

  return {
    restoredInstanceIds,
    skipped,
    activePipId,
  };
};

// =============================================================================
// View-Based Routing Logic (imported from ./routing.ts)
// =============================================================================

// =============================================================================
// Tool Result Helpers
// =============================================================================

/**
 * Describe which structured payload fields are present in a tool result.
 *
 * This is used to validate UI tool responses without assuming a specific shape.
 */
const describeToolResultShape = ({
  result,
}: {
  result: unknown;
}): { hasStructuredContent: boolean; hasData: boolean } => {
  if (!isPlainObject({ value: result })) {
    return { hasStructuredContent: false, hasData: false };
  }

  return {
    hasStructuredContent: Object.prototype.hasOwnProperty.call(result, "structuredContent"),
    hasData: Object.prototype.hasOwnProperty.call(result, "data"),
  };
};

/**
 * Build a structured error result for tool output shape mismatches.
 *
 * This is returned to the caller and used to keep the UI from consuming
 * incompatible data shapes that would cause runtime errors.
 */
const buildToolResultShapeError = ({
  serverName,
  toolName,
  expectedShape,
  actualShape,
}: {
  serverName: string;
  toolName: string;
  expectedShape: string;
  actualShape: string;
}) => {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Tool result shape mismatch for ${serverName}/${toolName}. Expected ${expectedShape}, got ${actualShape}.`,
      },
    ],
    structuredContent: {
      error: "tool_result_shape_mismatch",
      expectedShape,
      actualShape,
      serverName,
      toolName,
    },
  };
};

/**
 * Validate tool result shapes for UI tools and return a safe payload.
 *
 * UI tools should return structured data for view routing and rendering.
 */
const validateToolResultShape = ({
  result,
  serverName,
  toolName,
  resourceUri,
}: {
  result: unknown;
  serverName: string;
  toolName: string;
  resourceUri?: string;
}): { result: unknown; errorMessage: string | null } => {
  if (!resourceUri) {
    return { result, errorMessage: null };
  }

  const { hasStructuredContent, hasData } = describeToolResultShape({ result });
  if (hasData && !hasStructuredContent) {
    const errorMessage = `Tool result missing structuredContent for ${serverName}/${toolName}. UI tools must return structuredContent (data is not consumed by useViews).`;
    return {
      result: buildToolResultShapeError({
        serverName,
        toolName,
        expectedShape: "structuredContent",
        actualShape: "data",
      }),
      errorMessage,
    };
  }

  return { result, errorMessage: null };
};

/**
 * Extract instanceId from an MCP tool result.
 * Looks in structuredContent.instanceId first, then parses content[0].text as JSON.
 *
 * Tools with UI return `instanceId` in their responses to identify
 * which instance the result belongs to.
 */
const extractInstanceId = (result: unknown): string | undefined => {
  if (!result || typeof result !== "object") return undefined;

  const r = result as Record<string, unknown>;

  // Check structuredContent.instanceId first (preferred location)
  if (r.structuredContent && typeof r.structuredContent === "object") {
    const sc = r.structuredContent as Record<string, unknown>;
    if (typeof sc.instanceId === "string") {
      return sc.instanceId;
    }
  }

  // Fallback: parse content[0].text as JSON
  if (Array.isArray(r.content) && r.content.length > 0) {
    const first = r.content[0];
    if (first && typeof first === "object" && first.type === "text" && typeof first.text === "string") {
      try {
        const parsed = JSON.parse(first.text);
        if (typeof parsed.instanceId === "string") {
          return parsed.instanceId;
        }
      } catch {
        // Not JSON, ignore
      }
    }
  }

  return undefined;
};

/**
 * Derive a human-readable title from a resource URI.
 * Extracts the last segment, replaces dashes/underscores with spaces,
 * and capitalizes the first letter.
 *
 * e.g. "ui://devkit/devkit" -> "Devkit", "ui://browser/main" -> "Main"
 */
const deriveResourceTitle = (resourceUri: string): string => {
  const segment = resourceUri.split("/").pop() || "App";
  const formatted = segment.replace(/[-_]/g, " ");
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
};

/**
 * Extract title from an MCP tool result's structuredContent.
 * Per MCP Apps spec, structuredContent contains structured data for UI rendering.
 *
 * Any MCP can return a `title` field in structuredContent to update the pip title.
 * This provides a generic interface for all MCPs to control their pip's display title.
 */
const extractTitle = (result: unknown): string | undefined => {
  if (!result || typeof result !== "object") return undefined;

  const r = result as Record<string, unknown>;

  // Check structuredContent.title (preferred location per MCP Apps spec)
  if (r.structuredContent && typeof r.structuredContent === "object") {
    const sc = r.structuredContent as Record<string, unknown>;
    if (typeof sc.title === "string" && sc.title.length > 0) {
      return sc.title;
    }
  }

  return undefined;
};

/**
 * Handle browser tool calls.
 *
 * Browser tools are executed by the Host, not the MCP server.
 * The MCP server just declares the tools - the Host manages the native webview.
 *
 * For browser_create:
 * - Create an instance in browserManager
 * - Return success with instanceId
 *
 * For other browser tools:
 * - Forward the command to the renderer (PipBrowser)
 * - PipBrowser executes on the native webview
 */
const handleBrowserToolCall = async ({
  toolName,
  args,
  instanceId: inputInstanceId,
}: {
  toolName: string;
  args: Record<string, unknown>;
  instanceId?: string;
}): Promise<unknown> => {
  const action = toolName.replace("browser_", "");

  if (action === "create") {
    // Create a new browser instance
    const url = (args.url as string) || "about:blank";

    // Generate instanceId if not provided (matches SDK format for consistency)
    const instanceId = inputInstanceId || `inst_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    browserManager.createInstance({
      instanceId,
      url,
    });

    // Return instanceId for routing - Host will create pip based on this
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, instanceId, url }) }],
      structuredContent: {
        instanceId,
        url,
        title: "New Browser",
      },
    };
  }

  // For other browser tools, forward to the renderer
  // The agent passes instanceId which routes to the pip
  const instanceId = args.instanceId as string;
  if (!instanceId) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: "instanceId required" }) }],
      structuredContent: { success: false, error: "instanceId required" },
    };
  }

  const instance = browserManager.getInstance(instanceId);
  if (!instance) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: "Instance not found" }) }],
      structuredContent: { success: false, error: "Instance not found" },
    };
  }

  // Forward command to renderer
  await browserManager.executeCommand({
    instanceId,
    command: {
      action,
      url: args.url as string | undefined,
      x: args.x as number | undefined,
      y: args.y as number | undefined,
      selector: args.selector as string | undefined,
      text: args.text as string | undefined,
      direction: args.direction as "up" | "down" | undefined,
      amount: args.amount as number | undefined,
      fullPage: args.fullPage as boolean | undefined,
    },
  });

  // TEMPORARILY DISABLED: Screenshot tool is disabled
  // if (action === "screenshot") {
  //   // Screenshot is handled asynchronously by PipBrowser
  //   // For now, return a placeholder - the actual screenshot will be sent via IPC
  //   return {
  //     content: [{ type: "text", text: "Screenshot requested - see browser pip" }],
  //     structuredContent: { success: true, action: "screenshot" },
  //   };
  // }

  return {
    content: [{ type: "text", text: JSON.stringify({ success: true, action }) }],
    structuredContent: { success: true, action, instanceId },
  };
};

/**
 * Wrapper around routing.resolveInstanceIdForTool that provides
 * the pipInstances map and logging.
 */
const resolveInstanceIdForToolCall = ({
  serverName,
  toolName,
  args,
  resourceUri,
}: {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  resourceUri: string;
}): RoutingResult => {
  const resourceMeta = getResourceMetadata({ serverName, uri: resourceUri });

  const result = resolveInstanceIdForTool({
    pipInstances: pipInstances.values(),
    getPipById: (id) => pipInstances.get(id),
    resourceMetadata: resourceMeta,
    serverName,
    toolName,
    args,
    resourceUri,
  });

  return result;
};

/**
 * Handle a tool call from the Agent or UI.
 *
 * Pip Routing Flow (control plane owns instanceId):
 * 1. Resolve instanceId based on views config BEFORE calling the tool
 * 2. Inject instanceId into args when calling the SDK
 * 3. Execute tool on MCP server
 * 4. Create pip if needed (for new instanceIds)
 * 5. Send ui/notifications/tool-input and tool-result to pip
 *
 * The control plane generates instanceId because it knows about views routing.
 * The SDK receives instanceId and uses it for state management only.
 *
 * Source Tracking:
 * - 'agent': Tool call initiated by the AI agent (already in conversation history via AI SDK)
 * - 'ui': Tool call initiated by user interaction with a Pip (needs to be injected into history)
 *
 * @returns Tool result from MCP server
 */
export const handleToolCall = async ({
  serverName,
  toolName,
  args,
  instanceId: callerInstanceId,
  source = "agent",
}: {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Only used for UI-initiated calls to identify which instance made the call */
  instanceId?: string;
  /** Source of the tool call - 'agent' for AI-initiated, 'ui' for user pip interaction */
  source?: "agent" | "ui";
}) => {
  // Skip logging for devkit tools to prevent infinite loops.
  // Devkit reads from the same log aggregator it would write to,
  // so logging its own calls would create recursive noise.
  const isDevkitTool = serverName === DEVKIT_MCP_NAME;

  // Log tool call input to Dev Console
  if (!isDevkitTool) {
    logAggregator.log({
      source: "host",
      level: "info",
      message: `[Tool Call] ${serverName}/${toolName} (${source}) Input: ${JSON.stringify(args)}`,
    });
  }

  // Get tool metadata to check for UI Resource
  const toolDef = getTool(serverName, toolName);
  const resourceUri = toolDef?.resourceUri;

  // Determine display mode from args.displayMode.
  // All MCPs must use "displayMode" as the standardized parameter name.
  const requestedDisplayMode = typeof args.displayMode === "string" ? args.displayMode : undefined;
  const displayMode = requestedDisplayMode || toolDef?.defaultDisplayMode || "pip";
  const isInlineMode = displayMode === "inline" && source === "agent";

  let targetInstanceId = callerInstanceId;
  let isNewPip = false;
  let isReusingReadyPip = false;

  // Determine if we should create/manage a pip:
  // - Agent-initiated calls with pip mode (not inline mode)
  // - UI-initiated calls WITHOUT instanceId (from inline widgets) with pip mode
  //   This handles the "expand to pip" action from inline widgets.
  //
  // NOTE: UI-initiated calls FROM a pip (with callerInstanceId) do NOT create new pips.
  // The result is returned to the calling pip, which handles view switching client-side.
  // This keeps pip management simple - only agents can spawn new pips.
  const shouldManagePip = resourceUri && !isInlineMode && (
    source === "agent" ||
    (source === "ui" && !callerInstanceId && displayMode === "pip")
  );

  // Resolve instanceId BEFORE calling the tool (control plane owns routing)
  if (shouldManagePip && resourceUri) {
    const resolved = resolveInstanceIdForToolCall({
      serverName,
      toolName,
      args,
      resourceUri,
    });

    // Skip pip management if routing returned an error
    if (!resolved.error && resolved.instanceId) {
      targetInstanceId = resolved.instanceId;
      // Cast to PipInstance since pipInstances map stores full PipInstance objects
      const existingPip = resolved.existingPip as PipInstance | undefined;
      isReusingReadyPip = existingPip?.ready ?? false;

      // If no existing pip, we'll create one after the tool call
      if (!existingPip) {
        isNewPip = true;
      }
    }
  }

  // Guard against duplicate pips for single-instance resources.
  // When parallel tool calls all resolve to "create new pip", only the first
  // one should actually create it. Subsequent calls reuse the in-flight instanceId.
  let ownsPendingReservation = false;

  if (isNewPip && shouldManagePip && resourceUri && targetInstanceId) {
    const resourceMeta = getResourceMetadata({ serverName, uri: resourceUri });
    const instanceMode = resourceMeta?.instanceMode ?? "single";

    if (instanceMode === "single") {
      const key = `${serverName}:${resourceUri}`;
      const pendingId = pendingSingleModePips.get(key);

      if (pendingId) {
        // Another call is already creating a pip for this resource — piggyback
        targetInstanceId = pendingId;
        isNewPip = false;
        isReusingReadyPip = false;
      } else {
        // First concurrent call — claim the reservation
        pendingSingleModePips.set(key, targetInstanceId);
        ownsPendingReservation = true;
      }
    }
  }

  // Execute tool on MCP server with instanceId in args
  // SPECIAL HANDLING: Browser and Devkit MCP tools are executed by the Host
  let result: unknown;

  if (serverName === BROWSER_MCP_NAME && toolName.startsWith("browser_")) {
    result = await handleBrowserToolCall({
      toolName,
      args,
      instanceId: targetInstanceId,
    });
  } else if (serverName === DEVKIT_MCP_NAME && toolName.startsWith("devkit_")) {
    result = await handleDevkitToolCall({ toolName, args });
  } else {
    // Inject _source and _instanceId into args
    // The SDK uses _instanceId for state management and WebSocket routing
    // Note: _instanceId is injected whenever we have a targetInstanceId and resourceUri,
    // regardless of shouldManagePip (which only controls pip CREATION)
    const shouldInjectInstanceId = targetInstanceId && resourceUri;
    const argsWithContext = {
      ...args,
      _source: source,
      ...(shouldInjectInstanceId ? { _instanceId: targetInstanceId } : {}),
    };

    result = await callTool({ serverName, toolName, args: argsWithContext });
  }

  // Log tool call result to Dev Console (skip devkit to prevent infinite loops)
  if (!isDevkitTool) {
    logAggregator.log({
      source: "host",
      level: "info",
      message: `[Tool Result] ${serverName}/${toolName} Output: ${JSON.stringify(result)}`,
    });
  }

  const validation = validateToolResultShape({
    result,
    serverName,
    toolName,
    resourceUri,
  });

  if (validation.errorMessage) {
    bufferUiError({ serverName, message: validation.errorMessage });
  }

  result = validation.result;

  // Create pip if needed (for new instanceIds)
  try {
    if (shouldManagePip && resourceUri && targetInstanceId && isNewPip) {
      await createPipInstance({
        resourceUri,
        serverName,
        toolName,
        instanceId: targetInstanceId,
        creatureAuth: toolDef?.creatureAuth,
        openInBackground: toolDef?.openInBackground,
      });
    }
  } finally {
    // Release the single-mode reservation so future calls find the real pip
    // in pipInstances. Must run even if createPipInstance throws, otherwise
    // the stale reservation would block all future calls for this resource.
    if (ownsPendingReservation && resourceUri) {
      pendingSingleModePips.delete(`${serverName}:${resourceUri}`);
    }
  }

  // Per MCP Apps spec, Host MUST send ui/notifications/tool-input after Guest's
  // initialize request completes. Queue this to be sent when pip is ready.
  if (shouldManagePip && targetInstanceId) {
    const instanceId = targetInstanceId;
    const targetPip = pipInstances.get(instanceId);
    
    // Store tool-input for resend on reinit (popout close, refresh)
    if (targetPip) {
      targetPip.lastToolInput = { toolName, arguments: args || {} };
    }
    
    const toolInputPayload = {
      instanceId,
      toolName,
      arguments: args || {},
    };
    
    // If reusing an already-ready pip, send immediately (no waitForPipReady needed).
    // Otherwise wait for pip to become ready (new pip or pip still loading).
    if (isReusingReadyPip) {
      sendToPipWindow(instanceId, "pip:tool-input", toolInputPayload);
    } else {
      waitForPipReady(instanceId).then((ready) => {
        if (ready) {
          sendToPipWindow(instanceId, "pip:tool-input", toolInputPayload);
        } else {
          console.warn(`[Control Plane] Skipping tool-input for ${instanceId} — pip not ready`);
        }
      }).catch((err) => {
        console.error(`[Control Plane] waitForPipReady failed for tool-input`, { instanceId, error: String(err) });
      });
    }
  }

  // Extract title from MCP result's structuredContent.
  // Per MCP Apps spec, any MCP can return a `title` field to update the pip title.
  // This provides a generic interface for all MCPs to control their pip's display.
  //
  // Only update the title if the tool's resourceUri matches the pip's resourceUri.
  // This prevents inline tools (e.g., todo_toggle with resourceUri "todo-card") from
  // incorrectly updating the pip's title (e.g., "todos") when called from its UI.
  //
  // MCP Apps that need title updates after mutations should call their list/refresh
  // tool which will return the correct title for that resource.
  if (targetInstanceId && resourceUri) {
    const pip = pipInstances.get(targetInstanceId);
    const extractedTitle = extractTitle(result);
    
    // Only update title if resource URIs match (prevents inline tools from updating pip titles)
    if (pip && extractedTitle && pip.resourceUri === resourceUri) {
      updatePipTitle({ instanceId: targetInstanceId, title: extractedTitle });
    }
  }

  // If a new pip was created, emit event for conversation history injection.
  if (isNewPip && targetInstanceId && resourceUri) {
    const createdEvent: PipCreatedEvent = {
      instanceId: targetInstanceId,
      resourceUri,
      serverName,
      toolName,
      timestamp: Date.now(),
    };
    sendToRenderer("pip:created-history", createdEvent);
  }

  // Send tool-result notification to the pip if:
  // - Agent-initiated call with UI resource (routes to target pip based on views config)
  // - UI-initiated call that created a new pip (expand from inline to pip)
  //
  // Queue this to be sent when pip is ready (non-blocking).
  // This ensures the streaming isn't disrupted while still delivering
  // notifications to the pip.
  if (resourceUri && targetInstanceId && (source === "agent" || isNewPip)) {
    const instanceId = targetInstanceId;
    const toolResultPayload = {
      instanceId,
      toolName,
      result,
      isError: false,
      source, // Include source so UI can distinguish agent vs UI calls
    };

    const targetPip = pipInstances.get(instanceId);
    if (targetPip) {
      // Store tool-result for resend on popout/reinit
      targetPip.lastToolResult = { toolName, result, isError: false, source };
    }

    // If reusing an already-ready pip, send immediately (no waitForPipReady needed).
    // Otherwise wait for pip to become ready (new pip or pip still loading).
    if (isReusingReadyPip) {
      sendToPipWindow(instanceId, "pip:tool-result", toolResultPayload);
    } else {
      waitForPipReady(instanceId).then((ready) => {
        if (ready) {
          sendToPipWindow(instanceId, "pip:tool-result", toolResultPayload);
        } else {
          console.warn(`[Control Plane] Skipping tool-result for ${instanceId} — pip not ready`);
        }
      }).catch((err) => {
        console.error(`[Control Plane] waitForPipReady failed for tool-result`, { instanceId, error: String(err) });
      });
    }
  }

  // For UI-initiated calls from a pip, send tool-result back to the calling pip.
  // This enables SPA-like behavior where the pip's useViews hook can switch views
  // based on the tool result. The pip handles view transitions client-side.
  // Note: This is separate from agent routing - UI calls always return to caller.
  if (source === "ui" && callerInstanceId && resourceUri) {
    const callerPip = pipInstances.get(callerInstanceId);
    if (callerPip) {
      // Store tool-result for resend on popout/reinit (preserves view state)
      callerPip.lastToolResult = { toolName, result, isError: false, source };
      callerPip.lastToolInput = { toolName, arguments: args || {} };

      const toolResultPayload = {
        instanceId: callerInstanceId,
        toolName,
        result,
        isError: false,
        source,
      };
      // Caller pip should already be ready (user just clicked in it)
      sendToPipWindow(callerInstanceId, "pip:tool-result", toolResultPayload);
    }
  }

  // NOTE: UI-initiated tool calls are NOT injected into conversation history.
  // Per MCP Apps spec, UI tool results stay in the UI. If the UI needs the model
  // to know about user actions, it should use ui/update-model-context explicitly.
  // This prevents context bloat from UI interactions (file browsing, pagination, etc.)

  // For inline mode, add metadata so the renderer knows to display inline widget.
  // IMPORTANT: Do NOT include htmlContent here - it would bloat conversation history
  // and exceed API token limits. The InlineWidget fetches HTML via IPC instead.
  if (isInlineMode && resourceUri) {
    // Broadcast tool-result to all pips for the same server ONLY for single-instance tools.
    // This allows the pip (e.g., todo list) to update when an inline action
    // (e.g., todo_add confirmation) happens. The pips share the same MCP server state.
    //
    // For multi-instance tools (those with instanceId in result), each instance is
    // independent so we skip broadcasting.
    const instanceIdFromResult = extractInstanceId(result);
    const isMultiInstance = !!instanceIdFromResult;

    if (!isMultiInstance) {
      const pips = findPipsByServerName(serverName);
      for (const pip of pips) {
        sendToPipWindow(pip.instanceId, "pip:tool-result", {
          instanceId: pip.instanceId,
          toolName,
          result,
          isError: false,
          source: "agent", // Inline mode is always agent-initiated
        });
      }
    }

    const resultObj = result as Record<string, unknown>;
    // Strip large image data to prevent token limit errors
    const sanitizedResult = stripLargeImageData({ result: resultObj });
    return {
      ...(sanitizedResult as Record<string, unknown>),
      _inlineDisplay: {
        resourceUri,
        serverName,
        toolName,
        displayModes: toolDef?.displayModes || ["pip"],
        creatureAuth: toolDef?.creatureAuth,
      },
    };
  }

  // Strip large image data to prevent token limit errors.
  // The UI pip already received the full result via pip:tool-result IPC.
  return stripLargeImageData({ result });
};

/**
 * Get active Pip Instances formatted for Agent system prompt.
 * Shows which pips exist and which tools can use them.
 * Agents pass instanceId to route to specific pips.
 *
 * The agent uses this information to decide:
 * - Whether to reuse an existing pip (pass instanceId in args)
 * - Which instanceId to pass to tools for multi-instance tools
 */
export const getActivePipsForPrompt = (): string => {
  const pips = getPipInstances();
  if (pips.length === 0) return "No active PIP tabs.";

  return pips
    .map((p) => {
      let info = `### ${p.instanceId}\n`;
      info += `  Resource: ${p.resourceUri}\n`;

      // Show which tools can use this pip
      const tools = getToolsForResourceUri(p.resourceUri);
      if (tools.length > 0) {
        info += `  Tools: ${tools.join(", ")}\n`;
      }

      // Include modelContent from widget state if available.
      // This allows the AI to see widget data on follow-up turns.
      if (p.widgetState?.modelContent) {
        const modelContent = p.widgetState.modelContent;
        const contentStr = typeof modelContent === "string"
          ? modelContent
          : JSON.stringify(modelContent, null, 2);
        info += `  Current Widget State:\n${contentStr.split("\n").map(line => `    ${line}`).join("\n")}`;
      }

      return info;
    })
    .join("\n\n");
};
