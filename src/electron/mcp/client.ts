/**
 * MCP Client Manager
 *
 * Manages connections to MCP servers, caches tools and resources,
 * and provides methods to interact with MCP servers.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CreateMessageRequestSchema, ErrorCode, LoggingMessageNotificationSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type {
  ContentBlock,
  CreateMessageRequestParams,
  ModelPreferences,
  SamplingMessageContentBlock,
  Tool,
  ToolChoice,
  ToolResultContent,
  ToolUseContent,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import path from "node:path";
import { app } from "electron";
import fs from "node:fs";
import { spawn, exec, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { injectCSP, type CspConfig } from "./csp";
import { injectConsoleOverride } from "./consoleCapture";
import { getMainWindow } from "../window/mainWindow";
import { buildSpawnEnv, getExtendedPath, resolveBundledCommand } from "../utils/env";
import { closeAllPips, getPipInstances, reconcilePipsForMcp, refreshAllPipsForMcp } from "./controlPlane";
import { logAggregator, type LogLevel } from "../logging";
import { portManager } from "./portManager";
import { cleanupOrphanedMcpProcesses, registerMcpProcess, unregisterMcpProcess, type McpProcessKind } from "./processRegistry";
import { findWorkspaceRoot } from "../utils/workspace";
import { getMcpStorageDir } from "../storage/mcpStorageDir";
import { getMcpRepoDir } from "../storage/mcpRepoDir";
import { DEFAULT_SAMPLING_SETTINGS, readUserDataProjectConfig, type SamplingSettings } from "../storage/projectSettings";
import { dispatchStorageMethod, isStorageMethod, STORAGE_METHODS } from "./storage";
import { normalizeFileData } from "../../lib/utils";
import { requestSamplingApproval } from "./sampling";
import * as telemetry from "../telemetry";
import type { ResourceIcon } from "../../shared/types";
import { createProvider } from "../agent/provider";
import { getCredentials } from "../ipc/auth.handlers";
import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3ToolChoice,
  LanguageModelV3ToolResultOutput,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider";
import { validateCommandLineString, validateNodeBasedLaunch } from "../../shared/mcpCommandPolicy";

// =============================================================================
// Storage Request Schemas (for server→client RPC)
// =============================================================================

/**
 * Create a request schema for a storage method.
 * These schemas are used for server→client requests where the MCP server
 * calls the Creature Desktop to perform storage operations.
 */
const createStorageRequestSchema = <T extends z.ZodRawShape>(
  methodName: string,
  paramsSchema: z.ZodObject<T>
) => {
  return z.object({
    method: z.literal(methodName),
    params: paramsSchema,
  });
};

// KV Storage request schemas
const StorageKvGetRequestSchema = createStorageRequestSchema(
  STORAGE_METHODS.KV_GET,
  z.object({ key: z.string() })
);

const StorageKvSetRequestSchema = createStorageRequestSchema(
  STORAGE_METHODS.KV_SET,
  z.object({ key: z.string(), value: z.string() })
);

const StorageKvDeleteRequestSchema = createStorageRequestSchema(
  STORAGE_METHODS.KV_DELETE,
  z.object({ key: z.string() })
);

const StorageKvListRequestSchema = createStorageRequestSchema(
  STORAGE_METHODS.KV_LIST,
  z.object({ prefix: z.string().optional() })
);

const StorageKvListWithValuesRequestSchema = createStorageRequestSchema(
  STORAGE_METHODS.KV_LIST_WITH_VALUES,
  z.object({ prefix: z.string().optional() })
);

const StorageKvSearchRequestSchema = createStorageRequestSchema(
  STORAGE_METHODS.KV_SEARCH,
  z.object({
    query: z.string(),
    prefix: z.string().optional(),
    limit: z.number().optional(),
  })
);

const StorageVectorUpsertRequestSchema = createStorageRequestSchema(
  STORAGE_METHODS.VECTOR_UPSERT,
  z.object({
    key: z.string(),
    text: z.string(),
    metadata: z.unknown().optional(),
  })
);

const StorageVectorSearchRequestSchema = createStorageRequestSchema(
  STORAGE_METHODS.VECTOR_SEARCH,
  z.object({
    query: z.string(),
    prefix: z.string().optional(),
    limit: z.number().optional(),
  })
);

const StorageVectorDeleteRequestSchema = createStorageRequestSchema(
  STORAGE_METHODS.VECTOR_DELETE,
  z.object({
    key: z.string(),
  })
);

// Blob Storage request schemas
const StorageBlobPutRequestSchema = createStorageRequestSchema(
  STORAGE_METHODS.BLOB_PUT,
  z.object({
    name: z.string(),
    data: z.string(),
    mimeType: z.string().optional(),
  })
);

const StorageBlobGetRequestSchema = createStorageRequestSchema(
  STORAGE_METHODS.BLOB_GET,
  z.object({ name: z.string() })
);

const StorageBlobDeleteRequestSchema = createStorageRequestSchema(
  STORAGE_METHODS.BLOB_DELETE,
  z.object({ name: z.string() })
);

const StorageBlobListRequestSchema = createStorageRequestSchema(
  STORAGE_METHODS.BLOB_LIST,
  z.object({ prefix: z.string().optional() })
);

/**
 * Kill a process and all its children (the entire process group).
 *
 * On Windows, uses `taskkill /T` to kill the process tree.
 * On Unix, spawned processes use `detached: true` which places them in their
 * own process group. Sending a signal to the negative PID kills the entire
 * group — including grandchildren like vite, tsx, and esbuild that would
 * otherwise survive and become orphans.
 *
 * Sends SIGTERM first for graceful shutdown, then escalates to SIGKILL
 * after a short grace period to guarantee cleanup.
 */
const killProcessTree = (proc: ChildProcess): void => {
  if (!proc.pid) return;
  const pid = proc.pid;

  if (process.platform === "win32") {
    exec(`taskkill /pid ${pid} /T /F`, (err) => {
      if (err) {
        console.log(`[MCP] taskkill failed (process may have already exited):`, err.message);
      }
    });
    return;
  }

  // Kill the entire process group via negative PID
  try {
    process.kill(-pid, "SIGTERM");
  } catch (err: any) {
    if (err.code !== "ESRCH") {
      console.log(`[MCP] Process group SIGTERM failed for pgid ${pid}:`, err.message);
    }
    return;
  }

  // Escalate to SIGKILL after a grace period to guarantee cleanup
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ESRCH means the group is already gone — expected
    }
  }, 500);
};

export type { ResourceIcon };

/**
 * Transport type for MCP connections.
 * - stdio: Local subprocess via standard I/O (default)
 * - streamable-http: Remote server via HTTP with SSE streaming
 */
export type MCPTransportType = "stdio" | "streamable-http";

/**
 * MCP Server configuration.
 * - Built-in servers use path/port
 * - Registry servers use registryPackage (command/args resolved at runtime)
 * - Custom servers use command/args/cwd
 */
export interface MCPServerConfig {
  name: string;
  /**
   * Transport type. Defaults to "stdio" for backwards compatibility.
   */
  transport?: MCPTransportType;
  /**
   * URL for streamable-http transport. Required when transport is "streamable-http".
   */
  url?: string;
  /**
   * Headers to include in streamable-http requests (e.g., Authorization).
   */
  headers?: Record<string, string>;
  /**
   * Git source metadata for cloning MCPs.
   */
  git?: { url: string; ref?: string; subdir?: string; setupCommand?: string; startCommand?: string; transport?: MCPTransportType };
  path?: string;
  port?: number;
  portEnvVar?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Registry package metadata for display/tracking.
   * Format: "package-name" or "package-name@version"
   * Only present when scope is "registry".
   */
  registryPackage?: string;
}

/**
 * Scope for MCP server configuration.
 * - builtin: Built-in servers (cannot be edited/deleted)
 * - registry: MCPs installed from the registry (command/args/cwd locked, only env editable)
 * - custom: Manually added MCPs (fully editable)
 * - development: Auto-detected MCP being developed in current project folder
 */
export type MCPScope = "builtin" | "registry" | "custom" | "development";

/**
 * MCP Server configuration for renderer (UI display).
 */
export interface MCPServerConfigForRenderer {
  name: string;
  /**
   * Transport type. Defaults to "stdio" for backwards compatibility.
   */
  transport?: MCPTransportType;
  /**
   * URL for streamable-http transport.
   */
  url?: string;
  /**
   * Headers for streamable-http transport (e.g., Authorization).
   */
  headers?: Record<string, string>;
  /**
   * Git source metadata for cloning MCPs.
   */
  git?: { url: string; ref?: string; subdir?: string; setupCommand?: string; startCommand?: string; transport?: MCPTransportType };
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
  scope?: MCPScope;
  status?: "ok" | "error";
  lastError?: string;
  /**
   * Registry package metadata for display/tracking.
   * Format: "package-name" or "package-name@version"
   * Only present when scope is "registry".
   */
  registryPackage?: string;
}

/**
 * Cached tool with metadata for UI resource linking.
 */
interface CachedTool {
  name: string;
  serverName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  resourceUri?: string;
  /**
   * Supported display modes for this tool's UI.
   * Used by the agent to decide how to render (inline vs pip).
   */
  displayModes?: string[];
  /**
   * Default display mode when the agent doesn't specify.
   * Falls back to "pip" if not set.
   */
  defaultDisplayMode?: string;
  /**
   * Whether a newly created pip should open in background when another pip is active.
   * Defaults to false when omitted.
   */
  openInBackground?: boolean;
  /**
   * Creature auth configuration from _meta.creature.auth.
   * When managed=true, host provides identity + token to the app.
   */
  creatureAuth?: {
    managed?: boolean;
  };
}

/**
 * View routing configuration.
 * Maps URL-like path patterns to arrays of tool names.
 *
 * @example
 * ```
 * views: {
 *   "/": ["notes_list"],
 *   "/editor": ["notes_create"],
 *   "/editor/:noteId": ["notes_open", "notes_save"]
 * }
 * ```
 */
type Views = Record<string, string[]>;

/**
 * Cached UI resource metadata.
 */
interface CachedResource {
  uri: string;
  name: string;
  mimeType?: string;
  displayModes?: string[];
  /** Custom icon from resource metadata (_meta.ui.icon) */
  icon?: ResourceIcon;
  /**
   * View routing configuration for this resource.
   * Maps URL-like path patterns to tool names for instance routing.
   */
  views?: Views;
  /** "single" (default) = one pip per resource, "multiple" = view-based routing */
  instanceMode?: "single" | "multiple";
}

/**
 * MCP connection with cached data.
 */
interface McpConnection {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  transportType: MCPTransportType;
  tools: Map<string, CachedTool>;
  resources: Map<string, CachedResource>;
  /** Cache of UI resource HTML content */
  resourceCache: Map<string, ReadResourceResult>;
  /** Session ID for streamable-http connections */
  sessionId?: string;
  /** Spawned process for HTTP-based MCPs that need local process management */
  spawnedProcess?: import("child_process").ChildProcess;
  instructions?: string;
}

// Store MCP connections (keyed by server name)
const connections = new Map<string, McpConnection>();
const connectionPromises = new Map<string, Promise<McpConnection>>();

const mapMcpToolToModelTool = (toolDef: Tool): LanguageModelV3FunctionTool => ({
  type: "function",
  name: toolDef.name,
  description: toolDef.description,
  parameters: toolDef.inputSchema as Record<string, unknown>,
});

const mapMcpToolChoice = (toolChoice?: ToolChoice): LanguageModelV3ToolChoice | undefined => {
  if (!toolChoice?.mode) return undefined;
  if (toolChoice.mode === "required") return { type: "required" };
  if (toolChoice.mode === "none") return { type: "none" };
  return { type: "auto" };
};

const toolResultToOutput = (toolResult: ToolResultContent): LanguageModelV3ToolResultOutput => {
  const onlyText =
    toolResult.content?.length === 1 &&
    toolResult.content[0]?.type === "text" &&
    typeof (toolResult.content[0] as { text?: string }).text === "string";
  if (onlyText) {
    return { type: "text", value: (toolResult.content[0] as { text: string }).text };
  }
  return {
    type: "json",
    value: {
      content: toolResult.content,
      structuredContent: toolResult.structuredContent,
      isError: toolResult.isError,
      _meta: toolResult._meta,
    },
  };
};

const buildSamplingPrompt = (params: {
  systemPrompt?: string;
  contextText?: string;
  messages: CreateMessageRequestParams["messages"];
}): LanguageModelV3Prompt => {
  const prompt: LanguageModelV3Prompt = [];
  if (params.systemPrompt) {
    prompt.push({ role: "system", content: params.systemPrompt });
  }
  if (params.contextText) {
    prompt.push({ role: "system", content: params.contextText });
  }

  const toolNameById = new Map<string, string>();

  for (const message of params.messages) {
    const role = message.role;
    const contentBlocks = Array.isArray(message.content) ? message.content : [message.content];
    let currentParts: LanguageModelV3Content[] = [];

    const flush = () => {
      if (currentParts.length > 0) {
        prompt.push({ role, content: currentParts });
        currentParts = [];
      }
    };

    for (const block of contentBlocks) {
      if (typeof block === "string") {
        currentParts.push({ type: "text", text: block });
        continue;
      }
      if (block.type === "tool_result") {
        flush();
        const toolResult = block as ToolResultContent;
        const toolName = toolNameById.get(toolResult.toolUseId) || "tool";
        prompt.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: toolResult.toolUseId,
              toolName,
              output: toolResultToOutput(toolResult),
            },
          ],
        });
        continue;
      }

      if (block.type === "text") {
        currentParts.push({ type: "text", text: block.text });
        continue;
      }

      if (block.type === "image" || block.type === "audio") {
        currentParts.push({
          type: "file",
          data: block.data,
          mediaType: block.mimeType,
        });
        continue;
      }

      if (block.type === "tool_use") {
        const toolUse = block as ToolUseContent;
        toolNameById.set(toolUse.id, toolUse.name);
        if (role !== "assistant") {
          currentParts.push({ type: "text", text: JSON.stringify(block) });
          continue;
        }
        currentParts.push({
          type: "tool-call",
          toolCallId: toolUse.id,
          toolName: toolUse.name,
          input: toolUse.input ?? {},
        });
        continue;
      }

      currentParts.push({ type: "text", text: JSON.stringify(block) });
    }

    flush();
  }

  return prompt;
};

const outputToToolResultContent = (toolCallId: string, output: LanguageModelV3ToolResultOutput): ToolResultContent => {
  if (output.type === "text") {
    return {
      type: "tool_result",
      toolUseId: toolCallId,
      content: [{ type: "text", text: output.value }],
    };
  }

  const value = output.value as unknown;
  let content: ContentBlock[] | undefined;
  let structuredContent: Record<string, unknown> | undefined;
  let isError: boolean | undefined;

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.content)) {
      content = v.content as ContentBlock[];
    }
    if (v.structuredContent && typeof v.structuredContent === "object") {
      structuredContent = v.structuredContent as Record<string, unknown>;
    }
    if (typeof v.isError === "boolean") {
      isError = v.isError;
    }
  }

  if (!content) {
    content = [{ type: "text", text: JSON.stringify(value) }];
  }

  return {
    type: "tool_result",
    toolUseId: toolCallId,
    content,
    structuredContent,
    isError,
  };
};

