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
import { tool } from "ai";
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
import { closeAllPips, getPipInstances, refreshPipsForMcp } from "./controlPlane";
import { logAggregator, type LogLevel } from "../logging";
import { portManager } from "./portManager";
import { findWorkspaceRoot } from "../utils/workspace";
import { getMcpStorageDir } from "../storage/mcpStorageDir";
import { getMcpRepoDir } from "../storage/mcpRepoDir";
import { dispatchStorageMethod, isStorageMethod, STORAGE_METHODS } from "./storage";
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
 * Kill a process and all its children.
 * On Windows, uses taskkill to kill the entire process tree since child processes
 * don't automatically terminate when the parent is killed.
 * On Unix, uses regular kill() which works with process groups.
 */
const killProcessTree = (proc: ChildProcess): void => {
  if (!proc.pid) return;
  
  if (process.platform === "win32") {
    // /T = tree kill (all child processes), /F = force
    exec(`taskkill /pid ${proc.pid} /T /F`, (err) => {
      if (err) {
        console.log(`[MCP] taskkill failed (process may have already exited):`, err.message);
      }
    });
  } else {
    proc.kill();
  }
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
  /**
   * Indicates this is an app-style MCP (like todos/notes) with its own build system.
   */
  isAppMcp?: boolean;
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

const normalizeFileData = (data: unknown): string => {
  if (typeof data === "string") return data;
  if (data instanceof URL) return data.toString();
  if (data instanceof Uint8Array) {
    return Buffer.from(data).toString("base64");
  }
  return JSON.stringify(data);
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
      const data = normalizeFileData(part.data);
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

// Flag to prevent MCP re-initialization during shutdown
// Set true when closing MCPs, false when initializing new project
let mcpsShutdown = false;

// Track dev MCP folder paths to their current server names
// Used to detect when a dev MCP's name changes after code rewrite
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
 * Find a workspace root by MCP app server name.
 * MCP app names come from their package.json name field.
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

const splitCommandLine = (input: string): string[] => {
  const result: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escape = false;

  for (const char of input.trim()) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escape = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    result.push(current);
  }

  return result;
};

const parseCommandLine = (input: string): { command: string; args: string[] } => {
  const parts = splitCommandLine(input);
  if (parts.length === 0) {
    throw new Error("Command is empty.");
  }
  return { command: parts[0], args: parts.slice(1) };
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
  const { command, args } = parseCommandLine(commandLine);
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
    args: ["dist/server/index.js"],
    isAppMcp: true,
  },
  {
    name: "notes",
    path: "mcp-notes",
    transport: "streamable-http",
    command: "node",
    args: ["dist/server/index.js"],
    isAppMcp: true,
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

  // Development: MCPs are now in desktop/src/electron/mcps/
  // Extract the MCP name (e.g., "mcp-ide" -> "ide")
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
  });

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

  // Pass workspace roots to MCPs that need them (e.g., mcp-ide).
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

  // Find config - check in order: builtin, Development MCP, project MCPs
  let config: MCPServerConfig | undefined = BUILTIN_MCP_SERVERS.find((s) => s.name === serverName);

  // Handle built-in MCPs with paths
  if (config?.path) {
    // App-style MCPs (todos, notes) have their own build system
    if (config.isAppMcp) {
      if (app.isPackaged) {
        // Packaged mode: run from Resources/{path}/
        const mcpAppPath = path.join(process.resourcesPath, config.path);
        const port = await portManager.allocate({ serverName });
        portAllocated = true;
        config = {
          ...config,
          cwd: mcpAppPath,
          args: ["dist/server/index.js"],
          url: `http://localhost:${port}/mcp`,
          env: { ...config.env, MCP_PORT: String(port) },
        };
      } else {
        // Development: run from artifacts/mcp-apps/{name}/
        const workspaceRoot = findWorkspaceRoot();
        if (!workspaceRoot) {
          console.warn(`[MCP] Could not find workspace root for ${serverName}`);
          config = undefined;
        } else {
          const mcpAppPath = path.join(workspaceRoot, "desktop", "artifacts", "mcp-apps", serverName);
          if (!fs.existsSync(mcpAppPath)) {
            console.warn(`[MCP] App MCP not found at ${mcpAppPath}`);
            config = undefined;
          } else {
            const port = await portManager.allocate({ serverName });
            portAllocated = true;
            config = {
              ...config,
              cwd: mcpAppPath,
              args: ["dist/server/index.js"],
              url: `http://localhost:${port}/mcp`,
              env: { ...config.env, MCP_PORT: String(port) },
            };
          }
        }
      }
    } else {
      // Vite-compiled built-in MCPs (terminal, ide, browser)
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

  // Check if this is a Development MCP (search across all MCP app roots)
  if (!config) {
    const root = findRootByMcpName(serverName);
    if (root) {
      const mcpDef = getPublishablePackageInfo(root.path);
      if (mcpDef) {
        const port = await portManager.allocate({ serverName });
        portAllocated = true;
        config = {
          name: mcpDef.name,
          command: "npm",
          args: ["run", "dev"],
          cwd: root.path,
          env: { MCP_PORT: String(port), NODE_ENV: "development" },
          transport: "streamable-http",
          url: `http://localhost:${port}/mcp`,
        };
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
    // Release port if we allocated one but couldn't find config
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
      const parsed = parseCommandLine(startCommand);
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

    let approval;
    try {
      approval = await requestSamplingApproval({
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sampling request rejected";
      throw new McpError(ErrorCode.InvalidRequest, message);
    }

    const systemPrompt = approval.editedSystemPrompt ?? params.systemPrompt;
    const messages = approval.editedMessages ?? params.messages;
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

    const outputBlocks = modelContentToMcpBlocks(result.content);

    let review;
    try {
      review = await requestSamplingApproval({
        requestId: approval.requestId,
        stage: "review",
        serverName,
        modelId,
        content: outputBlocks,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sampling response rejected";
      throw new McpError(ErrorCode.InvalidRequest, message);
    }

    const finalBlocks = review.editedContent ?? outputBlocks;
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

  // Cache tools
  const tools = new Map<string, CachedTool>();
  try {
    const toolsResult = await client.listTools();
    for (const t of toolsResult.tools) {
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
  } catch (error) {
    console.error(`[MCP] Failed to list tools from ${serverName}:`, error);
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

  connections.set(config.name, connection);
  setMcpStatus(serverName, "ok");

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

  // Initialize Development MCPs first (they take precedence)
  // TODO: Remove this skip once template issues are resolved
  const SKIP_DEV_MCPS = ["todos", "notes", "crm"];
  for (const devMcpName of devMcpNames) {
    if (SKIP_DEV_MCPS.includes(devMcpName)) {
      continue;
    }
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
 * Restart a specific MCP server by name.
 *
 * Closes the existing connection (if any), clears cached data,
 * and creates a fresh connection. Useful after changing dev mode
 * or other settings that require a full server restart.
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

  // Close existing connection if present
  const existing = connections.get(name);
  if (existing) {
    try {
      await Promise.race([
        existing.client.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Client close timeout")), 2000)
        ),
      ]);
    } catch (e) {
      console.error(`[MCP] Error closing ${name}:`, e);
    } finally {
      // Force-kill the transport if it's still active
      // @ts-expect-error - childProcess is not typed but exists on StdioClientTransport
      if (existing.transport.childProcess && !existing.transport.childProcess.killed) {
        // @ts-expect-error - childProcess is not typed but exists on StdioClientTransport
        killProcessTree(existing.transport.childProcess);
      }
      // Kill spawned process for HTTP-based local MCPs
      if (existing.spawnedProcess && !existing.spawnedProcess.killed) {
        killProcessTree(existing.spawnedProcess);
      }
      // Release the port so it can be reused on reconnect
      portManager.release({ serverName: name });
    }
    connections.delete(name);
  }

  // Clear any pending connection promise
  connectionPromises.delete(name);

  // Reconnect
  try {
    await getConnection(name);

    // Refresh any pips using this MCP with fresh content
    await refreshPipsForMcp({ mcpName: name });

    // Notify renderer (for any additional handling)
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

  // Remove from project MCP names
  projectMcpNames.delete(name);

  // Close existing connection if present
  const existing = connections.get(name);
  if (existing) {
    try {
      await Promise.race([
        existing.client.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Client close timeout")), 2000)
        ),
      ]);
    } catch (e) {
      console.error(`[MCP] Error closing ${name}:`, e);
    } finally {
      // Force-kill the transport if it's still active
      // @ts-expect-error - childProcess is not typed but exists on StdioClientTransport
      if (existing.transport.childProcess && !existing.transport.childProcess.killed) {
        // @ts-expect-error - childProcess is not typed but exists on StdioClientTransport
        killProcessTree(existing.transport.childProcess);
      }
      // Kill spawned process for HTTP-based local MCPs
      if (existing.spawnedProcess && !existing.spawnedProcess.killed) {
        killProcessTree(existing.spawnedProcess);
      }
      // Release the port so it can be reused
      portManager.release({ serverName: name });
    }
    connections.delete(name);
  }

  // Clear any pending connection promise
  connectionPromises.delete(name);

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
        // Release the port assigned to this MCP (only for stdio since they use local ports)
        portManager.release({ serverName: name });
      }

      // Kill spawned process for HTTP-based local MCPs
      if (conn.spawnedProcess && !conn.spawnedProcess.killed) {
        killProcessTree(conn.spawnedProcess);
        portManager.release({ serverName: name });
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
}

/**
 * Get all UI resources from connected MCP servers.
 * Returns resources with `ui://` URI scheme for sidebar display.
 * Only returns unique resources (one per resourceUri across all servers).
 */
export const getUIResources = (): UIResourceInfo[] => {
  const resources: UIResourceInfo[] = [];
  
  for (const [serverName, conn] of connections.entries()) {
    for (const resource of conn.resources.values()) {
      // Only include UI resources (ui:// scheme)
      if (resource.uri.startsWith("ui://")) {
        resources.push({
          serverName,
          uri: resource.uri,
          name: resource.name,
          icon: resource.icon,
        });
      }
    }
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
 * Convert JSON Schema to Zod schema for AI SDK tools.
 * Recursively handles nested object schemas.
 */
const jsonSchemaToZod = (schema: Record<string, unknown>): z.ZodType => {
  // Handle undefined/null schemas
  if (!schema || typeof schema !== "object") {
    return z.object({});
  }

  const type = schema.type as string;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = schema.required as string[] | undefined;

  // Handle object type (with or without properties)
  if (type === "object") {
    if (properties) {
      const shape: Record<string, z.ZodType> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        let propZod = jsonSchemaToZod(propSchema);
        if (!required?.includes(key)) {
          propZod = propZod.optional();
        }
        shape[key] = propZod;
      }
      return z.object(shape);
    }
    // Object without properties - return empty object schema
    return z.object({});
  }

  if (type === "string") return z.string();
  if (type === "number") return z.number();
  if (type === "integer") return z.number().int();
  if (type === "boolean") return z.boolean();
  if (type === "array") return z.array(z.unknown());

  // Default to empty object for unknown/missing types (Anthropic requires type field)
  return z.object({});
};

/**
 * Get MCP tools formatted for the AI agent.
 * Routes tool calls through the provided handleToolCall function.
 *
 * All agent-initiated tool calls are marked with source: 'agent' to distinguish
 * them from UI-initiated calls. This prevents duplicate entries in conversation
 * history since agent calls are already tracked by the AI SDK.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getMcpToolsForAgent = async (
  handleToolCall: (params: {
    serverName: string;
    toolName: string;
    args: Record<string, unknown>;
    instanceId?: string;
    source: "agent" | "ui";
  }) => Promise<unknown>
): Promise<Record<string, unknown>> => {
  // MCPs are initialized when folder is opened, just get cached tools
  const allTools = getAllTools();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentTools: Record<string, any> = {};

  for (const t of allTools) {
    // Use the MCP tool's inputSchema directly - no _meta injection needed.
    // Pip routing is handled by Control Plane via instanceId lookup when
    // the agent passes instanceId in the tool args.
    const zodSchema = jsonSchemaToZod(t.inputSchema);

    agentTools[t.name] = tool({
      description: t.description,
      inputSchema: zodSchema,
      // providerOptions: {
      //   anthropic: {
      //     cacheControl: { type: 'ephemeral' }
      //   }
      // },
      execute: async (args: Record<string, unknown>) => {
        try {
          // Route through handleToolCall in controlPlane.
          // Control Plane will look up the pip by instanceId if present in args.
          // Mark as 'agent' source - these calls are already in the AI SDK's conversation history.
          const result = await handleToolCall({
            serverName: t.serverName,
            toolName: t.name,
            args,
            source: "agent",
          });
          return result;
        } catch (error) {
          console.error(`[Agent Tool] ${t.name} failed:`, error);
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
  }

  return agentTools;
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

const reconnectServer = async (serverName: string): Promise<void> => {
  // Check if this is a dev MCP that may have changed names
  let devMcpPath: string | null = null;
  for (const [path, name] of devMcpPathToName.entries()) {
    if (name === serverName) {
      devMcpPath = path;
      break;
    }
  }

  // Close existing connection
  const conn = connections.get(serverName);
  if (conn) {
    await conn.client.close().catch(() => {});
    await conn.transport.close().catch(() => {});
    if (conn.spawnedProcess && !conn.spawnedProcess.killed) {
      killProcessTree(conn.spawnedProcess);
    }
    portManager.release({ serverName });
    connections.delete(serverName);
    connectionPromises.delete(serverName);
  }

  // Determine the name to connect with (may have changed for dev MCPs)
  let newName = serverName;
  if (devMcpPath) {
    const mcpDef = getPublishablePackageInfo(devMcpPath);
    if (mcpDef && mcpDef.name !== serverName) {
      console.log(`[MCP] Dev MCP name changed: ${serverName} -> ${mcpDef.name}`);
      newName = mcpDef.name;
      devMcpPathToName.set(devMcpPath, newName);

      // Notify sidebar to remove old entry
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("mcp:disabled", { name: serverName });
      }
    }
  }

  // Create new connection with fresh resources
  await getConnection(newName);

  // Notify renderer so sidebar refreshes resource list
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("mcp:restarted", { name: newName });
  }

  console.log(`[MCP] Reconnected to ${newName}`);
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
