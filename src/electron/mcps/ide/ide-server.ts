#!/usr/bin/env node
/**
 * MCP IDE Server
 *
 * File editing tools for the AI agent with Monaco editor UI.
 * Uses HTTP streamable transport with WebSocket for real-time file notifications.
 *
 * Key features:
 * - File read/write/edit operations
 * - Directory listing and search (via ripgrep)
 * - File watching for external changes (via chokidar)
 * - WebSocket for real-time file change notifications to UI
 * - Multi-root workspace support (multiple project folders)
 */

import { createApp } from "open-mcp-app/server";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import chokidar from "chokidar";
import { ICON_SVG, ICON_ALT } from "./icon.js";
import * as ripgrep from "@vscode/ripgrep";

const execFileAsync = promisify(execFile);
const rgPath = ripgrep.rgPath;

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.MCP_PORT || process.env.PORT || "3010", 10);
const IDE_UI_RESOURCE_URI = "ui://ide/editor";

/**
 * Workspace root from MCP_WORKING_DIRS environment variable.
 */
interface WorkspaceRoot {
  id: string;
  path: string;
  label: string;
  isMcpApp: boolean;
  source: "workspace" | "discovered";
}

/**
 * Parse workspace roots from environment.
 * Supports MCP_WORKING_DIRS (JSON array) or falls back to MCP_WORKING_DIR (single path).
 */
const parseWorkspaceRoots = (): WorkspaceRoot[] => {
  // Try multi-root first
  if (process.env.MCP_WORKING_DIRS) {
    try {
      const roots = JSON.parse(process.env.MCP_WORKING_DIRS) as WorkspaceRoot[];
      if (Array.isArray(roots) && roots.length > 0) {
        console.log(`[IDE] Parsed ${roots.length} workspace roots from MCP_WORKING_DIRS`);
        return roots;
      }
    } catch (e) {
      console.error("[IDE] Failed to parse MCP_WORKING_DIRS:", e);
    }
  }

  // Fall back to single root
  const singlePath = process.env.MCP_WORKING_DIR || process.cwd();
  const shortId = Buffer.from(singlePath).toString("base64").slice(0, 8);
  return [{
    id: shortId,
    path: singlePath,
    label: path.basename(singlePath) || "Root",
    isMcpApp: false,
    source: "workspace",
  }];
};

const WORKSPACE_ROOTS = parseWorkspaceRoots();
const IS_MULTI_ROOT = WORKSPACE_ROOTS.length > 1;

// For backward compatibility, expose the primary root
const PRIMARY_ROOT = WORKSPACE_ROOTS.find(r => r.source === "workspace") || WORKSPACE_ROOTS[0];
const BASE_FOLDER = PRIMARY_ROOT?.path || process.cwd();

/**
 * Find a workspace root by ID.
 */
const findRootById = (rootId: string): WorkspaceRoot | null => {
  return WORKSPACE_ROOTS.find(r => r.id === rootId) || null;
};

/**
 * Parse a virtual path into root ID and relative path.
 * Virtual path format: "rootId/relative/path" or just "relative/path" for single-root.
 */
const parseVirtualPath = (virtualPath: string): { root: WorkspaceRoot; relativePath: string } | null => {
  // For single-root mode or paths starting with ., use primary root
  if (!IS_MULTI_ROOT || virtualPath === "." || virtualPath.startsWith("./")) {
    return { root: PRIMARY_ROOT, relativePath: virtualPath };
  }

  // Try to extract root ID from first segment
  const firstSlash = virtualPath.indexOf("/");
  if (firstSlash === -1) {
    // No slash - could be a root ID or a file/dir at primary root
    const maybeRoot = findRootById(virtualPath);
    if (maybeRoot) {
      return { root: maybeRoot, relativePath: "." };
    }
    // Not a root ID, assume primary root
    return { root: PRIMARY_ROOT, relativePath: virtualPath };
  }

  const maybeRootId = virtualPath.slice(0, firstSlash);
  const maybeRoot = findRootById(maybeRootId);
  if (maybeRoot) {
    const relativePath = virtualPath.slice(firstSlash + 1) || ".";
    return { root: maybeRoot, relativePath };
  }

  // Not a valid root ID, assume it's a relative path under primary root
  return { root: PRIMARY_ROOT, relativePath: virtualPath };
};