const modelContentToMcpBlocks = (content: LanguageModelV3Content[]): SamplingMessageContentBlock[] => {
  const blocks: SamplingMessageContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "tool-call") {
      blocks.push({
        type: "tool_use",
        id: part.toolCallId,
        name: part.toolName,
        input: (part.input ?? {}) as Record<string, unknown>,
      });
      continue;
    }
    if (part.type === "file") {
      const mediaType = part.mediaType || "application/octet-stream";
      const data = normalizeFileData({ data: part.data });
      if (mediaType.startsWith("image/")) {
        blocks.push({ type: "image", data, mimeType: mediaType });
      } else if (mediaType.startsWith("audio/")) {
        blocks.push({ type: "audio", data, mimeType: mediaType });
      } else {
        blocks.push({ type: "text", text: JSON.stringify({ mediaType, data }) });
      }
      continue;
    }
    if (part.type === "tool-result") {
      blocks.push(outputToToolResultContent(part.toolCallId, part.output));
      continue;
    }
  }
  return blocks;
};

const collapseSamplingBlocks = (blocks: SamplingMessageContentBlock[]): SamplingMessageContentBlock => {
  if (blocks.length === 1) {
    return blocks[0];
  }
  const text = blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return `[image:${block.mimeType}]`;
      if (block.type === "audio") return `[audio:${block.mimeType}]`;
      if (block.type === "tool_use") return `[tool_use:${block.name}]`;
      if (block.type === "tool_result") return `[tool_result:${block.toolUseId}]`;
      return JSON.stringify(block);
    })
    .join("\n");
  return { type: "text", text };
};

const buildSamplingContextText = (includeContext: "none" | "thisServer" | "allServers" | undefined, serverName: string): string | undefined => {
  if (!includeContext || includeContext === "none") return undefined;
  const targetServers = includeContext === "thisServer" ? [serverName] : Array.from(connections.keys());
  const sections: string[] = [];
  for (const name of targetServers) {
    const conn = connections.get(name);
    const instructions = conn?.instructions?.trim();
    const pips = getPipInstances().filter((pip) => pip.serverName === name && pip.widgetState?.modelContent != null);
    const widgetText = pips
      .map((pip) => {
        const content = pip.widgetState?.modelContent;
        const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
        return `Pip ${pip.instanceId}:\n${text}`;
      })
      .join("\n\n");

    if (!instructions && !widgetText) continue;
    const sectionParts = [`Server: ${name}`];
    if (instructions) sectionParts.push(`Instructions:\n${instructions}`);
    if (widgetText) sectionParts.push(`Widget State:\n${widgetText}`);
    sections.push(sectionParts.join("\n"));
  }
  return sections.length ? sections.join("\n\n") : undefined;
};

// Store user MCPs (registry + custom) from cloud project record
let userMcpConfigs: MCPServerConfigForRenderer[] = [];

const mcpStatusByName = new Map<string, { status: "ok" | "error"; error?: string; updatedAt: number }>();

const setMcpStatus = (name: string, status: "ok" | "error", error?: string) => {
  mcpStatusByName.set(name, { status, error, updatedAt: Date.now() });
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("mcp:status", { name, status, error });
  }
};

/**
 * Workspace root information for multi-root project support.
 */
export interface WorkspaceRoot {
  /** Unique identifier for this root (used in virtual paths) */
  id: string;
  /** Absolute path to the root directory */
  path: string;
  /** Human-readable label for display */
  label: string;
  /** Whether this root is an MCP app (has open-mcp-app dependency) */
  isMcpApp: boolean;
  /** Source of this root: workspace (main folder) or discovered (auto-found) */
  source: "workspace" | "discovered";
}

// Track current workspace roots (replaces single currentFolderPath)
// Each root can be the main workspace or an MCP app project
let currentWorkspaceRoots: WorkspaceRoot[] = [];

// Track current project profile (playground, dev-general, or dev-mcp)
// Used to determine project type and MCP enablement
let currentProjectProfile: "playground" | "dev-general" | "dev-mcp" | null = null;

// Track current project ID for per-project storage scoping
// Set when project is opened, cleared when project is closed
let currentProjectId: string | null = null;

/**
 * Get the current project ID.
 * Used by storage helpers to scope per-project data.
 */
export const getCurrentProjectId = (): string | null => currentProjectId;

const getSamplingSettingsForProject = (): SamplingSettings => {
  if (!currentProjectId) return DEFAULT_SAMPLING_SETTINGS;
  const config = readUserDataProjectConfig(currentProjectId);
  return config?.sampling ?? DEFAULT_SAMPLING_SETTINGS;
};

// Flag to prevent MCP re-initialization during shutdown
// Set true when closing MCPs, false when initializing new project
let mcpsShutdown = false;

// Track dev MCP folder paths to their current server names
// Maps dev MCP folder paths to their current canonical server names.
// Initially populated from package.json during initializeMcps, then updated by
// createConnection when the server's self-declared name differs from the spawn key.
const devMcpPathToName = new Map<string, string>();


/**
 * Check if a server name is a built-in MCP.
 * Built-in MCPs are shipped with the app and don't need user configuration.
 */
const isBuiltinMcp = (name: string): boolean => {
  return BUILTIN_MCP_SERVERS.some(s => s.name === name);
};

/**
 * List of MCP names configured for the current project.
 * This is the source of truth for which MCPs should be active.
 */
let projectMcpNames: Set<string> = new Set();

/**
 * Get the primary workspace folder path (first workspace root).
 * Used for backward compatibility with code expecting a single path.
 */
const getPrimaryWorkspacePath = (): string | null => {
  const primary = currentWorkspaceRoots.find(r => r.source === "workspace");
  return primary?.path || currentWorkspaceRoots[0]?.path || null;
};

/**
 * Find a workspace root by MCP app name.
 *
 * Reads each MCP app root's package.json to match against the given name.
 * Used for initial process spawning and discovery — the canonical name
 * after connection comes from the MCP protocol handshake.
 */
const findRootByMcpName = (serverName: string): WorkspaceRoot | null => {
  for (const root of currentWorkspaceRoots) {
    if (!root.isMcpApp) continue;
    const mcpDef = getPublishablePackageInfo(root.path);
    if (mcpDef && mcpDef.name === serverName) {
      return root;
    }
  }
  return null;
};

// =============================================================================
// Package Manager Detection & Dependency Installation
// =============================================================================

/**
 * Supported package managers and their lock files.
 * Used to detect which package manager a project uses.
 */
type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

const LOCK_FILE_TO_PACKAGE_MANAGER: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
  "package-lock.json": "npm",
};

/**
 * Detect the package manager used by a project based on lock files.
 * Falls back to npm if no lock file is found.
 *
 * @param projectPath - Path to the project directory
 * @returns The detected package manager
 */
const detectPackageManager = (projectPath: string): PackageManager => {
  for (const [lockFile, packageManager] of Object.entries(LOCK_FILE_TO_PACKAGE_MANAGER)) {
    if (fs.existsSync(path.join(projectPath, lockFile))) {
      return packageManager;
    }
  }
  return "npm";
};

/**
 * Check if a package manager command is available on the system.
 * Uses `which` on Unix-like systems to locate the command.
 *
 * @param command - Package manager command to check (npm, yarn, pnpm, bun)
 * @returns Promise that resolves to true if command is available
 */
const isPackageManagerAvailable = async (command: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const checkCmd = process.platform === "win32" ? "where" : "which";
    exec(`${checkCmd} ${command}`, { env: { ...process.env, PATH: getExtendedPath() } }, (error) => {
      resolve(!error);
    });
  });
};

/**
 * Install dependencies for a dev MCP app using the appropriate package manager.
 * Detects the package manager from lock files and runs the install command.
 * Only npm is guaranteed to be available; other package managers require user installation.
 *
 * @param projectPath - Path to the MCP app project directory
 * @param serverName - Name of the MCP server (for logging)
 * @throws Error if the detected package manager is not available (except npm)
 */
const installDevMcpDependencies = async ({
  projectPath,
  serverName,
}: {
  projectPath: string;
  serverName: string;
}): Promise<void> => {
  const packageManager = detectPackageManager(projectPath);
  
  // npm is always available (bundled with Node.js/Electron)
  // Other package managers require user installation
  if (packageManager !== "npm") {
    const isAvailable = await isPackageManagerAvailable(packageManager);
    if (!isAvailable) {
      throw new Error(
        `MCP app "${serverName}" uses ${packageManager} (detected from lock file), ` +
        `but ${packageManager} is not installed. Please install ${packageManager} or switch to npm.`
      );
    }
  }

  console.log(`[MCP] Installing dependencies for ${serverName} using ${packageManager}...`);

  return new Promise((resolve, reject) => {
    const installProcess = spawn(packageManager, ["install"], {
      cwd: projectPath,
      env: { ...process.env, PATH: getExtendedPath() },
      shell: true,
    });

    let stderr = "";
    installProcess.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    installProcess.on("close", (code) => {
      if (code === 0) {
        console.log(`[MCP] Dependencies installed for ${serverName}`);
        resolve();
      } else {
        reject(new Error(
          `Failed to install dependencies for ${serverName} (exit code ${code}): ${stderr}`
        ));
      }
    });

    installProcess.on("error", (err) => {
      reject(new Error(`Failed to run ${packageManager} install: ${err.message}`));
    });
  });
};

/**
 * Definition for a publishable MCP.
 * Basic info derived from package.json to provide defaults in the publish view.
 */
export interface McpDef {
  name: string;
  description: string;
  version: string;
  npmPackage: string;
}

/**
 * Development-specific configuration for MCP Apps.
 * Controls behavior when developing an MCP App locally.
 */
interface CreatureDevConfig {
  /** 
   * Whether to automatically start a tunnel when opening this MCP App project.
   * Defaults to false. When true, Creature will create a public tunnel URL
   * and inject the result into chat when the project opens.
   */
  autoTunnel?: boolean;
}

/**
 * Creature-specific configuration in package.json.
 * Only dev config is still read from package.json.
 * Publishing config is now managed entirely in the publish view.
 */
interface CreatureConfig {
  /** Development-specific configuration */
  dev?: CreatureDevConfig;
}

/**
 * Relevant fields from package.json for MCP publishing.
 */
interface PackageJson {
  name: string;
  description?: string;
  version: string;
  creature?: CreatureConfig;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}


/**
 * Parses a registry reference string into name and optional version.
 * Supports: "package-name" or "package-name@version"
 */
const parseRegistryRef = (ref: string): { name: string; version?: string } => {
  const atIndex = ref.lastIndexOf("@");
  if (atIndex > 0) {
    return {
      name: ref.substring(0, atIndex),
      version: ref.substring(atIndex + 1),
    };
  }
  return { name: ref };
};

const readPackageJson = (dirPath: string): PackageJson | null => {
  try {
    const packageJsonPath = path.join(dirPath, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }
    const data = fs.readFileSync(packageJsonPath, "utf-8");
    return JSON.parse(data) as PackageJson;
  } catch {
    return null;
  }
};

const isMcpAppPackage = (pkg: PackageJson | null): boolean => {
  if (!pkg) return false;
  const deps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};
  return Boolean(
    deps["open-mcp-app"] ||
      devDeps["open-mcp-app"] ||
      deps["@modelcontextprotocol/ext-apps"] ||
      devDeps["@modelcontextprotocol/ext-apps"]
  );
};

const runGitCommand = async ({
  args,
  cwd,
}: {
  args: string[];
  cwd?: string;
}): Promise<void> => {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      cwd,
      env: buildSpawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(new Error("Git is not installed or not in PATH."));
        return;
      }
      reject(err);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const message = stderr.trim() || `Git command failed (exit code ${code ?? "unknown"})`;
      reject(new Error(message));
    });
  });
};

const runSetupCommand = async ({
  commandLine,
  cwd,
}: {
  commandLine: string;
  cwd: string;
}): Promise<void> => {
  const { command, args } = validateCommandLineString({
    commandLine,
    context: "Git setup command",
  });
  const resolved = resolveBundledCommand(command, args);

  return new Promise((resolve, reject) => {
    const proc = spawn(resolved.command, resolved.args, {
      cwd,
      env: buildSpawnEnv(),
      shell: !resolved.useBundled,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    proc.stdout?.on("data", (data) => {
      console.log(`[MCP] setup: ${data}`);
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const message = stderr.trim() || `Setup command failed (exit code ${code ?? "unknown"})`;
      reject(new Error(message));
    });
  });
};

const runNpmInstall = async (cwd: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const resolved = resolveBundledCommand("npm", ["install"]);
    const proc = spawn(resolved.command, resolved.args, {
      cwd,
      env: buildSpawnEnv({ npm_config_yes: "true" }),
      shell: !resolved.useBundled,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    proc.stdout?.on("data", (data) => {
      console.log(`[MCP] npm install: ${data}`);
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const message = stderr.trim() || `npm install failed (exit code ${code ?? "unknown"})`;
      reject(new Error(message));
    });
  });
};

const ensureNodeModules = async (appDir: string): Promise<void> => {
  const nodeModulesDir = path.join(appDir, "node_modules");
  if (fs.existsSync(nodeModulesDir)) {
    return;
  }

  const pkg = readPackageJson(appDir);
  if (!pkg) {
    throw new Error("package.json not found for MCP app.");
  }

  try {
    await runNpmInstall(appDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to install dependencies: ${message}`);
  }
};

const getGitSetupMarkerPath = (repoDir: string): string => {
  return path.join(repoDir, ".creature", "git-setup.json");
};

const writeGitSetupMarker = (repoDir: string, command: string) => {
  const markerPath = getGitSetupMarkerPath(repoDir);
  const markerDir = path.dirname(markerPath);
  if (!fs.existsSync(markerDir)) {
    fs.mkdirSync(markerDir, { recursive: true });
  }
  fs.writeFileSync(markerPath, JSON.stringify({ setupCommand: command, completedAt: new Date().toISOString() }, null, 2));
};

const ensureGitRepo = async ({
  repoDir,
  url,
  ref,
}: {
  repoDir: string;
  url: string;
  ref?: string;
}): Promise<boolean> => {
  const gitDir = path.join(repoDir, ".git");
  if (fs.existsSync(repoDir)) {
    if (fs.existsSync(gitDir)) {
      return false;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(repoDir), { recursive: true });

  const args = ["clone", "--depth", "1"];
  if (ref) {
    args.push("--branch", ref);
  }
  args.push(url, repoDir);

  try {
    await runGitCommand({ args });
  } catch (error) {
    if (fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to clone repo: ${message}`);
  }

  return true;
};

const findGitMcpAppDir = (repoDir: string, subdir?: string): string => {
  const repoRoot = path.resolve(repoDir);

  if (subdir) {
    const resolved = path.resolve(repoRoot, subdir);
    if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) {
      throw new Error("Subdir is outside repo.");
    }
    const pkg = readPackageJson(resolved);
    if (!pkg || !isMcpAppPackage(pkg)) {
      throw new Error(`No MCP App found at subdir: ${subdir}`);
    }
    return resolved;
  }

  const matches: string[] = [];
  const shouldSkipDir = (name: string) => {
    return (
      name.startsWith(".") ||
      name === "node_modules" ||
      name === "dist" ||
      name === "build" ||
      name === "out"
    );
  };

  const scan = (dir: string, depth: number) => {
    if (depth > 2) return;

    const pkg = readPackageJson(dir);
    if (pkg && isMcpAppPackage(pkg)) {
      matches.push(dir);
    }

    if (depth === 2) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (shouldSkipDir(entry.name)) continue;
        scan(path.join(dir, entry.name), depth + 1);
      }
    } catch {
      return;
    }
  };

  scan(repoRoot, 0);

  if (matches.length === 0) {
    throw new Error("No MCP App found; set subdir.");
  }
  if (matches.length > 1) {
    throw new Error("Multiple MCP Apps found; set subdir.");
  }

  return matches[0];
};

