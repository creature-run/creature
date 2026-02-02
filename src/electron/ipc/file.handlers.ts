/**
 * File IPC Handlers
 *
 * Handles file and folder selection IPC events.
 */

import { dialog, ipcMain } from "electron";
import path from "node:path";
import { getMainWindow } from "../window/mainWindow";

/**
 * Register file-related IPC handlers.
 */
export const registerFileHandlers = () => {
  // Folder selection dialog
  ipcMain.handle("dialog:selectFolder", async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Select Working Directory",
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  // File selection dialog (restricted to a folder)
  ipcMain.handle("dialog:selectFiles", async (_, baseFolderPath: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      defaultPath: baseFolderPath,
      title: "Select Files to Attach",
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    // Validate all paths are within the base folder and compute relative paths
    const normalizedBase = path.resolve(baseFolderPath);
    const relativePaths: string[] = [];

    for (const filePath of result.filePaths) {
      const resolvedPath = path.resolve(filePath);
      if (
        resolvedPath.startsWith(normalizedBase + path.sep) ||
        resolvedPath === normalizedBase
      ) {
        relativePaths.push(path.relative(normalizedBase, resolvedPath));
      }
    }

    if (relativePaths.length === 0) {
      return { paths: [], error: "Selected files must be within the project folder" };
    }

    return { paths: relativePaths };
  });

  // Resolve file path relative to project folder (for drag-drop)
  ipcMain.handle("file:resolvePath", async (_, absolutePath: string, baseFolderPath: string) => {
    const normalizedBase = path.resolve(baseFolderPath);
    const resolvedPath = path.resolve(absolutePath);

    if (
      resolvedPath.startsWith(normalizedBase + path.sep) ||
      resolvedPath === normalizedBase
    ) {
      return { relativePath: path.relative(normalizedBase, resolvedPath) };
    }

    return { relativePath: null, error: "File must be within the project folder" };
  });

  // Search files and folders in project folder (for @-mention autocomplete)
  ipcMain.handle("file:search", async (_, query: string, baseFolderPath: string) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const results: Array<{ path: string; type: "file" | "folder" }> = [];

    // Search for files using ripgrep
    try {
      const args = ["--files", "--iglob", `*${query}*`, baseFolderPath];
      const { stdout } = await execFileAsync("rg", args, { maxBuffer: 1024 * 1024 });

      const files = stdout
        .split("\n")
        .filter(Boolean)
        .slice(0, 15)
        .map((f) => ({ path: path.relative(baseFolderPath, f), type: "file" as const }));

      results.push(...files);
    } catch (error) {
      const execError = error as { code?: number };
      if (execError.code !== 1) {
        console.error("File search error:", error);
      }
    }

    // Search for folders using find command
    try {
      const args = [
        baseFolderPath,
        "-type",
        "d",
        "-iname",
        `*${query}*`,
        "-not",
        "-path",
        "*/node_modules/*",
        "-not",
        "-path",
        "*/.git/*",
        "-not",
        "-path",
        "*/dist/*",
        "-not",
        "-path",
        "*/.next/*",
        "-not",
        "-path",
        "*/__pycache__/*",
      ];
      const { stdout } = await execFileAsync("find", args, { maxBuffer: 1024 * 1024 });

      const folders = stdout
        .split("\n")
        .filter(Boolean)
        .filter((f) => f !== baseFolderPath) // Exclude the base folder itself
        .slice(0, 10)
        .map((f) => ({ path: path.relative(baseFolderPath, f), type: "folder" as const }));

      results.push(...folders);
    } catch (error) {
      console.error("Folder search error:", error);
    }

    // Sort: folders first, then files, alphabetically within each group
    results.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    return { results: results.slice(0, 20) };
  });
};