/**
 * Create a virtual path from root and relative path.
 */
const toVirtualPath = (root: WorkspaceRoot, relativePath: string): string => {
  if (!IS_MULTI_ROOT) {
    return relativePath;
  }
  if (relativePath === "." || relativePath === "") {
    return root.id;
  }
  return `${root.id}/${relativePath}`;
};

// =============================================================================
// File Exclusion Rules
// =============================================================================

/** Extensions that are excluded from AI context (binary/asset files) */
const AI_EXCLUDED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".bmp", ".tiff",
  ".svg", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".map",
]);

/** Filenames that are excluded from AI context (generated lock files) */
const AI_EXCLUDED_FILENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "composer.lock", "Gemfile.lock", "poetry.lock",
]);

/** Maximum file size for AI context (100KB) */
const AI_MAX_FILE_SIZE = 100 * 1024;

/** Maximum number of paths included in ide_dir_list text output */
const DIR_LIST_TEXT_MAX_ITEMS = 200;

/**
 * Check if a file should be excluded from AI context.
 * @returns Reason string if excluded, null if allowed.
 */
const getExclusionReason = (filePath: string): string | null => {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);
  if (AI_EXCLUDED_EXTENSIONS.has(ext)) return `binary/asset file (${ext})`;
  if (AI_EXCLUDED_FILENAMES.has(basename)) return `generated lock file`;
  return null;
};

// =============================================================================
// Utilities
// =============================================================================

/**
 * Validate and resolve a virtual path, ensuring it's within one of the workspace roots.
 * Returns both the resolved absolute path and the parsed root info.
 */
const validatePath = (virtualPath: string): string => {
  const parsed = parseVirtualPath(virtualPath);
  if (!parsed) {
    throw new Error(`Invalid path: ${virtualPath}`);
  }
  
  const { root, relativePath } = parsed;
  const resolved = path.resolve(root.path, relativePath);
  const normalizedBase = path.resolve(root.path);
  
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error(`Access denied: path must be within workspace root ${root.label}`);
  }
  
  return resolved;
};

/**
 * Extended validatePath that also returns the root and relative path.
 */
const validatePathWithRoot = (virtualPath: string): { resolved: string; root: WorkspaceRoot; relativePath: string } => {
  const parsed = parseVirtualPath(virtualPath);
  if (!parsed) {
    throw new Error(`Invalid path: ${virtualPath}`);
  }
  
  const { root, relativePath } = parsed;
  const resolved = path.resolve(root.path, relativePath);
  const normalizedBase = path.resolve(root.path);
  
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error(`Access denied: path must be within workspace root ${root.label}`);
  }
  
  return { resolved, root, relativePath };
};

/**
 * Get Monaco language ID from file extension.
 */
const getLanguage = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  const langMap: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".json": "json", ".md": "markdown", ".css": "css", ".scss": "scss", ".html": "html",
    ".py": "python", ".rs": "rust", ".go": "go", ".java": "java",
    ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
    ".yaml": "yaml", ".yml": "yaml", ".xml": "xml",
    ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".sql": "sql",
  };
  return langMap[ext] || "plaintext";
};

// =============================================================================
// SDK App Setup
// =============================================================================

const app = createApp({
  name: "ide",
  version: "0.0.3",
  port: PORT,
});

// =============================================================================
// Instance State & WebSocket
// =============================================================================

/** File notification types sent via WebSocket */
type FileNotification =
  | { type: "file-changed"; path: string }
  | { type: "file-added"; path: string }
  | { type: "file-deleted"; path: string }
  | { type: "file-updated"; path: string; content: string; originalContent: string | null; isNew: boolean; source: "agent" | "ui" };