const detectGitMcpRunConfig = (appDir: string): { command: string; args: string[]; nodeEnv: string } => {
  const pkg = readPackageJson(appDir);
  if (!pkg || !isMcpAppPackage(pkg)) {
    throw new Error("No MCP App found; set subdir.");
  }

  const scripts = pkg.scripts || {};
  if (scripts.dev) {
    return { command: "npm", args: ["run", "dev"], nodeEnv: "development" };
  }
  if (scripts.start) {
    return { command: "npm", args: ["run", "start"], nodeEnv: "production" };
  }

  throw new Error("No runnable script found. Add a dev or start script in package.json.");
};

/**
 * Get basic package info from package.json to provide defaults in the publish view.
 * Returns null if package.json doesn't exist or is missing required fields.
 * 
 * This is used to pre-fill the publish form with package.json values.
 * Whether a project IS an MCP App is determined by project.profile === 'dev-mcp'.
 */
export const getPublishablePackageInfo = (folderPath: string): McpDef | null => {
  try {
    const packageJsonPath = path.join(folderPath, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }
    const data = fs.readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(data) as PackageJson;

    // Require name and version at minimum
    if (!pkg.name || !pkg.version) {
      return null;
    }

    return {
      name: pkg.name,
      description: pkg.description || "",
      version: pkg.version,
      npmPackage: pkg.name,
    };
  } catch (error) {
    console.error(`[MCP] Failed to read package.json from ${folderPath}:`, error);
    return null;
  }
};

/**
 * Get the current folder path (primary workspace root).
 * Returns null if no folder is open.
 * For backward compatibility - use getCurrentWorkspaceRoots() for multi-root support.
 */
export const getCurrentFolderPath = (): string | null => {
  return getPrimaryWorkspacePath();
};

/**
 * Get all current workspace roots.
 * Returns an empty array if no project is open.
 */
export const getCurrentWorkspaceRoots = (): WorkspaceRoot[] => {
  return [...currentWorkspaceRoots];
};

/**
 * Built-in MCP servers configuration.
 * All MCPs run as subprocesses from the workspace root.
 */
/**
 * Built-in MCP servers configuration.
 * 
 * Servers are compiled by Vite and run as subprocesses using Electron's
 * bundled Node.js (via ELECTRON_RUN_AS_NODE=1). This ensures native modules
 * like node-pty work correctly since they're compiled against Electron's Node.
 */
const BUILTIN_MCP_SERVERS: MCPServerConfig[] = [
  {
    name: "terminal",
    path: "mcp-terminal",
    transport: "streamable-http",
    command: "node",
    args: ["desktop/.vite/build/terminal-server.js"],
  },
  {
    name: "ide",
    path: "mcp-ide",
    transport: "streamable-http",
    command: "node",
    args: ["desktop/.vite/build/ide-server.js"],
  },
  {
    name: "browser",
    path: "mcp-browser",
    transport: "streamable-http",
    command: "node",
    args: ["desktop/.vite/build/browser-server.js"],
  },
  {
    name: "todos",
    path: "mcp-todos",
    transport: "streamable-http",
    command: "node",
    args: ["desktop/.vite/build/todos-server.js"],
  },
  {
    name: "notes",
    path: "mcp-notes",
    transport: "streamable-http",
    command: "node",
    args: ["desktop/.vite/build/notes-server.js"],
  },
  {
    name: "crm",
    path: "mcp-crm",
    transport: "streamable-http",
    command: "node",
    args: ["desktop/.vite/build/crm-server.js"],
  },
  {
    name: "devkit",
    path: "mcp-devkit",
    transport: "streamable-http",
    command: "node",
    args: ["desktop/.vite/build/devkit-server.js"],
  },
];


const findMcpPath = (serverDir: string): string | null => {
  // In packaged builds, MCPs are bundled in the Resources directory
  if (app.isPackaged) {
    const resourcePath = path.join(process.resourcesPath, serverDir);
    if (fs.existsSync(path.join(resourcePath, "package.json"))) {
      console.log(`[MCP] Found bundled ${serverDir} at ${resourcePath}`);
      return resourcePath;
    }
    console.warn(`[MCP] Built-in ${serverDir} not found in bundled resources`);
    return null;
  }

  // Development: MCPs are in desktop/src/electron/mcps/
  // Strip the "mcp-" prefix from the path to get the folder name (e.g., "mcp-ide" -> "ide")
  const mcpName = serverDir.replace("mcp-", "");
  
  // In dev mode, __dirname points to .vite/build/, so we need to resolve from workspace
  const workspaceRoot = findWorkspaceRoot();
  if (workspaceRoot) {
    // Look in desktop/src/electron/mcps/<name>
    const mcpsPath = path.join(workspaceRoot, "desktop", "src", "electron", "mcps", mcpName);
    if (fs.existsSync(mcpsPath)) {
      console.log(`[MCP] Found ${serverDir} at ${mcpsPath}`);
      return mcpsPath;
    }
  }

  const possiblePaths = [
    path.resolve(__dirname, `../../../../${serverDir}`),
    path.resolve(app.getAppPath(), `../${serverDir}`),
    path.resolve(app.getAppPath(), serverDir),
    path.resolve(process.cwd(), serverDir),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(path.join(p, "package.json"))) {
      return p;
    }
  }

  console.warn(`[MCP] Could not find ${serverDir} package`);
  return null;
};

/**
 * Resolved distribution configuration from registry.
 * Defines how to connect to an MCP based on its distribution type:
 * - npm: Run locally via npx/node command
 * - remote: Connect to user-hosted URL
 * - cloud: Connect to Creature-hosted URL (resolved from deployment)
 */
type ResolvedDistributionConfig =
  | { type: "npm"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "remote"; url: string }
  | { type: "cloud"; url: string };


/**
 * Resolves a registry reference to distribution config by fetching from the registry API.
 * Returns either command/args for npm MCPs or URL for remote/cloud MCPs.
 *
 * Supports version specifiers:
 *   - "package@latest" or "package" - fetches the latest version
 *   - "package@1.2.3" - fetches a specific version
 */
const resolveRegistryPackage = async (
  registryRef: string
): Promise<ResolvedDistributionConfig> => {
  const { name, version } = parseRegistryRef(registryRef);

  const apiUrl = process.env.API_URL || "https://api.creature.run";

  const isLatest = !version || version === "latest";
  const endpoint = isLatest
    ? `/core/v1/registry/${encodeURIComponent(name)}`
    : `/core/v1/registry/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;

  const response = await fetch(`${apiUrl}${endpoint}`);

  if (!response.ok) {
    const versionInfo = isLatest ? "latest" : version;
    throw new Error(`Registry package not found: ${name}@${versionInfo}`);
  }

  const pkg = await response.json();
  const distribution = pkg.distribution;

  if (!distribution || !distribution.type) {
    throw new Error(`Registry package ${name} has no valid distribution config`);
  }

  // Handle npm distribution - run locally via command
  if (distribution.type === "npm") {
    if (!distribution.package) {
      throw new Error(`Registry package ${name} has invalid npm config (missing package)`);
    }
    const command = distribution.command || "npx";
    const args = distribution.args
      ? [distribution.package, ...distribution.args]
      : ["-y", distribution.package];
    validateNodeBasedLaunch({
      command,
      args,
      context: `Registry package "${name}"`,
    });
    return {
      type: "npm",
      command,
      args,
      ...(distribution.env && { env: distribution.env }),
    };
  }

  // Handle remote distribution - connect to user-hosted URL
  if (distribution.type === "remote") {
    if (!distribution.url) {
      throw new Error(`Registry package ${name} has invalid remote config (missing url)`);
    }
    return { type: "remote", url: distribution.url };
  }

  // Cloud deployments are not supported in local-first mode
  if (distribution.type === "cloud") {
    throw new Error(`Cloud deployments are not supported. Package ${name} requires cloud hosting.`);
  }

  throw new Error(`Registry package ${name} has unknown distribution type: ${distribution.type}`);
};

/**
 * Convert user config to internal config format.
 * For registry packages, command/args are empty and resolved at connect time.
 */
const userConfigToInternal = (config: MCPServerConfigForRenderer): MCPServerConfig & { registry?: string } => {
  return {
    name: config.name,
    transport: config.transport,
    url: config.url,
    headers: config.headers,
    git: config.git,
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: config.env,
    registryPackage: config.registryPackage,
  };
};

/**
 * Get all MCP server configs (built-in + Development MCP + registry/custom MCPs).
 * Development MCP is added when project.profile === 'dev-mcp'.
 * Each config includes its scope (builtin/registry/custom) for UI display.
 * Disabled built-in MCPs are filtered out entirely (not shown in UI).
 */
export const getMcpServerConfigs = (): MCPServerConfigForRenderer[] => {
  const configs: MCPServerConfigForRenderer[] = [];

  const withStatus = (config: MCPServerConfigForRenderer): MCPServerConfigForRenderer => {
    const status = mcpStatusByName.get(config.name);
    if (!status) return config;
    return { ...config, status: status.status, lastError: status.error };
  };

  // Development MCPs - one for each MCP app root
  // These take precedence and are detected from workspace
  const devMcpNames: Set<string> = new Set();
  for (const root of currentWorkspaceRoots) {
    if (!root.isMcpApp) continue;

    const mcpDef = getPublishablePackageInfo(root.path);
    if (mcpDef) {
      devMcpNames.add(mcpDef.name);
      const port = portManager.getAssigned({ serverName: mcpDef.name }) || 3000;
      configs.push(withStatus({
        name: mcpDef.name,
        transport: "streamable-http",
        url: `http://localhost:${port}/mcp`,
        command: "npm",
        args: ["run", "dev"],
        cwd: root.path,
        enabled: true,
        scope: "development" as MCPScope,
      }));
    }
  }

  // Built-in MCPs that are in the project's MCP list
  for (const server of BUILTIN_MCP_SERVERS) {
    if (projectMcpNames.has(server.name) && !devMcpNames.has(server.name)) {
      configs.push(withStatus({
        name: server.name,
        command: server.command || "",
        args: server.args || [],
        cwd: server.cwd || server.path,
        env: server.env,
        enabled: true,
        scope: "builtin" as MCPScope,
      }));
    }
  }

  // Custom MCPs from project config (not built-in, not dev)
  const customConfigs = userMcpConfigs
    .filter((c) => !devMcpNames.has(c.name))
    .filter((c) => !isBuiltinMcp(c.name))
    .map((c) => withStatus({
      ...c,
      scope: "custom" as MCPScope,
    }));

  return [...configs, ...customConfigs];
};

/**
 * Get Development MCP info if this project has MCP Apps being developed.
 * Returns null if no Dev MCP is detected.
 * For backward compatibility - returns the first dev MCP found.
 */
export const getDevMcpInfo = (): { name: string; port: number } | null => {
  const allDevMcps = getAllDevMcpInfo();
  return allDevMcps.length > 0 ? allDevMcps[0] : null;
};

/**
 * Get the current project profile.
 * Returns null if no project is open.
 */
export const getCurrentProjectProfile = (): "playground" | "dev-general" | "dev-mcp" | null => {
  return currentProjectProfile;
};

/**
 * Get all Development MCP info for MCP Apps being developed in this project.
 * Returns an empty array if no Dev MCPs are detected.
 */
export const getAllDevMcpInfo = (): Array<{ name: string; port: number; path: string }> => {
  const result: Array<{ name: string; port: number; path: string }> = [];
  
  for (const root of currentWorkspaceRoots) {
    if (!root.isMcpApp) continue;
    
    const mcpDef = getPublishablePackageInfo(root.path);
    if (!mcpDef) continue;
    
    const port = portManager.getAssigned({ serverName: mcpDef.name });
    if (!port) continue;
    
    result.push({ name: mcpDef.name, port, path: root.path });
  }
  
  return result;
};

/**
 * Get or create a connection to an MCP server.
 */
const getConnection = async (serverName: string): Promise<McpConnection | null> => {
  // Don't create new connections if MCPs are shutting down
  if (mcpsShutdown) {
    console.log(`[MCP] Skipping connection to ${serverName} (shutdown in progress)`);
    return null;
  }

  const existing = connections.get(serverName);
  if (existing) return existing;

  const existingPromise = connectionPromises.get(serverName);
  if (existingPromise) return existingPromise;

  const promise = createConnection(serverName);
  connectionPromises.set(serverName, promise);

  try {
    const connection = await promise;
    return connection;
  } catch (error) {
    connectionPromises.delete(serverName);
    throw error;
  }
};

/**
 * Create a Streamable HTTP transport for remote MCP servers.
 */
const createStreamableHttpTransport = (
  config: MCPServerConfig
): StreamableHTTPClientTransport => {
  if (!config.url) {
    throw new Error(`URL is required for streamable-http transport: ${config.name}`);
  }

  const url = new URL(config.url);

  // Build request init with headers
  const requestInit: RequestInit = {
    headers: {
      ...config.headers,
    },
  };

  return new StreamableHTTPClientTransport(url, {
    requestInit,
  });
};

/**
 * Spawn an HTTP-based MCP server process and wait for it to be ready.
 * Used for development MCPs that use streamable-http transport but need local process management.
 */
/**
 * Wait for a dev MCP readiness signal with a timeout.
 */
const waitForReadySignal = async ({
  serverName,
  readySignalPromise,
  timeoutMs,
}: {
  serverName: string;
  readySignalPromise: Promise<void>;
  timeoutMs: number;
}): Promise<void> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`[MCP] ${serverName} did not emit readiness signal within ${timeoutMs}ms`));
    }, timeoutMs);
  });

  await Promise.race([readySignalPromise, timeoutPromise]);

  if (timeoutId) {
    clearTimeout(timeoutId);
  }
};