/** 
 * Send function reference for the singleton IDE WebSocket.
 * Set by the first tool call, used by file watcher to notify UI.
 */
let sendToUI: ((msg: FileNotification) => void) | null = null;

/**
 * Send file notification to connected UI.
 */
const notifyUI = (notification: FileNotification) => {
  if (sendToUI) {
    console.info(`[IDE] Sending notification: ${notification.type} ${(notification as { path: string }).path}`);
    sendToUI(notification);
  }
};

/** Track recently edited files to avoid notifying our own changes */
const recentlyEditedFiles = new Map<string, number>();
const EDIT_DEBOUNCE_MS = 1000;

// =============================================================================
// File Watcher (chokidar)
// =============================================================================

let watcher: chokidar.FSWatcher | null = null;

/**
 * Convert an absolute file path to a virtual path by finding its root.
 */
const absoluteToVirtualPath = (absolutePath: string): string | null => {
  for (const root of WORKSPACE_ROOTS) {
    const normalizedRoot = path.resolve(root.path);
    if (absolutePath.startsWith(normalizedRoot + path.sep) || absolutePath === normalizedRoot) {
      const relativePath = path.relative(root.path, absolutePath);
      return toVirtualPath(root, relativePath || ".");
    }
  }
  return null;
};

/**
 * Start watching all workspace roots for external file changes.
 */
const startFileWatcher = () => {
  if (watcher) return;

  // Watch all root paths
  const watchPaths = WORKSPACE_ROOTS.map(r => r.path);
  
  watcher = chokidar.watch(watchPaths, {
    ignored: [/(^|[\/\\])\./, "**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**"],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  watcher.on("change", (filePath) => {
    const virtualPath = absoluteToVirtualPath(filePath);
    if (!virtualPath) return;
    
    const lastEdit = recentlyEditedFiles.get(virtualPath);
    if (lastEdit && Date.now() - lastEdit < EDIT_DEBOUNCE_MS) return;
    console.info(`[IDE] External file change: ${virtualPath}`);
    notifyUI({ type: "file-changed", path: virtualPath });
  });

  watcher.on("add", (filePath) => {
    const virtualPath = absoluteToVirtualPath(filePath);
    if (!virtualPath) return;
    console.info(`[IDE] File added: ${virtualPath}`);
    notifyUI({ type: "file-added", path: virtualPath });
  });

  watcher.on("unlink", (filePath) => {
    const virtualPath = absoluteToVirtualPath(filePath);
    if (!virtualPath) return;
    console.info(`[IDE] File deleted: ${virtualPath}`);
    notifyUI({ type: "file-deleted", path: virtualPath });
  });

  const rootLabels = WORKSPACE_ROOTS.map(r => r.label).join(", ");
  console.info(`[IDE] File watcher started for ${WORKSPACE_ROOTS.length} root(s): ${rootLabels}`);
};

type DirListItem = {
  path: string;
  type: "file" | "directory";
  children?: DirListItem[];
};

const countDirItems = (items: DirListItem[]): number => {
  let count = 0;
  for (const item of items) {
    count += 1;
    if (item.children && item.children.length > 0) {
      count += countDirItems(item.children);
    }
  }
  return count;
};

const collectDirPaths = (items: DirListItem[], limit: number): string[] => {
  const paths: string[] = [];
  const walk = (nodes: DirListItem[]) => {
    for (const item of nodes) {
      if (paths.length >= limit) return;
      const suffix = item.type === "directory" ? "/" : "";
      paths.push(`${item.path}${suffix}`);
      if (item.children && item.children.length > 0) {
        walk(item.children);
        if (paths.length >= limit) return;
      }
    }
  };
  walk(items);
  return paths;
};

const buildDirListText = (
  items: DirListItem[],
  pathLabel: string,
  recursive: boolean
): string => {
  const safePathLabel = pathLabel === "" ? "." : pathLabel;
  const total = countDirItems(items);
  const listedPaths = total > 0 ? collectDirPaths(items, DIR_LIST_TEXT_MAX_ITEMS) : [];
  const truncated = total > listedPaths.length;
  const lines: string[] = [
    `Listed ${total} items under "${safePathLabel}" (recursive: ${recursive ? "true" : "false"}).`,
  ];

  if (total > 0) {
    if (truncated) {
      lines.push(`Showing first ${listedPaths.length} paths; ${total - listedPaths.length} more not shown.`);
    }
    lines.push(...listedPaths);
  }

  if (truncated) {
    lines.push("Tip: use ide_search to find files or grep content:");
    lines.push(`- list files: ide_search { listFiles: true, path: "${safePathLabel}", fileGlob: "**/*.ts", maxResults: 200 }`);
    lines.push(`- grep text: ide_search { pattern: "FooBar", path: "${safePathLabel}" }`);
  }

  return lines.join("\n");
};

// =============================================================================
// UI Resource
// =============================================================================

app.resource({
  name: "Code Editor",
  uri: IDE_UI_RESOURCE_URI,
  description: "Monaco-based code editor with file browser",
  displayModes: ["pip"],
  html: "ide/ui/index.html",
  icon: { svg: ICON_SVG, alt: ICON_ALT },
  csp: {
    connectDomains: [`ws://localhost:${PORT}`],
    resourceDomains: ["https://cdn.jsdelivr.net"],
  },
  experimental: {
    websocket: true,
  },
});

// =============================================================================
// Tools
// =============================================================================

/**
 * Open the IDE panel, optionally with a specific file.
 */
app.tool(
  "ide_open",
  {
    description: "Open the IDE panel. Optionally open a specific file.",
    input: z.object({
      path: z.string().optional().describe("File path to open (relative to project root, or rootId/path for multi-root)"),
    }),
    ui: IDE_UI_RESOURCE_URI,
    visibility: ["model", "app"],
    displayModes: ["pip"],
    experimental: {
      defaultDisplayMode: "pip",
      openInBackground: true,
    },
  },
  async ({ path: filePath }, context) => {
    console.info(`[IDE] Opening IDE${filePath ? ` with file: ${filePath}` : ""}`);

    // Store send function for file watcher to use (singleton - only needs to be set once)
    if (!sendToUI) {
      sendToUI = context.send;
      console.info(`[IDE] WebSocket ready for instance ${context.instanceId}`);
    }

    // Read file content if a path was provided
    let fileContent: string | null = null;
    let language = "plaintext";

    if (filePath) {
      try {
        const resolvedPath = validatePath(filePath);
        fileContent = fs.readFileSync(resolvedPath, "utf-8");
        language = getLanguage(filePath);
      } catch {
        // File doesn't exist - that's okay
      }
    }

    // Return workspace roots info for multi-root UI
    const roots = WORKSPACE_ROOTS.map(r => ({
      id: r.id,
      label: r.label,
      isMcpApp: r.isMcpApp,
      source: r.source,
    }));

    return {
      data: {
        basePath: BASE_FOLDER,
        roots,
        isMultiRoot: IS_MULTI_ROOT,
        openFile: filePath ? { path: filePath, content: fileContent, language } : null,
      },
      text: filePath ? `IDE opened with file: ${filePath}` : "IDE opened",
      title: IS_MULTI_ROOT ? "IDE" : (path.basename(BASE_FOLDER) || "IDE"),
    };
  }
);

/**
 * Read a file's contents.
 */
app.tool(
  "ide_file_read",
  {
    description: "Read a file's contents. Binary/asset files and lock files are excluded. Large files (>100KB) require startLine/endLine.",
    input: z.object({
      path: z.string().describe("File path (use rootId/path for multi-root, or path for primary root)"),
      startLine: z.number().optional().describe("Start line (1-indexed)"),
      endLine: z.number().optional().describe("End line (1-indexed, max 200 lines from start)"),
      _source: z.enum(["agent", "ui"]).optional().describe("Internal: source of tool call"),
    }),
    ui: IDE_UI_RESOURCE_URI,
    visibility: ["model", "app"],
    experimental: {
      openInBackground: true,
    },
  },
  async ({ path: filePath, startLine, endLine, _source }) => {
    console.info(`[IDE] Reading file: ${filePath}`);

    try {
      const { resolved: resolvedPath, root, relativePath } = validatePathWithRoot(filePath);
      const virtualPath = toVirtualPath(root, relativePath);
      const exclusionReason = getExclusionReason(path.basename(filePath));

      if (exclusionReason) {
        const stats = fs.statSync(resolvedPath);
        return {
          data: { success: true, excluded: true, reason: exclusionReason, path: virtualPath, size: stats.size },
          text: `[Excluded] ${virtualPath} is a ${exclusionReason}. These files are excluded from AI context.`,
          title: path.basename(filePath),
        };
      }

      const stats = fs.statSync(resolvedPath);
      if (stats.size > AI_MAX_FILE_SIZE && !startLine && !endLine) {
        return {
          data: { success: true, excluded: true, reason: "file_too_large", path: virtualPath, size: stats.size },
          text: `[Large File] ${virtualPath} is ${(stats.size / 1024).toFixed(1)}KB. Use startLine/endLine or ide_search.`,
          title: path.basename(filePath),
        };
      }

      const content = fs.readFileSync(resolvedPath, "utf-8");
      const lines = content.split("\n");
      const totalLines = lines.length;

      const start = startLine ? Math.max(1, startLine) : 1;
      // UI gets full file, AI is limited to 200 lines to save tokens
      const maxEnd = _source === "ui" ? totalLines : start + 199;
      const end = Math.min(totalLines, endLine || totalLines, maxEnd);

      const selectedLines = lines.slice(start - 1, end);
      const numberedContent = selectedLines.map((line, i) => `${start + i}: ${line}`).join("\n");

      return {
        data: { success: true, path: virtualPath, content: selectedLines.join("\n"), language: getLanguage(filePath), totalLines, linesReturned: { start, end } },
        text: numberedContent,
        title: path.basename(filePath),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      return { data: { success: false, error: errorMsg }, text: `Error: ${errorMsg}`, isError: true, title: "Error" };
    }
  }
);

/**
 * Create or overwrite a file.
 */
app.tool(
  "ide_file_write",
  {
    description: "Create a new file or completely overwrite an existing file. For partial edits, use ide_file_edit.",
    input: z.object({
      path: z.string().describe("File path (use rootId/path for multi-root, or path for primary root)"),
      content: z.string().describe("Content to write"),
      _source: z.enum(["agent", "ui"]).optional().describe("Internal: source of tool call"),
    }),
    ui: IDE_UI_RESOURCE_URI,
    visibility: ["model", "app"],
    experimental: {
      openInBackground: true,
    },
  },
  async ({ path: filePath, content, _source }) => {
    console.info(`[IDE] Writing file: ${filePath}`);

    try {
      const { resolved: resolvedPath, root, relativePath } = validatePathWithRoot(filePath);
      const virtualPath = toVirtualPath(root, relativePath);
      recentlyEditedFiles.set(virtualPath, Date.now());

      let originalContent: string | null = null;
      try {
        originalContent = fs.readFileSync(resolvedPath, "utf-8");
      } catch {
        // File doesn't exist yet
      }

      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      fs.writeFileSync(resolvedPath, content, "utf-8");

      const isNew = originalContent === null;
      notifyUI({ type: "file-updated", path: virtualPath, content, originalContent, isNew, source: _source || "agent" });

      return {
        data: { success: true, path: virtualPath, isNew },
        text: isNew ? `Created: ${virtualPath}` : `Updated: ${virtualPath}`,
        title: path.basename(filePath),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      return { data: { success: false, error: errorMsg }, text: `Error: ${errorMsg}`, isError: true, title: "Error" };
    }
  }
);

/**
 * Make a targeted edit by replacing specific text.
 */
app.tool(
  "ide_file_edit",
  {
    description: "Make a targeted edit by replacing specific text. The oldText must match EXACTLY including whitespace.",
    input: z.object({
      path: z.string().describe("File path (use rootId/path for multi-root, or path for primary root)"),
      oldText: z.string().describe("Exact text to find and replace"),
      newText: z.string().describe("Text to replace with"),
      replaceAll: z.boolean().optional().default(false).describe("Replace all occurrences"),
      _source: z.enum(["agent", "ui"]).optional().describe("Internal: source of tool call"),
    }),
    ui: IDE_UI_RESOURCE_URI,
    visibility: ["model", "app"],
    experimental: {
      openInBackground: true,
    },
  },
  async ({ path: filePath, oldText, newText, replaceAll, _source }) => {
    console.info(`[IDE] Editing file: ${filePath}`);

    try {
      const { resolved: resolvedPath, root, relativePath } = validatePathWithRoot(filePath);
      const virtualPath = toVirtualPath(root, relativePath);
      const originalContent = fs.readFileSync(resolvedPath, "utf-8");

      if (!originalContent.includes(oldText)) {
        return { data: { success: false, error: "oldText not found" }, text: "Error: oldText not found in file", isError: true, title: "Error" };
      }

      const occurrences = originalContent.split(oldText).length - 1;
      if (!replaceAll && occurrences > 1) {
        return {
          data: { success: false, error: `Multiple occurrences (${occurrences})` },
          text: `Error: oldText found ${occurrences} times. Make it more specific or use replaceAll.`,
          isError: true,
          title: "Error",
        };
      }

      recentlyEditedFiles.set(virtualPath, Date.now());
      const newContent = replaceAll ? originalContent.split(oldText).join(newText) : originalContent.replace(oldText, newText);
      fs.writeFileSync(resolvedPath, newContent, "utf-8");

      notifyUI({ type: "file-updated", path: virtualPath, content: newContent, originalContent, isNew: false, source: _source || "agent" });

      const replacements = replaceAll ? occurrences : 1;
      return {
        data: { success: true, path: virtualPath, replacements },
        text: `Replaced ${replacements} occurrence(s) in ${virtualPath}`,
        title: path.basename(filePath),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      return { data: { success: false, error: errorMsg }, text: `Error: ${errorMsg}`, isError: true, title: "Error" };
    }
  }
);

/**
 * List files and directories.
 */
app.tool(
  "ide_dir_list",
  {
    description: "List files and directories. Excludes hidden files and node_modules.",
    input: z.object({
      path: z.string().default(".").describe("Directory path (use rootId/path for multi-root, or just path for primary root)"),
      recursive: z.boolean().optional().default(false).describe("List recursively (max 3 levels)"),
    }),
    ui: IDE_UI_RESOURCE_URI,
    visibility: ["model", "app"],
    experimental: {
      openInBackground: true,
    },
  },
  async ({ path: dirPath, recursive }) => {
    console.info(`[IDE] Listing directory: ${dirPath}`);

    try {
      interface DirItem {
        name: string;
        type: "file" | "directory";
        path: string;
        excluded?: boolean;
        excludeReason?: string;
        children?: DirItem[];
        /** For root items in multi-root mode */
        isRoot?: boolean;
        rootId?: string;
        isMcpApp?: boolean;
      }

      const listDir = (dir: string, depth: number, parentVirtualPath: string, root: WorkspaceRoot): DirItem[] => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const items: DirItem[] = [];

        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

          const itemVirtualPath = parentVirtualPath ? `${parentVirtualPath}/${entry.name}` : toVirtualPath(root, entry.name);
          const item: DirItem = { name: entry.name, type: entry.isDirectory() ? "directory" : "file", path: itemVirtualPath };

          if (!entry.isDirectory()) {
            const exclusionReason = getExclusionReason(entry.name);
            if (exclusionReason) {
              item.excluded = true;
              item.excludeReason = exclusionReason;
            }
          }

          if (recursive && entry.isDirectory() && depth < 3) {
            item.children = listDir(path.join(dir, entry.name), depth + 1, itemVirtualPath, root);
          }

          items.push(item);
        }

        return items.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      };

      // Special case: listing "." in multi-root mode shows all roots
      if ((dirPath === "." || dirPath === "") && IS_MULTI_ROOT) {
        const rootItems: DirItem[] = WORKSPACE_ROOTS.map(root => {
          const item: DirItem = {
            name: root.label,
            type: "directory",
            path: root.id,
            isRoot: true,
            rootId: root.id,
            isMcpApp: root.isMcpApp,
          };

          if (recursive) {
            try {
              item.children = listDir(root.path, 1, root.id, root);
            } catch {
              item.children = [];
            }
          }

          return item;
        });

        return {
          data: { success: true, path: ".", items: rootItems, isMultiRoot: true },
          text: buildDirListText(rootItems, ".", recursive),
          title: "Workspace",
        };
      }

      // Normal directory listing (single root or specific path)
      const { resolved, root, relativePath } = validatePathWithRoot(dirPath);
      const virtualBasePath = dirPath === "." ? "" : toVirtualPath(root, relativePath);
      const items = listDir(resolved, 0, virtualBasePath, root);

      return {
        data: { success: true, path: dirPath, items, rootId: root.id, rootLabel: root.label },
        text: buildDirListText(items, dirPath, recursive),
        title: dirPath === "." ? (root.label || "Root") : path.basename(relativePath),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      return { data: { success: false, error: errorMsg }, text: `Error: ${errorMsg}`, isError: true, title: "Error" };
    }
  }
);

/**
 * Search for text patterns or find files using ripgrep.
 */
app.tool(
  "ide_search",
  {
    description: "Search for text patterns or find files using ripgrep.",
    input: z.object({
      pattern: z.string().optional().describe("Search pattern (regex). Required unless listFiles is true."),
      path: z.string().optional().describe("Directory to search in (use rootId/path for multi-root)"),
      fileGlob: z.string().optional().describe("File pattern filter, e.g. '*.ts'"),
      caseSensitive: z.boolean().optional().default(false).describe("Case sensitive search"),
      listFiles: z.boolean().optional().default(false).describe("Just list matching files"),
      maxResults: z.number().optional().default(25).describe("Maximum results"),
    }),
    ui: IDE_UI_RESOURCE_URI,
    visibility: ["model", "app"],
    experimental: {
      openInBackground: true,
    },
  },
  async ({ pattern, path: searchPath, fileGlob, caseSensitive, listFiles, maxResults }) => {
    console.info(`[IDE] Searching: ${pattern || "(list files)"}`);

    try {
      // Determine search targets - either specific path or all roots
      let searchTargets: Array<{ root: WorkspaceRoot; absolutePath: string }>;
      
      if (searchPath) {
        const { resolved, root } = validatePathWithRoot(searchPath);
        searchTargets = [{ root, absolutePath: resolved }];
      } else {
        // Search all roots
        searchTargets = WORKSPACE_ROOTS.map(root => ({ root, absolutePath: root.path }));
      }

      const args: string[] = [];

      // Default excludes
      args.push("-g", "!node_modules", "-g", "!dist", "-g", "!build", "-g", "!out", "-g", "!.git");
      args.push("-g", "!coverage", "-g", "!*.min.js", "-g", "!*.min.css", "-g", "!*.map");
      args.push("-g", "!package-lock.json", "-g", "!yarn.lock", "-g", "!pnpm-lock.yaml");
      args.push("--max-filesize", "500K", "--max-depth", "10");

      if (listFiles) {
        args.push("--files");
        if (fileGlob) args.push("-g", fileGlob);
        
        // Search each target and combine results
        const allFiles: string[] = [];
        for (const { root, absolutePath } of searchTargets) {
          try {
            const targetArgs = [...args, absolutePath];
            const { stdout } = await execFileAsync(rgPath, targetArgs, { maxBuffer: 10 * 1024 * 1024 });
            const files = stdout.split("\n").filter(Boolean).map((f) => {
              const relativePath = path.relative(root.path, f);
              return toVirtualPath(root, relativePath);
            });
            allFiles.push(...files);
          } catch (error) {
            const execError = error as { code?: number };
            if (execError.code !== 1) throw error; // Ignore "no matches"
          }
        }

        const limitedFiles = allFiles.slice(0, maxResults);
        return {
          data: { success: true, files: limitedFiles, totalFiles: limitedFiles.length },
          text: limitedFiles.length > 0 ? limitedFiles.join("\n") : "No files found",
          title: "File List",
        };
      }

      if (!pattern) {
        return { data: { success: false, error: "pattern required" }, text: "Error: pattern required", isError: true, title: "Error" };
      }

      const searchArgs = [...args, "--json", "--max-count", "3", "-m", String(maxResults)];
      if (!caseSensitive) searchArgs.push("-i");
      if (fileGlob) searchArgs.push("-g", fileGlob);

      // Search each target and combine results
      const allResults: Array<{ file: string; line: number; text: string }> = [];
      for (const { root, absolutePath } of searchTargets) {
        try {
          const targetArgs = [...searchArgs, pattern, absolutePath];
          const { stdout } = await execFileAsync(rgPath, targetArgs, { maxBuffer: 10 * 1024 * 1024 });

          for (const line of stdout.split("\n").filter(Boolean)) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === "match") {
                const relativePath = path.relative(root.path, obj.data.path.text);
                const virtualPath = toVirtualPath(root, relativePath);
                allResults.push({
                  file: virtualPath,
                  line: obj.data.line_number,
                  text: obj.data.lines.text.trim().substring(0, 200),
                });
              }
            } catch {
              // Skip malformed lines
            }
          }
        } catch (error) {
          const execError = error as { code?: number };
          if (execError.code !== 1) throw error; // Ignore "no matches"
        }
      }

      const limitedResults = allResults.slice(0, maxResults);
      return {
        data: { success: true, matches: limitedResults, totalMatches: limitedResults.length },
        text: limitedResults.length > 0 ? limitedResults.map(r => `${r.file}:${r.line}: ${r.text}`).join("\n") : "No matches found",
        title: `Search: ${pattern}`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      return { data: { success: false, error: errorMsg }, text: `Error: ${errorMsg}`, isError: true, title: "Error" };
    }
  }
);

/**
 * Report that a file was changed outside the application.
 */
app.tool(
  "ide_external_change",
  {
    description: "Report that a file was changed outside the application.",
    input: z.object({
      path: z.string().describe("File path that was changed"),
      type: z.enum(["created", "modified", "deleted"]).describe("Type of change"),
    }),
    ui: IDE_UI_RESOURCE_URI,
    visibility: ["app"], // Only the UI calls this
  },
  async ({ path: filePath, type }) => {
    console.info(`[IDE] External change reported: ${type} ${filePath}`);

    const messages: Record<string, string> = {
      created: `File created: ${filePath}`,
      modified: `File modified: ${filePath}`,
      deleted: `File deleted: ${filePath}`,
    };

    return {
      data: { external: true, path: filePath, changeType: type },
      text: messages[type] || `External change: ${filePath}`,
      title: path.basename(filePath),
    };
  }
);

// =============================================================================
// Server Lifecycle
// =============================================================================

const main = async () => {
  console.log("[IDE] Starting MCP server");
  startFileWatcher();
  await app.start();
  console.log(`[IDE] MCP server ready on port ${PORT}`);
};

const handleShutdown = (signal: string) => {
  console.log(`[IDE] Received ${signal}, shutting down...`);
  if (watcher) watcher.close();
  process.exit(0);
};

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

main().catch((error) => {
  console.error("[IDE] Failed to start server:", error);
  process.exit(1);
});