const spawnHttpServerProcess = async (
  config: MCPServerConfig,
  serverName: string
): Promise<ChildProcess> => {
  const cwd = config.cwd || process.cwd();
  let command = config.command || "node";
  let args = config.args || ["dist/server.cjs"];

  if (!fs.existsSync(cwd)) {
    throw new Error(`MCP server directory not found: ${cwd}`);
  }

  validateNodeBasedLaunch({
    command,
    args,
    context: `MCP "${serverName}" local HTTP command`,
  });

  const env: Record<string, string> = {
    ...process.env,
    NODE_ENV: "production",
    ...config.env,
  } as Record<string, string>;

  // Use Electron's Node for built-in MCPs (command === "node") in both dev and packaged modes.
  // This ensures native modules like node-pty work correctly since they're compiled against Electron's Node.
  const isBuiltInMcp = command === "node" && args.some(arg => arg.includes(".vite/build/"));
  if (command === "node" && (app.isPackaged || isBuiltInMcp)) {
    command = process.execPath;
    // Convert relative paths to absolute. Skip paths that are already absolute.
    args = args.map(arg => {
      if (path.isAbsolute(arg)) return arg;
      if (arg.includes(".vite/build/") || arg.startsWith("dist/")) return path.join(cwd, arg);
      return arg;
    });
    env.ELECTRON_RUN_AS_NODE = "1";
  } else {
    // For npm/npx commands, use bundled standalone Node.js when available (in packaged app)
    // This avoids macOS dock icon issues since we use a real Node binary, not Electron
    const resolved = resolveBundledCommand(command, args);
    if (resolved.useBundled) {
      command = resolved.command;
      args = resolved.args;
    }
  }

  // Extend PATH for any remaining commands that need system tools
  env.PATH = getExtendedPath(env.PATH);


  // Pass workspace roots to MCPs that need them.
  // For dev MCP apps, MCP_WORKING_DIR is set to their own root (via cwd).
  // For built-in MCPs (like IDE), pass all roots via MCP_WORKING_DIRS.
  const primaryPath = getPrimaryWorkspacePath();
  if (primaryPath) {
    env.MCP_WORKING_DIR = primaryPath;
  }
  if (currentWorkspaceRoots.length > 0) {
    env.MCP_WORKING_DIRS = JSON.stringify(currentWorkspaceRoots);
  }

  // Inject per-MCP storage environment variables (Creature SDK extension).
  // These enable MCPs to persist data scoped by project and server name.
  if (currentProjectId) {
    const storageDir = getMcpStorageDir({ projectId: currentProjectId, serverName });
    env.CREATURE_PROJECT_ID = currentProjectId;
    env.CREATURE_MCP_SERVER_NAME = serverName;
    env.CREATURE_MCP_STORAGE_DIR = storageDir;
  }

  const proc = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Use shell to resolve commands like npm/npx. On Windows, use PowerShell instead of cmd.exe
    // because cmd.exe doesn't handle single quotes properly (common in npm scripts).
    shell: process.platform === "win32" ? "powershell.exe" : true,
    // Create a new process group so killProcessTree can kill the entire tree
    // (including grandchildren like vite, tsx, esbuild) via negative PID signal.
    detached: true,
  });

  // Prevent the detached process group from keeping Electron alive on exit
  proc.unref();

  // Determine process kind for the registry
  const isDevMcpProcess = env.NODE_ENV === "development";
  const processKind: McpProcessKind = isDevMcpProcess ? "dev-mcp" : "local-http";

  // Register every spawned process in the registry, not just dev MCPs.
  // The registry is the safety net for orphan cleanup if the app crashes
  // before closeAllConnections can run.
  if (proc.pid) {
    registerMcpProcess({
      pid: proc.pid,
      serverName,
      command,
      args,
      cwd,
      ports: {
        mcp: env.MCP_PORT ? Number(env.MCP_PORT) : undefined,
      },
      kind: processKind,
    });
  }

  /**
   * Resolve the dev MCP readiness signal once.
   */
  let readySignalResolved = false;
  let resolveReadySignal: (() => void) | null = null;
  const readySignalPromise = new Promise<void>((resolve) => {
    resolveReadySignal = resolve;
  });
  const resolveReadySignalOnce = (): void => {
    if (readySignalResolved) return;
    readySignalResolved = true;
    resolveReadySignal?.();
  };

  /**
   * Route HTTP MCP server output to the log aggregator.
   * This formats logs the same way as stdio MCPs so they appear
   * consistently in the DevConsole.
   */
  const handleProcessOutput = (data: Buffer, isError: boolean) => {
    const raw = data.toString().trim();
    if (!raw) return;

    // Strip ANSI escape codes for clean log display
    const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\[2J\[3J\[H/g, "");
    if (!stripped.trim()) return;

    // Collect lines that match server crash patterns so we can buffer
    // the full multi-line error message for the agent's prepareStep.
    const crashLines: string[] = [];

    // Split by newlines and log each line separately
    for (const line of stripped.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Determine log level from content or default based on stream
      let level: LogLevel = isError ? "error" : "info";
      if (trimmed.toLowerCase().includes("error")) level = "error";
      else if (trimmed.toLowerCase().includes("warning") || trimmed.toLowerCase().includes("warn")) level = "warning";

      logAggregator.log({
        source: "mcp",
        sourceName: serverName,
        level,
        message: trimmed,
      });

      if (trimmed.includes("MCP server ready")) {
        resolveReadySignalOnce();
      }

      // Check if this line matches a known server crash pattern.
      // If so, collect it for the pending error buffer so the agent
      // sees the crash immediately in prepareStep.
      if (isError && SERVER_CRASH_PATTERNS.some((p) => p.test(trimmed))) {
        crashLines.push(trimmed);
      }
    }

    // Buffer crash errors so the agent sees them without calling devkit_get_logs
    if (crashLines.length > 0) {
      bufferServerError({
        serverName,
        message: crashLines.join("\n"),
      });
    }
  };

  proc.stdout?.on("data", (data) => {
    handleProcessOutput(data, false);
  });
  proc.stderr?.on("data", (data) => {
    handleProcessOutput(data, true);
  });

  proc.on("error", (err) => {
    console.error(`[MCP] Failed to spawn ${serverName}:`, err);
  });

  proc.on("exit", () => {
    // Process exit handled by connection cleanup
    if (proc.pid) {
      unregisterMcpProcess({ pid: proc.pid, serverName });
    }
  });

  // Wait for the server to be ready by polling the health endpoint
  const url = config.url;
  if (!url) {
    throw new Error(`URL is required for HTTP server: ${serverName}`);
  }

  const healthUrl = url.replace(/\/mcp$/, "/health");
  const maxAttempts = 60;
  const delayMs = 500;
  const totalTimeoutMs = maxAttempts * delayMs; // 30 seconds

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(healthUrl, { method: "GET" });
      if (response.ok) {
        if (isDevMcpProcess) {
          try {
            await waitForReadySignal({
              serverName,
              readySignalPromise,
              timeoutMs: 5000,
            });
          } catch (error) {
            killProcessTree(proc);
            throw error;
          }
        }
        return proc;
      }
    } catch {
      // Server not ready yet - continue polling unless process exited
    }

    if (proc.exitCode !== null) {
      throw new Error(`${serverName} process exited before becoming ready (code ${proc.exitCode})`);
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  killProcessTree(proc);
  throw new Error(`${serverName} failed to start within ${totalTimeoutMs / 1000} seconds`);
};

/**
 * Create a stdio transport for local MCP servers.
 */
const createStdioTransport = async (
  config: MCPServerConfig,
  serverName: string,
  resolvedCommand: string | undefined,
  resolvedArgs: string[] | undefined
): Promise<StdioClientTransport> => {
  // Use || instead of ?? to also treat empty strings/arrays as falsy
  const resolvedPath = config.path ? findMcpPath(config.path) : null;
  const cwd = config.cwd || resolvedPath || process.cwd();
  
  // Default command/args for development
  let finalCommand = resolvedCommand || "npx";
  let finalArgs = resolvedArgs?.length ? resolvedArgs : ["tsx", "src/server.ts"];

  validateNodeBasedLaunch({
    command: finalCommand,
    args: finalArgs,
    context: `MCP "${serverName}" stdio command`,
  });

  // Build environment - default NODE_ENV=production but allow config.env to override.
  // Development MCPs explicitly set NODE_ENV=development in their config.
  const env: Record<string, string> = {
    ...process.env,
    NODE_ENV: "production",
    ...config.env,
  } as Record<string, string>;

  // Use Electron's Node for built-in MCPs in both dev and packaged modes.
  // This ensures native modules work correctly since they're compiled against Electron's Node.
  const isBuiltinMcp = config.path && !config.registryPackage;
  const isBuiltinViteBuild = finalCommand === "node" && finalArgs.some(arg => arg.includes(".vite/build/"));
  if (isBuiltinMcp && (app.isPackaged || isBuiltinViteBuild)) {
    finalCommand = process.execPath;
    // Convert relative paths to absolute. Skip paths that are already absolute.
    if (isBuiltinViteBuild) {
      finalArgs = finalArgs.map(arg => {
        if (path.isAbsolute(arg)) return arg;
        if (arg.includes(".vite/build/")) return path.join(cwd, arg);
        return arg;
      });
    } else {
      finalArgs = [path.join(cwd, "dist/server.cjs")];
    }
    env.ELECTRON_RUN_AS_NODE = "1";
  } else if (app.isPackaged) {
    // For registry/custom MCPs, use bundled standalone Node.js when available
    // This avoids macOS dock icon issues since we use a real Node binary, not Electron
    const resolved = resolveBundledCommand(finalCommand, finalArgs);
    if (resolved.useBundled) {
      finalCommand = resolved.command;
      finalArgs = resolved.args;
    }
    // Extend PATH for any remaining commands that need system tools
    env.PATH = getExtendedPath(env.PATH);
  }

  // Validate that the cwd directory exists before attempting to connect (only for local MCPs)
  // Skip check for registry MCPs since their command/args are resolved dynamically
  if (cwd && !config.registryPackage && !fs.existsSync(cwd)) {
    throw new Error(`MCP server directory not found: ${cwd}. The server may have been deleted.`);
  }


  if (config.portEnvVar && config.port) {
    env[config.portEnvVar] = String(config.port);
  }

  // Allocate a unique port for this MCP server via the PortManager.
  // MCPs that need a UI port (e.g., for WebSocket) read MCP_ASSIGNED_PORT from env.
  // This avoids port conflicts when running multiple MCPs.
  const assignedPort = await portManager.allocate({ serverName });
  env.MCP_ASSIGNED_PORT = String(assignedPort);

  // Pass workspace roots to MCPs that need them (e.g., ide).
  // MCPs can read MCP_WORKING_DIRS (JSON) for multi-root support,
  // or MCP_WORKING_DIR (single path) for backward compatibility.
  const primaryPath = getPrimaryWorkspacePath();
  if (primaryPath) {
    env.MCP_WORKING_DIR = primaryPath;
  }
  if (currentWorkspaceRoots.length > 0) {
    env.MCP_WORKING_DIRS = JSON.stringify(currentWorkspaceRoots);
  }

  // Inject per-MCP storage environment variables (Creature SDK extension).
  // These enable MCPs to persist data scoped by project and server name.
  if (currentProjectId) {
    const storageDir = getMcpStorageDir({ projectId: currentProjectId, serverName });
    env.CREATURE_PROJECT_ID = currentProjectId;
    env.CREATURE_MCP_SERVER_NAME = serverName;
    env.CREATURE_MCP_STORAGE_DIR = storageDir;
  }

  return new StdioClientTransport({
    command: finalCommand,
    args: finalArgs,
    cwd,
    env,
    stderr: "inherit", // Log to terminal; MCP servers should use sendLoggingMessage for structured logs
  });
};

/**
 * Create a new MCP connection.
 *
 * This function handles port allocation and ensures ports are released
 * if connection creation fails at any point.
 */
const createConnection = async (serverName: string): Promise<McpConnection> => {
  // Track whether we allocated a port so we can release it on failure
  let portAllocated = false;

  // Find config - check in order: Development MCP, builtin, project MCPs
  // Dev MCPs take precedence so developers can override built-in MCPs
  let config: MCPServerConfig | undefined;

  // Check if this is a Development MCP first (takes precedence over built-in)
  // This allows developers to work on MCP apps even if they share names with built-ins
  const devRoot = findRootByMcpName(serverName);
  if (devRoot) {
    const mcpDef = getPublishablePackageInfo(devRoot.path);
    if (mcpDef) {
      // For dev-mcp profile projects, ensure dependencies are installed before starting
      // This handles fresh clones, projects with missing node_modules, or production-only deps
      if (currentProjectProfile === "dev-mcp") {
        await installDevMcpDependencies({
          projectPath: devRoot.path,
          serverName,
        });
      }

      const port = await portManager.allocate({ serverName });
      portAllocated = true;
      config = {
        name: mcpDef.name,
        command: "npm",
        args: ["run", "dev"],
        cwd: devRoot.path,
        env: { MCP_PORT: String(port), NODE_ENV: "development" },
        transport: "streamable-http",
        url: `http://localhost:${port}/mcp`,
      };
      console.log(`[MCP] Using dev MCP for ${serverName} at ${devRoot.path} (overrides built-in)`);
    }
  }

  // Fall back to built-in MCPs if no dev MCP found
  if (!config) {
    config = BUILTIN_MCP_SERVERS.find((s) => s.name === serverName);
  }

  // Handle built-in MCPs with paths
  // Vite-compiled built-in MCPs (terminal, ide, browser, todos, notes, crm)
  if (config?.path) {
    if (app.isPackaged) {
      // Packaged mode paths:
      // - Server JS: app.asar/.vite/build/{name}-server.js
      // - UIs: Resources/mcp-uis/{name}/ui/index.html
      // - Native modules: Resources/native-deps/node_modules/
      const mcpUisPath = path.join(process.resourcesPath, "mcp-uis");
      const serverJs = path.join(app.getAppPath(), ".vite", "build", `${serverName}-server.js`);
      const nativeDepsPath = path.join(process.resourcesPath, "native-deps", "node_modules");

      // Set NODE_PATH so externalized native modules can be found
      const baseEnv = {
        ...config.env,
        NODE_PATH: nativeDepsPath,
      };

      if (config.transport === "streamable-http") {
        const port = await portManager.allocate({ serverName });
        portAllocated = true;
        config = {
          ...config,
          cwd: mcpUisPath,
          args: [serverJs],
          url: `http://localhost:${port}/mcp`,
          env: { ...baseEnv, MCP_PORT: String(port) },
        };
      } else {
        // Stdio transport (IDE)
        config = { ...config, cwd: mcpUisPath, args: [serverJs], env: baseEnv };
      }
    } else {
      let usedBuiltinDevServer = false;
      const primaryWorkspacePath = getPrimaryWorkspacePath();
      const mcpSourcePath = findMcpPath(config.path);

      if (currentProjectProfile === "dev-mcp" && primaryWorkspacePath && mcpSourcePath) {
        const normalizedWorkspace = path.resolve(primaryWorkspacePath);
        const normalizedMcpSource = path.resolve(mcpSourcePath);
        const isWithinWorkspace =
          normalizedMcpSource === normalizedWorkspace ||
          normalizedMcpSource.startsWith(`${normalizedWorkspace}${path.sep}`);

        if (isWithinWorkspace) {
          const packageJsonPath = path.join(normalizedMcpSource, "package.json");
          if (fs.existsSync(packageJsonPath)) {
            try {
              const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
                scripts?: Record<string, string>;
              };
              if (packageJson.scripts?.dev) {
                const port = await portManager.allocate({ serverName });
                portAllocated = true;
                config = {
                  ...config,
                  command: "npm",
                  args: ["run", "dev"],
                  cwd: normalizedMcpSource,
                  url: `http://localhost:${port}/mcp`,
                  env: {
                    ...config.env,
                    MCP_PORT: String(port),
                    NODE_ENV: "development",
                  },
                };
                usedBuiltinDevServer = true;
                console.log(`[MCP] Using dev MCP for built-in ${serverName} at ${normalizedMcpSource}`);
              }
            } catch (error) {
              console.warn(`[MCP] Failed to read package.json for ${serverName}`, error);
            }
          }
        }
      }

      if (!usedBuiltinDevServer) {
        // Development: run from workspace root to access hoisted node_modules
        const workspaceRoot = findWorkspaceRoot();
        if (!workspaceRoot) {
          console.warn(`[MCP] Could not find workspace root for ${serverName}`);
          config = undefined;
        } else if (config.transport === "streamable-http") {
          const port = await portManager.allocate({ serverName });
          portAllocated = true;
          config = {
            ...config,
            cwd: workspaceRoot,
            url: `http://localhost:${port}/mcp`,
            env: { ...config.env, MCP_PORT: String(port) },
          };
        } else {
          // Stdio transport (IDE)
          config = { ...config, cwd: workspaceRoot };
        }
      }
    }
  }

  // Check custom MCPs from project config
  if (!config) {
    const userConfig = userMcpConfigs.find((c) => c.name === serverName);
    if (userConfig) {
      config = userConfigToInternal(userConfig);
    }
  }

  if (!config) {
    // Release ports if we allocated them but couldn't find config
    if (portAllocated) {
      portManager.release({ serverName });
    }
    console.error(`[MCP] Server not found: ${serverName}. User configs:`, userMcpConfigs.map(c => c.name));
    throw new Error(`MCP server not found: ${serverName}`);
  }

  // Wrap the rest in try-catch to ensure port cleanup on failure
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  let spawnedProcess: ChildProcess | undefined;

  try {
    if (config.git?.url) {
      if (!currentProjectId) {
        throw new Error("Project ID is required for Git MCPs.");
    }

    const repoDir = getMcpRepoDir({ projectId: currentProjectId, serverName });
    const wasCloned = await ensureGitRepo({ repoDir, url: config.git.url, ref: config.git.ref });
    const appDir = findGitMcpAppDir(repoDir, config.git.subdir);
    const setupCommand = config.git.setupCommand?.trim();
    const startCommand = config.git.startCommand?.trim();
    const gitTransport: MCPTransportType = config.git.transport ?? "streamable-http";

    if (setupCommand) {
      validateCommandLineString({
        commandLine: setupCommand,
        context: `MCP "${serverName}" Git setup command`,
      });
    }

    if (setupCommand) {
      const markerPath = getGitSetupMarkerPath(repoDir);
      if (!fs.existsSync(markerPath)) {
        await runSetupCommand({ commandLine: setupCommand, cwd: appDir });
        writeGitSetupMarker(repoDir, setupCommand);
      }
    } else if (wasCloned || !fs.existsSync(path.join(appDir, "node_modules"))) {
      await ensureNodeModules(appDir);
    }

    let runCommand: string;
    let runArgs: string[];
    let nodeEnv: string | undefined;

    if (startCommand) {
      const parsed = validateCommandLineString({
        commandLine: startCommand,
        context: `MCP "${serverName}" Git start command`,
      });
      runCommand = parsed.command;
      runArgs = parsed.args;
    } else {
      if (gitTransport === "stdio") {
        throw new Error("Start command is required for stdio Git MCPs.");
      }
      const detected = detectGitMcpRunConfig(appDir);
      runCommand = detected.command;
      runArgs = detected.args;
      nodeEnv = detected.nodeEnv;
    }

    validateNodeBasedLaunch({
      command: runCommand,
      args: runArgs,
      context: `MCP "${serverName}" Git run command`,
    });

    const env: Record<string, string> = {
      ...config.env,
      ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}),
    };

    let url: string | undefined;
    if (gitTransport === "streamable-http") {
      const port = await portManager.allocate({ serverName });
      portAllocated = true;
      env.MCP_PORT = String(port);
      url = `http://localhost:${port}/mcp`;
    }

    config = {
      ...config,
      transport: gitTransport,
      command: runCommand,
      args: runArgs,
      cwd: appDir,
      env,
      url,
    };
  }

    // Determine transport type (default to stdio for backwards compatibility)
    const transportType: MCPTransportType = config.transport ?? "stdio";

    // Resolve registry reference first (if present) to determine transport type
    let resolvedConfig: ResolvedDistributionConfig | null = null;
    if (config.registryPackage && (!config.command || config.command === "")) {
      resolvedConfig = await resolveRegistryPackage(config.registryPackage);
    }

    // Determine actual transport type:
    // - remote/cloud → streamable-http (connect to URL)
    // - npm → stdio (run locally)
    // - Otherwise use config.transport or default to stdio
    const isRemoteOrCloud = resolvedConfig?.type === "remote" || resolvedConfig?.type === "cloud";
    const actualTransportType: MCPTransportType = isRemoteOrCloud ? "streamable-http" : transportType;

    if (actualTransportType === "streamable-http") {
      // For HTTP MCPs, either use resolved URL or spawn local process
      if (isRemoteOrCloud && resolvedConfig) {
        // Remote/cloud registry MCP - connect directly to URL
        config = { ...config, url: resolvedConfig.url, transport: "streamable-http" };
      } else if (config.command && config.cwd) {
        // Local HTTP MCP - spawn the process first
        spawnedProcess = await spawnHttpServerProcess(config, serverName);
      }
      transport = createStreamableHttpTransport(config);
    } else {
      // Stdio transport - resolve command/args from registry if needed
      let command = config.command;
      let args = config.args;

      if (resolvedConfig?.type === "npm") {
        command = resolvedConfig.command;
        args = resolvedConfig.args;
      }

      transport = await createStdioTransport(config, serverName, command, args);
      // Stdio transport also allocates a port for MCP_ASSIGNED_PORT
      portAllocated = true;
    }

    const client = new Client(
      {
        name: "creature",
        version: "1.0.0",
      },
      {
        capabilities: {
          sampling: {
            tools: {},
            context: {},
          },
        },
      }
    );

  // Set up MCP protocol logging notification handler.
  // Per MCP spec, servers can send notifications/message for structured logging.
  // This is the spec-compliant way to receive logs from MCP servers.
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    const { level, logger, data } = notification.params;

    // Format the message from data (can be string or object with message field)
    let message: string;
    if (typeof data === "string") {
      message = data;
    } else if (typeof data === "object" && data !== null && "message" in data) {
      // Extract the message field if it exists
      message = String((data as { message: unknown }).message);
    } else {
      message = JSON.stringify(data);
    }

    logAggregator.log({
      source: "mcp",
      sourceName: serverName,
      level: level as LogLevel,
      message,
      data: typeof data === "object" ? data : undefined,
    });
  });

  // Set up storage request handlers for server→client RPC.
  // These allow MCP servers to call back to Creature Desktop for storage operations.
  const createStorageHandler = (method: string) => {
    return async (request: { method: string; params?: unknown }) => {
      try {
        const result = await dispatchStorageMethod(method, serverName, request.params);
        return result;
      } catch (error) {
        console.error(`[MCP Storage] Error handling ${method}:`, error);
        throw error;
      }
    };
  };

  // Register KV storage handlers
  client.setRequestHandler(StorageKvGetRequestSchema, createStorageHandler(STORAGE_METHODS.KV_GET));
  client.setRequestHandler(StorageKvSetRequestSchema, createStorageHandler(STORAGE_METHODS.KV_SET));
  client.setRequestHandler(StorageKvDeleteRequestSchema, createStorageHandler(STORAGE_METHODS.KV_DELETE));
  client.setRequestHandler(StorageKvListRequestSchema, createStorageHandler(STORAGE_METHODS.KV_LIST));
  client.setRequestHandler(StorageKvListWithValuesRequestSchema, createStorageHandler(STORAGE_METHODS.KV_LIST_WITH_VALUES));
  client.setRequestHandler(StorageKvSearchRequestSchema, createStorageHandler(STORAGE_METHODS.KV_SEARCH));
  client.setRequestHandler(StorageVectorUpsertRequestSchema, createStorageHandler(STORAGE_METHODS.VECTOR_UPSERT));
  client.setRequestHandler(StorageVectorSearchRequestSchema, createStorageHandler(STORAGE_METHODS.VECTOR_SEARCH));
  client.setRequestHandler(StorageVectorDeleteRequestSchema, createStorageHandler(STORAGE_METHODS.VECTOR_DELETE));

  // Register Blob storage handlers
  client.setRequestHandler(StorageBlobPutRequestSchema, createStorageHandler(STORAGE_METHODS.BLOB_PUT));
  client.setRequestHandler(StorageBlobGetRequestSchema, createStorageHandler(STORAGE_METHODS.BLOB_GET));
  client.setRequestHandler(StorageBlobDeleteRequestSchema, createStorageHandler(STORAGE_METHODS.BLOB_DELETE));
  client.setRequestHandler(StorageBlobListRequestSchema, createStorageHandler(STORAGE_METHODS.BLOB_LIST));

  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    const params = request.params;

    if (params.task) {
      throw new McpError(ErrorCode.InvalidParams, "Task-based sampling is not supported");
    }

    const credentials = getCredentials();
    if (!credentials) {
      throw new McpError(ErrorCode.InternalError, "No credentials configured");
    }

    const { provider, modelId } = createProvider(credentials);
    const contextText = buildSamplingContextText(params.includeContext, serverName);

    const samplingSettings = getSamplingSettingsForProject();
    const isAllowlisted = samplingSettings.allowlist.includes(serverName);
    const shouldRequestApproval =
      samplingSettings.approvalMode === "per_request" ||
      (samplingSettings.approvalMode === "allowlist" && !isAllowlisted);

    let systemPrompt = params.systemPrompt;
    let messages = params.messages;

    if (shouldRequestApproval) {
      try {
        const approval = await requestSamplingApproval({
          requestId: randomUUID(),
          stage: "request",
          serverName,
          modelId,
          systemPrompt: params.systemPrompt,
          includeContext: params.includeContext,
          contextText,
          messages: params.messages,
          tools: params.tools,
          toolChoice: params.toolChoice,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          stopSequences: params.stopSequences,
          modelPreferences: params.modelPreferences as ModelPreferences | undefined,
          metadata: params.metadata as Record<string, unknown> | undefined,
        });
        systemPrompt = approval.editedSystemPrompt ?? systemPrompt;
        messages = approval.editedMessages ?? messages;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sampling request rejected";
        throw new McpError(ErrorCode.InvalidRequest, message);
      }
    }

    const prompt = buildSamplingPrompt({ systemPrompt, contextText, messages });

    const tools = params.tools?.map(mapMcpToolToModelTool);
    const toolChoice = mapMcpToolChoice(params.toolChoice);

    const model = provider(modelId);
    const providerOptions =
      params.metadata && typeof params.metadata === "object"
        ? (params.metadata as SharedV3ProviderOptions)
        : undefined;
    const result = await model.doGenerate({
      prompt,
      maxOutputTokens: params.maxTokens,
      temperature: params.temperature,
      stopSequences: params.stopSequences,
      tools,
      toolChoice,
      providerOptions,
    });

    const finalBlocks = modelContentToMcpBlocks(result.content);
    const stopReason = (() => {
      const unified = result.finishReason?.unified;
      if (!unified) return undefined;
      if (unified === "length") return "maxTokens";
      if (unified === "tool-calls") return "toolUse";
      if (unified === "stop") {
        return params.stopSequences && params.stopSequences.length > 0 ? "stopSequence" : "endTurn";
      }
      return unified;
    })();

    if (params.tools || params.toolChoice) {
      return {
        model: modelId,
        role: "assistant",
        content: finalBlocks,
        stopReason,
      };
    }

    return {
      model: modelId,
      role: "assistant",
      content: collapseSamplingBlocks(finalBlocks),
      stopReason,
    };
  });


  // Connect with retry and exponential backoff.
  // Even after health check passes, MCP endpoint may need a moment.
  const maxConnectRetries = 5;
  const initialBackoffMs = 500;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxConnectRetries; attempt++) {
    try {
      // For streamable-http, create a fresh transport for each attempt.
      // Transports can only be started once, so retries need new instances.
      if (actualTransportType === "streamable-http" && attempt > 1) {
        transport = createStreamableHttpTransport(config);
      }
      
      await client.connect(transport);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt === maxConnectRetries) {
        console.error(`[MCP] Failed to connect to ${serverName} after ${maxConnectRetries} attempts: ${lastError.message}`);
        throw lastError;
      }

      const backoffMs = initialBackoffMs * Math.pow(2, attempt - 1);
      console.log(`[MCP] Connection attempt ${attempt}/${maxConnectRetries} to ${serverName} failed, retrying in ${backoffMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // Cache tools using shared parsing logic
  let tools = new Map<string, CachedTool>();
  try {
    const toolsResult = await listToolsWithRetry({
      client,
      serverName,
      timeoutMs: findRootByMcpName(serverName) ? 15000 : 5000,
    });
    tools = buildToolsMapFromRawTools({
      serverName,
      rawTools: toolsResult.tools,
    });
  } catch (error) {
    console.error(`[MCP] Failed to list tools from ${serverName}:`, error);
    if (isToolsListNotReadyError(error)) {
      console.warn(`[MCP] ${serverName} does not expose tools/list; continuing with zero tools.`);
    } else {
      scheduleToolsSyncRetry({ serverName, client, delayMs: 2000 });
    }
  }

  // Cache resources
  const resources = new Map<string, CachedResource>();
  try {
    const resourcesResult = await client.listResources();
    for (const r of resourcesResult.resources) {
      // Extract UI metadata from _meta.ui (MCP Apps spec extension)
      const meta = r._meta as {
        ui?: {
          icon?: ResourceIcon;
          views?: Views;
          instanceMode?: "single" | "multiple";
        };
      } | undefined;
      const icon = meta?.ui?.icon;
      const views = meta?.ui?.views;
      const instanceMode = meta?.ui?.instanceMode;

      resources.set(r.uri, {
        uri: r.uri,
        name: r.name,
        mimeType: r.mimeType,
        icon,
        views,
        instanceMode,
      });
    }
  } catch (error) {
    console.error(`[MCP] Failed to list resources from ${serverName}:`, error);
  }

  // Get session ID for streamable-http connections
  let sessionId: string | undefined;
  if (actualTransportType === "streamable-http") {
    sessionId = (transport as StreamableHTTPClientTransport).sessionId;
  }

  // Log single consolidated connect message with tool/resource counts
  const toolNames = Array.from(tools.keys()).join(", ");
  console.log(`[MCP] Connected to ${serverName} (${tools.size} tools: ${toolNames})`);

  const instructions = client.getInstructions();

  const connection: McpConnection = {
    client,
    transport,
    transportType: actualTransportType,
    tools,
    resources,
    resourceCache: new Map(),
    sessionId,
    spawnedProcess,
    instructions,
  };

  // Reconcile the spawn key (serverName) against the server's self-declared name.
  // The MCP protocol handshake is the canonical source of identity — package.json
  // is only used for initial process spawning and discovery.
  const serverVersion = client.getServerVersion();
  const canonicalName = serverVersion?.name || serverName;

  if (canonicalName !== serverName) {
    console.log(`[MCP] Server declared name "${canonicalName}" (spawned as "${serverName}")`);

    // Update devMcpPathToName to reflect the canonical name
    for (const [devPath, mappedName] of devMcpPathToName.entries()) {
      if (mappedName === serverName) {
        devMcpPathToName.set(devPath, canonicalName);
        break;
      }
    }

    // Update project MCP name tracking
    projectMcpNames.delete(serverName);
    projectMcpNames.add(canonicalName);

    // Move connection promise to canonical name
    connectionPromises.delete(serverName);

    // Close old pips that reference the spawn key
    await reconcilePipsForMcp({ mcpName: serverName });

    // Remove old sidebar icon
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("mcp:disabled", { name: serverName });
    }
  }

  connections.set(canonicalName, connection);
  setMcpStatus(canonicalName, "ok");

  // Dev MCP stdout watcher — two independent reload paths.
  //
  // The dev process runs `concurrently "tsx watch ..." "vite build --watch"`.
  // Two distinct signals trigger two independent actions:
  //
  //   "MCP server ready" → tsx watch restarted the inner server.
  //     The process is still running. We soft-reconnect the MCP
  //     transport (close old client, create new client to same port).
  //     No process kill, no respawn, no timing issues.
  //
  //   "App UI reloaded" → vite build --watch rebuilt the HTML.
  //     We refresh all pip iframes with fresh HTML.
  //
  // Both paths are debounced independently. When both signals arrive
  // close together (which they usually do — a server file change
  // triggers tsx restart AND vite rebuild), both actions run. The
  // soft reconnect is fast (~500ms) and the pip refresh reads the
  // freshly built HTML from disk.
  //
  // Because the process is never killed, the stdout watchers remain
  // active for the lifetime of the dev process. No settling delays,
  // no safety-net timers, no missed signals.
  //
  // A brief settling delay (500ms) after initial startup avoids
  // reacting to the boot's "MCP server ready" (which has already
  // fired by the time createConnection reaches this point).
  if (spawnedProcess && actualTransportType === "streamable-http") {
    const storedName = canonicalName;

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const DEBOUNCE_MS = 1000;
    let lastServerReadyAt = 0;
    let lastServerErrorAt = 0;

    /**
     * Detect dev server build errors from stdout/stderr output.
     */
    const isDevServerBuildError = ({ text }: { text: string }): boolean => {
      const normalized = text.toLowerCase();
      return (
        normalized.includes("error [transformerror]") ||
        normalized.includes("transform failed") ||
        normalized.includes("syntaxerror") ||
        normalized.includes("error ts")
      );
    };

    /**
     * Check if a recent server build error should block a pip refresh.
     */
    const shouldBlockPipRefresh = ({ now }: { now: number }): boolean => {
      return lastServerErrorAt > lastServerReadyAt && lastServerErrorAt <= now;
    };

    /**
     * Debounced soft-reconnect. Closes the stale MCP transport and
     * creates a new one to the same port. The dev process stays alive.
     */
    const scheduleReconnect = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(async () => {
        try {
          await softReconnectDevServer({ serverName: storedName });
        } catch (err) {
          console.warn(`[MCP] Dev soft-reconnect failed for ${storedName}:`, err);
        }
      }, DEBOUNCE_MS);
    };

    /**
     * Debounced pip refresh. Reloads all pip iframes with fresh HTML.
     */
    const schedulePipRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        if (shouldBlockPipRefresh({ now: Date.now() })) {
          console.warn(`[MCP] Skipping pip refresh for ${storedName} due to server build error.`);
          return;
        }

        try {
          await refreshAllPipsForMcp({ mcpName: storedName });
        } catch (err) {
          console.warn(`[MCP] Dev pip refresh failed for ${storedName}:`, err);
        }
      }, DEBOUNCE_MS);
    };

    // Start listening after a brief settling delay to skip the
    // initial boot's "MCP server ready" (already fired before
    // createConnection reached this point).
    setTimeout(() => {
      if (spawnedProcess.killed || !connections.has(storedName)) return;

      const onOutput = (data: Buffer) => {
        const text = data.toString();

        if (isDevServerBuildError({ text })) {
          lastServerErrorAt = Date.now();
          console.warn(`[MCP] Dev server build error for ${storedName}.`);
        }

        if (text.includes("MCP server ready")) {
          lastServerReadyAt = Date.now();
          console.log(`[MCP] Dev server restarted: ${storedName}`);
          scheduleReconnect();
        }

        if (text.includes("App UI reloaded")) {
          console.log(`[MCP] UI build complete: ${storedName}`);
          schedulePipRefresh();
        }
      };

      spawnedProcess.stdout?.on("data", onOutput);
      spawnedProcess.stderr?.on("data", onOutput);
    }, 500);
  }

  return connection;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setMcpStatus(serverName, "error", message);
    // Clean up on failure: release port and kill spawned process
    if (portAllocated) {
      portManager.release({ serverName });
    }
    if (spawnedProcess && !spawnedProcess.killed) {
      killProcessTree(spawnedProcess);
    }
    throw error;
  }
};

/**
 * MCP configuration from a cloud project record.
 * Matches the ProjectMcpConfig interface from the projects API.
 */
interface ProjectMcpConfigInput {
  name: string;
  transport?: MCPTransportType;
  url?: string;
  headers?: Record<string, string>;
  git?: { url: string; ref?: string; subdir?: string; setupCommand?: string; startCommand?: string; transport?: MCPTransportType };
  registryPackage?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
}

/**
 * Initialize MCPs for a project.
 * Loads MCPs from the project record and connects to all dev MCP apps.
 *
 * @param params.projectId - The project UUID for storage scoping
 * @param params.workspaceRoots - Array of workspace roots (computed from local_directory + auto-discovered)
 * @param params.profile - Project profile (work, dev-general or dev-mcp)
 * @param params.mcps - MCPs from the project record
 */
export const initMcpsForProject = async ({
  projectId,
  workspaceRoots,
  profile,
  mcps,
}: {
  projectId: string;
  workspaceRoots: WorkspaceRoot[];
  profile: "playground" | "dev-general" | "dev-mcp";
  mcps: ProjectMcpConfigInput[];
}): Promise<void> => {
  console.log(`[MCP] Initializing MCPs for project ${projectId}`);

  // Allow new connections (reset shutdown flag)
  mcpsShutdown = false;

  // Clean up orphaned MCP processes from prior runs before allocating ports.
  await cleanupOrphanedMcpProcesses({ reason: "project-init" });

  // Close any existing connections first
  await closeAllConnections();

  // Update current project state
  currentProjectId = projectId;
  currentWorkspaceRoots = workspaceRoots;
  currentProjectProfile = profile;
  // Store the project's MCP names (flat list - source of truth)
  projectMcpNames = new Set(mcps.map(m => m.name));

  // Store custom MCP configs (non-built-in MCPs need their config)
  userMcpConfigs = mcps
    .filter(m => !isBuiltinMcp(m.name))
    .map((m) => ({
      name: m.name,
      transport: m.transport,
      url: m.url,
      headers: m.headers,
      git: m.git,
      command: m.command,
      args: m.args,
      cwd: m.cwd,
      env: m.env,
      enabled: true,
      scope: "custom" as MCPScope,
    }));

  // Collect dev MCP names from MCP app roots (these take precedence)
  // Track path → name mapping to detect name changes on restart
  devMcpPathToName.clear();
  const devMcpNames: Set<string> = new Set();
  for (const root of workspaceRoots) {
    if (!root.isMcpApp) continue;
    const mcpDef = getPublishablePackageInfo(root.path);
    if (mcpDef) {
      devMcpNames.add(mcpDef.name);
      devMcpPathToName.set(root.path, mcpDef.name);
    }
  }

  // Initialize Development MCPs first (they take precedence over built-in MCPs)
  // Dev MCPs run with `npm run dev` for file-watching during development
  for (const devMcpName of devMcpNames) {
    try {
      await getConnection(devMcpName);
    } catch (error) {
      console.error(`[MCP] Failed to connect to ${devMcpName}:`, error);
    }
  }

  // Initialize MCPs from the project's list (built-in and custom)
  for (const mcpName of projectMcpNames) {
    // Skip if already connected (dev MCP takes precedence)
    if (connections.has(mcpName)) continue;

    try {
      await getConnection(mcpName);
    } catch (error) {
      console.error(`[MCP] Failed to connect to ${mcpName}:`, error);
    }
  }

  console.log(`[MCP] Initialization complete (${connections.size} MCPs)`);
};

/**
 * Close all MCPs when project is closed.
 * Also closes all pips to prevent stale pips from being reused.
 */
export const closeMcpsForProject = async (): Promise<void> => {
  mcpsShutdown = true; // Prevent new connections during shutdown

  // Close all pips first to prevent stale pip reuse on next project load
  await closeAllPips();

  await closeAllConnections();
  currentProjectId = null;
  currentWorkspaceRoots = [];
  currentProjectProfile = null;
  userMcpConfigs = [];
  projectMcpNames = new Set();
  devMcpPathToName.clear();
  mcpStatusByName.clear();
};

/**
 * Close and clean up a single MCP connection by name.
 *
 * Gracefully closes the MCP client, kills transport and spawned processes,
 * releases allocated ports, and removes the connection from tracking maps.
 * No-ops if no connection exists for the given name.
 */
const closeConnection = async ({ name }: { name: string }): Promise<void> => {
  const conn = connections.get(name);
  if (conn) {
    try {
      await Promise.race([
        conn.client.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Client close timeout")), 2000)
        ),
      ]);
    } catch (e) {
      console.error(`[MCP] Error closing ${name}:`, e);
    } finally {
      // Force-kill the transport if it's still active
      // @ts-expect-error - childProcess is not typed but exists on StdioClientTransport
      if (conn.transport.childProcess && !conn.transport.childProcess.killed) {
        // @ts-expect-error - childProcess is not typed but exists on StdioClientTransport
        killProcessTree(conn.transport.childProcess);
      }
      // Kill spawned process for HTTP-based local MCPs
      if (conn.spawnedProcess && !conn.spawnedProcess.killed) {
        killProcessTree(conn.spawnedProcess);
      }
      if (conn.spawnedProcess?.pid) {
        unregisterMcpProcess({ pid: conn.spawnedProcess.pid, serverName: name });
      }
      // Release ports so they can be reused
      portManager.release({ serverName: name });
    }
    connections.delete(name);
  }
  connectionPromises.delete(name);
};

/**
 * Restart a specific MCP server by name.
 *
 * Closes the existing connection (if any), clears cached data,
 * and creates a fresh connection. If the server declares a different
 * canonical name after reconnection, createConnection handles the
 * re-keying and UI cleanup automatically.
 *
 * @param params.name - Server name to restart
 * @param params.config - Optional config for new custom MCPs (not needed for built-in or existing MCPs)
 */
export const restartMcp = async ({ name, config }: { 
  name: string;
  config?: ProjectMcpConfigInput;
}): Promise<void> => {

  // Add to project MCP names if not already there (for newly added MCPs)
  projectMcpNames.add(name);

  // If config is provided for a non-built-in MCP, add/update it in userMcpConfigs
  if (config && !isBuiltinMcp(name)) {
    // Remove existing config if present
    userMcpConfigs = userMcpConfigs.filter(c => c.name !== name);
    // Add the new config
    userMcpConfigs.push({
      name: config.name,
      transport: config.transport,
      url: config.url,
      headers: config.headers,
      git: config.git,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      enabled: true,
      scope: "custom" as MCPScope,
    });
  }

  // Close the connection under `name` if it exists
  await closeConnection({ name });

  // If called with a new name (e.g., after a rename), there may be a stale
  // connection under the old name for the same dev path. Find and close it
  // so we don't end up with duplicate connections and sidebar icons.
  const devRoot = findRootByMcpName(name);
  if (devRoot) {
    const oldName = devMcpPathToName.get(devRoot.path);
    if (oldName && oldName !== name) {
      console.log(`[MCP] Closing stale connection "${oldName}" for dev path ${devRoot.path}`);
      await closeConnection({ name: oldName });

      // Close old pips and sidebar icon immediately
      await reconcilePipsForMcp({ mcpName: oldName });
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("mcp:disabled", { name: oldName });
      }

      projectMcpNames.delete(oldName);
    }
  }

  // Reconnect — createConnection handles name reconciliation if the server
  // declares a different canonical name than what we used to spawn it
  try {
    await getConnection(name);

    // Structural reconciliation only — close pips whose resources no longer exist.
    // HTML refresh happens separately when the UI build completes ("App UI reloaded").
    await reconcilePipsForMcp({ mcpName: name });

    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("mcp:restarted", { name });
    }
  } catch (error) {
    console.error(`[MCP] Failed to restart ${name}:`, error);
    throw error;
  }
};

/**
 * Disable and close a specific MCP server by name.
 * Removes from the project's MCP list and closes the connection.
 * Used when deleting an MCP from project settings.
 */
export const disableMcp = async ({ name }: { name: string }): Promise<void> => {
  projectMcpNames.delete(name);
  await closeConnection({ name });

  console.log(`[MCP] Disconnected from ${name}`);
  mcpStatusByName.delete(name);

  // Notify renderer so sidebar can refresh UI resources
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("mcp:disabled", { name });
  }
};

/**
 * Close all MCP connections.
 *
 * Attempts graceful shutdown with a 2-second timeout per connection.
 * If the server doesn't respond in time, the transport is force-killed.
 * This is expected behavior - MCPs may have active processes that take
 * time to clean up, so the timeout prevents blocking app shutdown.
 */
export const closeAllConnections = async (): Promise<void> => {
  for (const [name, conn] of connections.entries()) {
    let timedOut = false;
    try {
      // For streamable-http, try to terminate the session first
      // Only attempt if the spawned process is still alive
      if (conn.transportType === "streamable-http" && conn.sessionId) {
        const processAlive = conn.spawnedProcess && !conn.spawnedProcess.killed;
        if (processAlive) {
          try {
            await Promise.race([
              (conn.transport as StreamableHTTPClientTransport).terminateSession(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Session termination timeout")), 1000)
              ),
            ]);
          } catch {
            // Session termination may fail if server doesn't support it (405) or already closed
          }
        }
      }

      // Attempt to close client gracefully with a timeout
      await Promise.race([
        conn.client.close(),
        new Promise((_, reject) =>
          setTimeout(() => {
            timedOut = true;
            reject(new Error("timeout"));
          }, 2000)
        ),
      ]);
    } catch (e) {
      // Timeout is expected during shutdown - only log real errors
      if (!timedOut) {
        console.error(`[MCP] Error closing ${name}:`, e);
      }
    } finally {
      // Force-kill the transport if it's a stdio transport and still active
      if (conn.transportType === "stdio") {
        const stdioTransport = conn.transport as StdioClientTransport;
        // @ts-expect-error - childProcess is not typed but exists on StdioClientTransport
        if (stdioTransport.childProcess && !stdioTransport.childProcess.killed) {
          // @ts-expect-error - childProcess is not typed but exists on StdioClientTransport
          killProcessTree(stdioTransport.childProcess);
        }
        // Release ports assigned to this MCP
        portManager.release({ serverName: name });
      }

      // Kill spawned process for HTTP-based local MCPs
      if (conn.spawnedProcess && !conn.spawnedProcess.killed) {
        killProcessTree(conn.spawnedProcess);
        portManager.release({ serverName: name });
      }
      if (conn.spawnedProcess?.pid) {
        unregisterMcpProcess({ pid: conn.spawnedProcess.pid, serverName: name });
      }
    }
  }
  connections.clear();
  connectionPromises.clear();
};

/**
 * Get a specific tool definition.
 */
export const getTool = (
  serverName: string,
  toolName: string
): CachedTool | undefined => {
  const conn = connections.get(serverName);
  return conn?.tools.get(toolName);
};

/**
 * UI Resource info for sidebar display.
 * Contains the minimum info needed to show an icon and launch a pip.
 */
export interface UIResourceInfo {
  serverName: string;
  uri: string;
  name: string;
  icon?: ResourceIcon;
  /** Whether this resource belongs to a dev MCP (the app being developed in a dev-mcp project) */
  _isDev?: boolean;
}

/**
 * Get all UI resources from connected MCP servers.
 * Returns resources with `ui://` URI scheme for sidebar display.
 * Only returns unique resources (one per resourceUri across all servers).
 *
 * In dev-mcp profile, dev MCP resources are sorted to the top of the list
 * so the app being developed is always the first icon in the sidebar.
 */
export const getUIResources = (): UIResourceInfo[] => {
  const resources: UIResourceInfo[] = [];
  const devMcpNames = currentProjectProfile === "dev-mcp"
    ? new Set(devMcpPathToName.values())
    : null;
  
  for (const [serverName, conn] of connections.entries()) {
    for (const resource of conn.resources.values()) {
      // Only include UI resources (ui:// scheme)
      if (resource.uri.startsWith("ui://")) {
        resources.push({
          serverName,
          uri: resource.uri,
          name: resource.name,
          icon: resource.icon,
          _isDev: devMcpNames?.has(serverName) || false,
        });
      }
    }
  }

  // In dev-mcp profile, sort dev MCP resources to the top so the app
  // being developed is always the first icon in the sidebar.
  if (devMcpNames) {
    resources.sort((a, b) => {
      const aIsDev = a._isDev ? 0 : 1;
      const bIsDev = b._isDev ? 0 : 1;
      return aIsDev - bIsDev;
    });
  }
  
  return resources;
};

/**
 * Get valid resource URIs for an MCP server.
 * Used to check if a pip's resourceUri still exists after MCP restart.
 */
export const getResourceUrisForMcp = (serverName: string): Set<string> => {
  const conn = connections.get(serverName);
  if (!conn) return new Set();
  return new Set(conn.resources.keys());
};

/**
 * Parse raw MCP tool definitions into CachedTool entries.
 *
 * Extracts UI metadata, ensures Anthropic-compatible inputSchema,
 * and builds enriched descriptions with display mode info. Factored
 * out of createConnection so the same parsing logic can be reused
 * when refreshing tools for a live connection.
 */
const parseToolsFromServer = ({
  serverName,
  rawTools,
}: {
  serverName: string;
  rawTools: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    _meta?: unknown;
  }>;
}): Map<string, CachedTool> => {
  const tools = new Map<string, CachedTool>();

  for (const t of rawTools) {
    // Extract UI metadata from _meta.ui if present
    // Per MCP Apps spec, non-standard extensions are under `experimental`
    const meta = t._meta as {
      ui?: {
        resourceUri?: string;
        displayModes?: string[];
        experimental?: {
          defaultDisplayMode?: string;
        };
      };
      creature?: {
        auth?: { managed?: boolean };
      };
    } | undefined;

    // Ensure inputSchema has required type: "object" for Anthropic API compatibility
    // Some MCPs may return tools with undefined or empty inputSchema
    const inputSchema = (t.inputSchema as Record<string, unknown>) || { type: "object" };
    if (!inputSchema.type) {
      inputSchema.type = "object";
    }

    // Build description with display mode info for the agent
    let description = t.description || "";
    if (meta?.ui?.displayModes?.length) {
      description += ` [Display modes: ${meta.ui.displayModes.join(", ")}]`;
    }

    tools.set(t.name, {
      name: t.name,
      serverName,
      description,
      inputSchema,
      resourceUri: meta?.ui?.resourceUri,
      displayModes: meta?.ui?.displayModes,
      defaultDisplayMode: meta?.ui?.experimental?.defaultDisplayMode,
      creatureAuth: meta?.creature?.auth,
    });
  }

  return tools;
};

/**
 * Get all tools from all connected servers.
 */
export const getAllTools = (): CachedTool[] => {
  const allTools: CachedTool[] = [];
  for (const conn of connections.values()) {
    for (const tool of conn.tools.values()) {
      allTools.push(tool);
    }
  }
  return allTools;
};

// =============================================================================
// Pending Server Errors
// =============================================================================

/**
 * Represents an error detected from an MCP process or its UI.
 * Buffered and drained by the agent's prepareStep so the model
 * is immediately aware of errors without needing to call devkit_get_logs.
 */
interface PendingAgentError {
  /** Where the error originated: "server" for tsx watch crashes, "ui" for iframe runtime errors */
  source: "server" | "ui";
  serverName: string;
  message: string;
  timestamp: string;
}

/**
 * Buffer for errors detected from MCP processes and their UIs.
 * Drained by the agent's prepareStep hook, which injects them as a system
 * message so the model sees crashes and UI errors immediately and can self-correct.
 */
const pendingAgentErrors: PendingAgentError[] = [];

/**
 * Patterns that indicate a server crash in tsx watch output.
 * These are fatal errors that kill the running server process,
 * which tsx watch then automatically restarts.
 */
const SERVER_CRASH_PATTERNS = [
  /^SyntaxError:/,
  /^TypeError:/,
  /^ReferenceError:/,
  /^Error \[ERR_MODULE_NOT_FOUND\]/,
  /^Error: Cannot find module/,
  /does not provide an export named/,
  /is not a function/,
  /Cannot read properties of (null|undefined)/,
];

/**
 * Buffer a server crash error for the agent to see in the next prepareStep.
 * Called by handleProcessOutput when stderr output matches crash patterns.
 */
const bufferServerError = ({ serverName, message }: { serverName: string; message: string }): void => {
  pendingAgentErrors.push({
    source: "server",
    serverName,
    message,
    timestamp: new Date().toISOString(),
  });
  console.debug(`[MCP] Buffered server error for agent: ${serverName} — ${message.slice(0, 120)}`);
};

/**
 * Buffer a UI runtime error for the agent to see in the next prepareStep.
 * Called by devconsole handlers when an error-level UI log arrives.
 */
export const bufferUiError = ({ serverName, message }: { serverName: string; message: string }): void => {
  pendingAgentErrors.push({
    source: "ui",
    serverName,
    message,
    timestamp: new Date().toISOString(),
  });
  console.debug(`[MCP] Buffered UI error for agent: ${serverName} — ${message.slice(0, 120)}`);
};

/**
 * Drain all pending errors (server + UI) and return them.
 * Called by the agent's prepareStep hook so errors are injected as system
 * messages and the buffer is cleared for the next step.
 */
export const drainPendingAgentErrors = (): PendingAgentError[] => {
  if (pendingAgentErrors.length === 0) return [];
  return pendingAgentErrors.splice(0);
};

/**
 * Get all tool names that use a specific resourceUri.
 * Used to show the agent which tools can use an existing pip.
 */
export const getToolsForResourceUri = (resourceUri: string): string[] => {
  const toolNames: string[] = [];
  for (const conn of connections.values()) {
    for (const tool of conn.tools.values()) {
      if (tool.resourceUri === resourceUri) {
        toolNames.push(tool.name);
      }
    }
  }
  return toolNames;
};

/**
 * MCP info returned for registry publishing.
 * Contains all the metadata collected from a connected MCP server.
 */
export interface McpServerInfo {
  name: string;
  version: string;
  description: string;
  tools: Array<{
    name: string;
    description: string;
    has_ui: boolean;
    display_modes: string[] | null;
  }>;
  resources: Array<{
    uri: string;
    name: string;
    mime_type: string;
    display_modes: string[] | null;
    icon: { data: string; alt: string } | null;
  }>;
}

/**
 * Get MCP server info for registry publishing.
 * Collects name, version, description, tools, and resources from a connected MCP.
 *
 * Will attempt to connect if not already connected.
 */
export const getMcpInfo = async ({
  serverName,
}: {
  serverName: string;
}): Promise<McpServerInfo> => {
  // Try to get existing connection, or create one
  let conn = connections.get(serverName);
  if (!conn) {
    try {
      conn = await getConnection(serverName);
      if (!conn) {
        throw new Error(`MCP unavailable (shutdown in progress)`);
      }
    } catch (error) {
      throw new Error(`MCP server not connected: ${serverName}. ${(error as Error).message}`);
    }
  }

  // Get server version info from the MCP client
  const serverVersion = conn.client.getServerVersion();

  // Map cached tools to registry format
  const tools = Array.from(conn.tools.values()).map((t) => ({
    name: t.name,
    description: t.description || "",
    has_ui: !!t.resourceUri,
    display_modes: t.displayModes || null,
  }));

  // Map cached resources to registry format
  const resources = Array.from(conn.resources.values()).map((r) => ({
    uri: r.uri,
    name: r.name,
    mime_type: r.mimeType || "text/html",
    display_modes: r.displayModes || null,
    icon: r.icon ? { data: r.icon.data, alt: r.icon.alt } : null,
  }));

  return {
    name: serverVersion?.name || serverName,
    version: serverVersion?.version || "0.0.0",
    description: "",
    tools,
    resources,
  };
};


/**
 * Result of reading a UI resource - includes HTML content and icon.
 */
export interface ReadResourceResult {
  html: string;
  /** Custom icon from resource metadata (_meta.ui.icon) */
  icon?: ResourceIcon;
}

/**
 * Exported Views type for control plane.
 */
export type { Views };

/**
 * Resource metadata for pip routing decisions.
 */
export interface ResourceMetadata {
  uri: string;
  name: string;
  /**
   * View routing configuration for this resource.
   * Maps URL-like path patterns to tool names for instance routing.
   */
  views?: Views;
  /** "single" (default) = one pip per resource, "multiple" = view-based routing */
  instanceMode?: "single" | "multiple";
}

/**
 * Get cached resource metadata by URI.
 * Used by control plane for pip routing decisions.
 */
export const getResourceMetadata = ({
  serverName,
  uri,
}: {
  serverName: string;
  uri: string;
}): ResourceMetadata | undefined => {
  const conn = connections.get(serverName);
  if (!conn) return undefined;

  const resource = conn.resources.get(uri);
  if (!resource) return undefined;

  return {
    uri: resource.uri,
    name: resource.name,
    views: resource.views,
    instanceMode: resource.instanceMode,
  };
};

/**
 * Read a UI resource, inject CSP, and cache its HTML content.
 *
 * The CSP is extracted from the resource's _meta.ui.csp field and injected
 * as a <meta> tag per the MCP Apps specification.
 *
 * The icon is extracted from _meta.ui.icon (MCP Apps spec extension).
 * Icon precedence: content _meta > cached resource list _meta
 */
export const readResource = async ({
  serverName,
  uri,
}: {
  serverName: string;
  uri: string;
}): Promise<ReadResourceResult> => {
  const executeRead = async (): Promise<ReadResourceResult> => {
    const conn = await getConnection(serverName);
    if (!conn) {
      throw new Error(`MCP unavailable (shutdown in progress)`);
    }

    // Check cache first
    const cached = conn.resourceCache.get(uri);
    if (cached) return cached;

    const result = await conn.client.readResource({ uri });
    const content = result.contents[0] as {
      text?: string;
      blob?: string;
      _meta?: {
        ui?: {
          csp?: CspConfig;
          icon?: ResourceIcon;
        };
      };
    };

    let html = content.text ?? "";

    // Extract CSP from resource metadata and inject into HTML
    const csp = content._meta?.ui?.csp;
    if (html) {
      html = injectCSP({ html, csp });
      // Inject console override script to capture UI Resource logs
      html = injectConsoleOverride({ html });
    }

    // Extract icon from content _meta, fallback to cached resource list metadata
    const cachedResourceMeta = conn.resources.get(uri);
    const icon = content._meta?.ui?.icon ?? cachedResourceMeta?.icon;

    const resourceResult: ReadResourceResult = { html, icon };

    // Cache for future requests
    conn.resourceCache.set(uri, resourceResult);

    return resourceResult;
  };

  try {
    return await executeRead();
  } catch (error) {
    if (isSessionInvalidError(error)) {
      const conn = connections.get(serverName);
      const isProcessAlive = !!conn?.spawnedProcess && conn.spawnedProcess.exitCode === null;

      if (isProcessAlive && !app.isPackaged) {
        clearResourceCache({ serverName, uri });
        try {
          return await executeRead();
        } catch {
          // Fall through to reconnect on repeated session errors
        }
      }

      await reconnectServer(serverName);
      return executeRead();
    }
    throw error;
  }
};

/**
 * Clear a specific resource from the cache.
 * Used when refreshing a pip's UI content without restarting the server.
 */
export const clearResourceCache = ({
  serverName,
  uri,
}: {
  serverName: string;
  uri: string;
}): boolean => {
  const conn = connections.get(serverName);
  if (!conn) return false;
  return conn.resourceCache.delete(uri);
};

/**
 * Call a tool on an MCP server.
 */
const isSessionInvalidError = (error: unknown): boolean => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorCode = (error as { code?: number }).code;
  return errorCode === 404 || 
         errorCode === 400 ||
         errorMessage.includes("Session not found") || 
         errorMessage.includes("No valid session ID");
};

/**
 * Detect whether a tools/list call failed because the server is not ready yet.
 *
 * This is a transient startup condition where the server responds with
 * a JSON-RPC -32601 "Method not found" before handlers are fully registered.
 */
const isToolsListNotReadyError = (error: unknown): boolean => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return errorMessage.includes("Method not found") || errorMessage.includes("-32601");
};

/**
 * List tools with a short retry window to avoid startup races.
 *
 * Retries only on the transient "Method not found" response that can occur
 * before the server finishes registering handlers.
 */
const listToolsWithRetry = async ({
  client,
  serverName,
  timeoutMs = 15000,
  initialBackoffMs = 200,
  maxBackoffMs = 2000,
}: {
  client: Client;
  serverName: string;
  timeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}): Promise<Awaited<ReturnType<Client["listTools"]>>> => {
  const startTime = Date.now();
  let attempt = 0;
  let lastError: Error | undefined;
  let backoffMs = initialBackoffMs;

  while (true) {
    attempt += 1;
    try {
      return await client.listTools();
    } catch (error) {
      if (!isToolsListNotReadyError(error)) {
        throw error;
      }

      lastError = error instanceof Error ? error : new Error(String(error));
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs >= timeoutMs) {
        console.warn(
          `[MCP] tools/list not ready after ${attempt} attempts (${elapsedMs}ms) for ${serverName}: ${lastError.message}`
        );
        throw lastError;
      }

      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
    }
  }
};

/**
 * Build a cached tool map from raw MCP tool definitions.
 */
const buildToolsMapFromRawTools = ({
  serverName,
  rawTools,
}: {
  serverName: string;
  rawTools: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    _meta?: unknown;
  }>;
}): Map<string, CachedTool> => {
  const tools = parseToolsFromServer({ serverName, rawTools });

  for (const t of rawTools) {
    const meta = t._meta as {
      ui?: {
        resourceUri?: string;
        displayModes?: string[];
        experimental?: {
          defaultDisplayMode?: string;
          openInBackground?: boolean;
        };
      };
      creature?: {
        auth?: { managed?: boolean };
      };
    } | undefined;

    const inputSchema = (t.inputSchema as Record<string, unknown>) || { type: "object" };
    if (!inputSchema.type) {
      inputSchema.type = "object";
    }

    let description = t.description || "";
    if (meta?.ui?.displayModes?.length) {
      description += ` [Display modes: ${meta.ui.displayModes.join(", ")}]`;
    }

    tools.set(t.name, {
      name: t.name,
      serverName,
      description,
      inputSchema,
      resourceUri: meta?.ui?.resourceUri,
      displayModes: meta?.ui?.displayModes,
      defaultDisplayMode: meta?.ui?.experimental?.defaultDisplayMode,
      openInBackground: meta?.ui?.experimental?.openInBackground,
      creatureAuth: meta?.creature?.auth,
    });
  }

  return tools;
};

/**
 * Track background tool sync timers for servers that were not ready at connect time.
 */
const toolsSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Retry tools/list in the background until it succeeds.
 */
const scheduleToolsSyncRetry = ({
  serverName,
  client,
  delayMs,
}: {
  serverName: string;
  client: Client;
  delayMs: number;
}): void => {
  if (toolsSyncTimers.has(serverName)) return;

  const timer = setTimeout(async () => {
    toolsSyncTimers.delete(serverName);
    const conn = connections.get(serverName);
    if (!conn || conn.client !== client) return;

    try {
      const toolsResult = await listToolsWithRetry({
        client,
        serverName,
        timeoutMs: 30000,
      });

      conn.tools = buildToolsMapFromRawTools({
        serverName,
        rawTools: toolsResult.tools,
      });

      const toolNames = Array.from(conn.tools.keys()).join(", ");
      console.log(`[MCP] Tools ready for ${serverName} (${conn.tools.size} tools: ${toolNames})`);
    } catch {
      scheduleToolsSyncRetry({
        serverName,
        client,
        delayMs: Math.min(delayMs * 2, 10000),
      });
    }
  }, delayMs);

  toolsSyncTimers.set(serverName, timer);
};

/**
 * Per-server reconnect lock.
 * Prevents concurrent reconnects from racing and spawning duplicate processes.
 * Multiple sources can trigger reconnection simultaneously (stdout watcher,
 * session-invalid errors in readResource/callTool). Without this lock, each
 * call would kill the process and spawn a new one, creating 2-3 duplicate
 * processes that corrupt the connection state.
 */
const reconnectLocks = new Map<string, Promise<void>>();

/**
 * Soft-reconnect a dev MCP server's transport.
 *
 * Unlike reconnectServer (which kills the process and respawns it),
 * this only closes the MCP client transport and creates a new one
 * pointing at the same URL. The dev process (tsx watch + vite build
 * --watch) stays alive, so stdout watchers remain active and there
 * are no timing issues with vite rebuilds.
 *
 * Used when tsx watch restarts the inner server: the process is
 * still running, but the old MCP session is dead. We just need a
 * fresh transport to the same port.
 *
 * Serialized per server via reconnectLocks.
 */
const softReconnectDevServer = async ({ serverName }: { serverName: string }): Promise<void> => {
  const existingLock = reconnectLocks.get(serverName);
  if (existingLock) {
    console.debug(`[PipLifecycle] softReconnect WAITING (already in progress) ${serverName}`);
    await existingLock;
    return;
  }

  let resolveLock: () => void = () => {};
  const lock = new Promise<void>((resolve) => { resolveLock = resolve; });
  reconnectLocks.set(serverName, lock);

  try {
    const conn = connections.get(serverName);
    if (!conn) {
      console.warn(`[MCP] softReconnect: no connection for ${serverName}`);
      return;
    }

    console.debug(`[PipLifecycle] softReconnect START ${serverName}`);

    // 1. Close old client transport (NOT the process)
    try {
      await Promise.race([
        conn.client.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Client close timeout")), 2000)
        ),
      ]);
    } catch (e) {
      console.debug(`[MCP] softReconnect: old client close error (expected): ${e}`);
    }

    // 2. Derive URL from the port manager's assignment
    const port = portManager.getAssigned({ serverName });
    if (!port) {
      console.error(`[MCP] softReconnect: no port found for ${serverName}`);
      return;
    }
    const url = new URL(`http://localhost:${port}/mcp`);

    // 3. Create new client with all handlers
    const client = new Client(
      { name: "creature", version: "1.0.0" },
      { capabilities: { sampling: { tools: {}, context: {} } } }
    );

    // Logging handler
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      const { level, data } = notification.params;
      let message: string;
      if (typeof data === "string") {
        message = data;
      } else if (typeof data === "object" && data !== null && "message" in data) {
        message = String((data as { message: unknown }).message);
      } else {
        message = JSON.stringify(data);
      }
      logAggregator.log({
        source: "mcp",
        sourceName: serverName,
        level: level as LogLevel,
        message,
        data: typeof data === "object" ? data : undefined,
      });
    });

    // Storage handlers
    const createStorageHandler = (method: string) => {
      return async (request: { method: string; params?: unknown }) => {
        try {
          return await dispatchStorageMethod(method, serverName, request.params);
        } catch (error) {
          console.error(`[MCP Storage] Error handling ${method}:`, error);
          throw error;
        }
      };
    };
    client.setRequestHandler(StorageKvGetRequestSchema, createStorageHandler(STORAGE_METHODS.KV_GET));
    client.setRequestHandler(StorageKvSetRequestSchema, createStorageHandler(STORAGE_METHODS.KV_SET));
    client.setRequestHandler(StorageKvDeleteRequestSchema, createStorageHandler(STORAGE_METHODS.KV_DELETE));
    client.setRequestHandler(StorageKvListRequestSchema, createStorageHandler(STORAGE_METHODS.KV_LIST));
    client.setRequestHandler(StorageKvListWithValuesRequestSchema, createStorageHandler(STORAGE_METHODS.KV_LIST_WITH_VALUES));
    client.setRequestHandler(StorageKvSearchRequestSchema, createStorageHandler(STORAGE_METHODS.KV_SEARCH));
    client.setRequestHandler(StorageVectorUpsertRequestSchema, createStorageHandler(STORAGE_METHODS.VECTOR_UPSERT));
    client.setRequestHandler(StorageVectorSearchRequestSchema, createStorageHandler(STORAGE_METHODS.VECTOR_SEARCH));
    client.setRequestHandler(StorageVectorDeleteRequestSchema, createStorageHandler(STORAGE_METHODS.VECTOR_DELETE));
    client.setRequestHandler(StorageBlobPutRequestSchema, createStorageHandler(STORAGE_METHODS.BLOB_PUT));
    client.setRequestHandler(StorageBlobGetRequestSchema, createStorageHandler(STORAGE_METHODS.BLOB_GET));
    client.setRequestHandler(StorageBlobDeleteRequestSchema, createStorageHandler(STORAGE_METHODS.BLOB_DELETE));
    client.setRequestHandler(StorageBlobListRequestSchema, createStorageHandler(STORAGE_METHODS.BLOB_LIST));

    // Sampling handler (simplified — dev MCPs rarely use sampling)
    client.setRequestHandler(CreateMessageRequestSchema, async () => {
      throw new McpError(ErrorCode.InvalidRequest, "Sampling not supported during soft reconnect");
    });

    // 4. Connect with retry
    const maxRetries = 5;
    const initialBackoffMs = 500;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const transport = new StreamableHTTPClientTransport(url);
        await client.connect(transport);
        conn.transport = transport;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === maxRetries) {
          console.error(`[MCP] softReconnect failed after ${maxRetries} attempts: ${lastError.message}`);
          throw lastError;
        }
        const backoffMs = initialBackoffMs * Math.pow(2, attempt - 1);
        console.log(`[MCP] softReconnect attempt ${attempt}/${maxRetries} for ${serverName} failed, retrying in ${backoffMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    // 5. Refresh tools and resources
    let tools = new Map<string, CachedTool>();
    try {
      const toolsResult = await listToolsWithRetry({
        client,
        serverName,
        timeoutMs: findRootByMcpName(serverName) ? 15000 : 5000,
      });
      tools = buildToolsMapFromRawTools({
        serverName,
        rawTools: toolsResult.tools,
      });
    } catch (error) {
      console.error(`[MCP] softReconnect: failed to list tools from ${serverName}:`, error);
      if (isToolsListNotReadyError(error)) {
        console.warn(`[MCP] ${serverName} does not expose tools/list; continuing with zero tools.`);
      } else {
        scheduleToolsSyncRetry({ serverName, client, delayMs: 2000 });
      }
    }

    const resources = new Map<string, CachedResource>();
    try {
      const resourcesResult = await client.listResources();
      for (const r of resourcesResult.resources) {
        const meta = r._meta as {
          ui?: {
            icon?: ResourceIcon;
            views?: Views;
            instanceMode?: "single" | "multiple";
          };
        } | undefined;
        resources.set(r.uri, {
          uri: r.uri,
          name: r.name,
          mimeType: r.mimeType,
          icon: meta?.ui?.icon,
          views: meta?.ui?.views,
          instanceMode: meta?.ui?.instanceMode,
        });
      }
    } catch (error) {
      console.error(`[MCP] softReconnect: failed to list resources from ${serverName}:`, error);
    }

    // 6. Update connection record in place (keep spawnedProcess, transportType)
    conn.client = client;
    conn.tools = tools;
    conn.resources = resources;
    conn.resourceCache = new Map();
    conn.sessionId = (conn.transport as StreamableHTTPClientTransport).sessionId;
    conn.instructions = client.getInstructions();

    // 7. Structural reconciliation — close pips whose resources no longer exist
    await reconcilePipsForMcp({ mcpName: serverName });

    // 8. Notify renderer so sidebar refreshes resource list
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("mcp:restarted", { name: serverName });
    }

    const toolNames = Array.from(tools.keys()).join(", ");
    console.log(`[MCP] Soft-reconnected to ${serverName} (${tools.size} tools: ${toolNames})`);
  } finally {
    resolveLock();
    if (reconnectLocks.get(serverName) === lock) {
      reconnectLocks.delete(serverName);
    }
  }
};

/**
 * Reconnect to an MCP server after a session error or dev server restart.
 *
 * Serialized per server: if a reconnect is already in progress, subsequent
 * callers wait for it to complete rather than starting their own. This
 * prevents the duplicate-process-spawning bug.
 *
 * Closes the existing connection and creates a fresh one. If the server
 * declares a different canonical name after reconnection (e.g., the developer
 * renamed it), createConnection handles the re-keying and UI cleanup.
 *
 * Performs structural reconciliation (closing pips whose resources no longer
 * exist) but does NOT reload pip HTML — the caller handles that via
 * refreshAllPipsForMcp after reconnection completes.
 */
const reconnectServer = async (serverName: string): Promise<void> => {
  // If a reconnect is already in progress, wait for it instead of starting another
  const existingLock = reconnectLocks.get(serverName);
  if (existingLock) {
    console.debug(`[PipLifecycle] reconnectServer WAITING (already in progress) ${serverName}`);
    await existingLock;
    return;
  }

  let resolveLock: () => void = () => {};
  const lock = new Promise<void>((resolve) => { resolveLock = resolve; });
  reconnectLocks.set(serverName, lock);

  try {
    console.debug(`[PipLifecycle] reconnectServer START ${serverName}`);
    await closeConnection({ name: serverName });

    // Create new connection — createConnection handles name reconciliation
    await getConnection(serverName);

    // Structural reconciliation — close pips whose resources no longer exist
    await reconcilePipsForMcp({ mcpName: serverName });

    // Notify renderer so sidebar refreshes resource list
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("mcp:restarted", { name: serverName });
    }

    console.log(`[MCP] Reconnected to ${serverName}`);
  } finally {
    resolveLock();
    if (reconnectLocks.get(serverName) === lock) {
      reconnectLocks.delete(serverName);
    }
  }
};


/**
 * Call a tool on an MCP server.
 *
 * Optionally injects Creature auth token for servers that opted in.
 * Token is passed via a special `_creatureToken` arg that the SDK extracts
 * and exposes via `context.creatureToken` in tool handlers.
 *
 * @param serverName - Name of the MCP server
 * @param toolName - Name of the tool to call
 * @param args - Tool arguments
 * @param creatureToken - Optional Creature App Token to inject
 */
export const callTool = async ({
  serverName,
  toolName,
  args,
  creatureToken,
}: {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  creatureToken?: string;
}): Promise<unknown> => {
  const startTime = Date.now();

  const executeCall = async (): Promise<unknown> => {
    const conn = await getConnection(serverName);
    if (!conn) {
      throw new Error(`MCP unavailable (shutdown in progress)`);
    }

    // Inject Creature token as a special arg (SDK extracts this into context)
    const argsWithToken = creatureToken
      ? { ...args, _creatureToken: creatureToken }
      : args;

    return conn.client.callTool({
      name: toolName,
      arguments: argsWithToken,
    });
  };

  try {
    const result = await executeCall();
    const durationMs = Date.now() - startTime;

    // Track successful tool call
    telemetry.track("mcp_tool_call", {
      server_name: serverName,
      tool_name: toolName,
      duration_ms: durationMs,
      success: true,
    });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;

    // Shutdown errors are expected - don't log or retry
    const isShutdownError = error instanceof Error && error.message.includes("shutdown in progress");
    if (isShutdownError) {
      throw error;
    }


    if (isSessionInvalidError(error)) {
      await reconnectServer(serverName);
      const retryStartTime = Date.now();
      try {
        const result = await executeCall();
        const retryDurationMs = Date.now() - retryStartTime;

        // Track successful retry
        telemetry.track("mcp_tool_call", {
          server_name: serverName,
          tool_name: toolName,
          duration_ms: retryDurationMs,
          success: true,
          was_retry: true,
        });

        return result;
      } catch (retryError) {
        const retryDurationMs = Date.now() - retryStartTime;

        // Track failed retry
        telemetry.track("mcp_tool_call", {
          server_name: serverName,
          tool_name: toolName,
          duration_ms: retryDurationMs,
          success: false,
          was_retry: true,
          error_type: retryError instanceof Error ? retryError.name : "Unknown",
        });

        throw retryError;
      }
    }

    // Track failed tool call
    telemetry.track("mcp_tool_call", {
      server_name: serverName,
      tool_name: toolName,
      duration_ms: durationMs,
      success: false,
      error_type: error instanceof Error ? error.name : "Unknown",
    });

    throw error;
  }
};
